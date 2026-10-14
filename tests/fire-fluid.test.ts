import { describe, expect, it } from 'vitest';
import {
  createFireFluid,
  FIRE_FLUID_LIMITS,
  type FireFluid,
  type FireFluidParams,
} from '../src/gpu/sim/fire-fluid.ts';
import { floatToHalf, halfToFloat } from '../src/gpu/sim/fluid.ts';
import { createPointerIgnition } from '../src/gpu/sim/ignition.ts';
import { createBenchDevice } from './bench.ts';
import { findTransitions, maxFlashesPerWindow, sampleCells, type CellSample } from './flash.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { fakeCanvas, mountHeadless, sendPointer } from './headless.ts';

// The combustion layer of stories 6.2 to 6.7 (src/gpu/sim/fire-fluid.ts) on a small grid: 32 velocity
// cells, a 128-texel dye, tens of steps.

type Rgba = [number, number, number, number];

/** Everything that moves or changes the dye switched off: only what a test turns on happens. */
const STILL: Partial<FireFluidParams> = {
  buoyancy: 0,
  expansion: 0,
  turbulence: 0,
  vorticity: 0,
  cooling: 0,
  radiation: 0,
  sootFade: 0,
  fuelFade: 0,
  bedTemperature: 0,
  floor: false,
};

function make(device: GPUDevice, params: Partial<FireFluidParams> = {}): FireFluid {
  return createFireFluid({
    device,
    resolution: 32,
    dyeResolution: 128,
    width: 1,
    height: 1,
    params: { ...STILL, ...params },
  });
}

async function run(device: GPUDevice, fire: FireFluid, steps: number) {
  const encoder = device.createCommandEncoder();
  fire.advance(encoder, steps);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

interface Dye {
  width: number;
  height: number;
  data: Float32Array;
  at(x: number, y: number, c: number): number;
}

async function readDye(device: GPUDevice, fire: FireFluid): Promise<Dye> {
  const { dyeWidth: width, dyeHeight: height } = fire.grid;
  const bytes = await readTexture(device, fire.dye.texture, 8);
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, width * height * 4);
  const data = Float32Array.from(half, halfToFloat);
  return { width, height, data, at: (x, y, c) => data[(y * width + x) * 4 + c]! };
}

/** Sum of channel c over the texels whose uv satisfies `where` (all by default). */
function total(dye: Dye, c: number, where: (u: number, v: number) => boolean = () => true) {
  let sum = 0;
  for (let y = 0; y < dye.height; y++) {
    for (let x = 0; x < dye.width; x++) {
      if (where((x + 0.5) / dye.width, (y + 0.5) / dye.height)) sum += dye.at(x, y, c);
    }
  }
  return sum;
}

const disc = (cx: number, cy: number, r: number) => (u: number, v: number) =>
  Math.hypot(u - cx, v - cy) < r;

function allFinite(data: ArrayLike<number>) {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

describe('fire-fluid combustion', () => {
  it('consumes fuel only by burning it: what is lost becomes heat and soot in proportion, and stays in range', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const fire = make(device, { burnRate: 4, heat: 2, soot: 0.5 });
      // A fuel blob whose left half is hot. Velocity stays zero (nothing pushes), so advection is
      // the identity and every change in the dye is the reaction's.
      const blob = disc(0.5, 0.5, 0.25);
      fire.fluid.setDye((u, v): Rgba => (blob(u, v) ? [u < 0.5 ? 2 : 0, 0.7, 0, 0] : [0, 0, 0, 0]));
      const before = await readDye(device, fire);
      await run(device, fire, 30);
      const after = await readDye(device, fire);

      const fuelLost = total(before, 1) - total(after, 1);
      const heatGained = total(after, 0) - total(before, 0);
      const sootMade = total(after, 2);
      expect(fuelLost).toBeGreaterThan(0.2 * total(before, 1, (u) => u < 0.5));
      // Stochastic rounding is unbiased: the totals agree to a fraction of a percent.
      expect(Math.abs(heatGained - 2 * fuelLost) / (2 * fuelLost)).toBeLessThan(0.01);
      expect(Math.abs(sootMade - 0.5 * fuelLost) / (0.5 * fuelLost)).toBeLessThan(0.01);
      // The cold half has not burnt at all: not one texel changed.
      const cold = (u: number, v: number) => blob(u, v) && u > 0.55;
      expect(total(after, 1, cold)).toBe(total(before, 1, cold));
      for (let i = 0; i < after.data.length; i += 4) {
        expect(after.data[i]!).toBeGreaterThanOrEqual(0);
        expect(after.data[i]!).toBeLessThanOrEqual(FIRE_FLUID_LIMITS.temperature);
        expect(after.data[i + 1]!).toBeGreaterThanOrEqual(0);
        // Never more fuel than was laid (0.7 as a half float).
        expect(after.data[i + 1]!).toBeLessThanOrEqual(halfToFloat(floatToHalf(0.7)));
      }
      fire.destroy();
    });
  });

  it('ignites nothing at or below the ignition temperature, and burns just above it', async () => {
    const device = await getTestDevice();
    const burnt: number[] = [];
    for (const temperature of [0.5, 0.75, 0.9]) {
      const fire = make(device, { ignition: 0.75, soft: 0.2 });
      fire.fluid.setDye((): Rgba => [temperature, 1, 0, 0]);
      await run(device, fire, 20);
      const dye = await readDye(device, fire);
      burnt.push(dye.width * dye.height - total(dye, 1));
      if (temperature <= 0.75) {
        expect(total(dye, 3)).toBe(0);
        expect(total(dye, 2)).toBe(0);
      }
      fire.destroy();
    }
    expect(burnt[0]).toBe(0);
    expect(burnt[1]).toBe(0);
    expect(burnt[2]!).toBeGreaterThan(100);
  });

  it('lifts heat: a hot blob rises, and leans with the wind', async () => {
    const device = await getTestDevice();
    const centroid = async (wind: number) => {
      const fire = make(device, { buoyancy: 1.5, wind });
      fire.fluid.setDye((u, v): Rgba => [disc(0.5, 0.65, 0.1)(u, v) ? 1.5 : 0, 0, 0, 0]);
      await run(device, fire, 40);
      const dye = await readDye(device, fire);
      const t = total(dye, 0);
      const x = sumWeighted(dye, (u) => u) / t;
      const y = sumWeighted(dye, (_u, v) => v) / t;
      fire.destroy();
      return { x, y };
    };
    const sumWeighted = (dye: Dye, f: (u: number, v: number) => number) => {
      let sum = 0;
      for (let j = 0; j < dye.height; j++) {
        for (let i = 0; i < dye.width; i++) {
          sum += dye.at(i, j, 0) * f((i + 0.5) / dye.width, (j + 0.5) / dye.height);
        }
      }
      return sum;
    };
    const still = await centroid(0);
    // Up is -y: the blob started at 0.65.
    expect(still.y).toBeLessThan(0.6);
    expect(Math.abs(still.x - 0.5)).toBeLessThan(0.01);
    const windy = await centroid(0.6);
    expect(windy.x).toBeGreaterThan(0.52);
  });

  it('expands only where it burns: the divergence source is non-zero near the reaction zone and zero elsewhere', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const fire = make(device, { expansion: 1, burnRate: 6 });
      // Fuel everywhere in a band; heat only at its left end. The reaction zone is where they overlap.
      fire.fluid.setDye((u, v): Rgba => {
        const band = v > 0.4 && v < 0.6 && u > 0.15 && u < 0.85;
        return [band && u < 0.35 ? 2 : 0, band ? 1 : 0, 0, 0];
      });
      await run(device, fire, 2);
      const dye = await readDye(device, fire);
      const { width, height } = fire.grid;
      const bytes = await readTexture(device, fire.expansionSource, 4);
      const source = new Float32Array(bytes.buffer, bytes.byteOffset, width * height);
      // The cells that hold burning dye (rate above zero in any of their texels).
      const ratio = dye.width / width;
      const burning = new Uint8Array(width * height);
      for (let y = 0; y < dye.height; y++) {
        for (let x = 0; x < dye.width; x++) {
          if (dye.at(x, y, 3) > 0)
            burning[Math.floor(y / ratio) * width + Math.floor(x / ratio)] = 1;
        }
      }
      const nearBurning = (i: number, j: number) => {
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const a = i + di;
            const b = j + dj;
            if (a >= 0 && b >= 0 && a < width && b < height && burning[b * width + a]) return true;
          }
        }
        return false;
      };
      let inside = 0;
      let peak = 0;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const s = source[j * width + i]!;
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
          if (s > 0) {
            expect(nearBurning(i, j)).toBe(true);
            inside++;
          }
          peak = Math.max(peak, s);
        }
      }
      expect(inside).toBeGreaterThan(4);
      expect(peak).toBeGreaterThan(0.5);
      // The cold fuel at the right end of the band does not expand.
      const j = Math.floor(0.5 * height);
      expect(source[j * width + Math.floor(0.7 * width)]).toBe(0);
      fire.destroy();
    });
  });

  it('stays finite and inside its limits at the most extreme settings', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const fire = make(device, {
        fuelRate: 8,
        lumps: 1.5,
        bedTemperature: 2.5,
        ignition: 0.2,
        burnRate: 20,
        heat: 5,
        soot: 1.5,
        expansion: 1.5,
        buoyancy: 4,
        vorticity: 10,
        velocityDissipation: 0.1,
        turbulence: 12,
        turbulenceScale: 3,
        cooling: 0.2,
        scheme: 'bfecc',
        floor: true,
        torchFuel: 50,
      });
      fire.setSources([
        { from: [0.1, 0.9], to: [0.9, 0.9], radius: 0.05, fuel: 1 },
        { from: [0.5, 0.6], to: [0.5, 0.6], radius: 0.04, fuel: 2, jet: 3 },
      ]);
      fire.seed();
      for (let k = 0; k < 6; k++) await run(device, fire, 20);
      const dye = await readDye(device, fire);
      expect(allFinite(dye.data)).toBe(true);
      const max = [0, 0, 0, 0];
      for (let i = 0; i < dye.data.length; i++) max[i % 4] = Math.max(max[i % 4]!, dye.data[i]!);
      expect(max[0]!).toBeLessThanOrEqual(FIRE_FLUID_LIMITS.temperature);
      expect(max[1]!).toBeLessThanOrEqual(FIRE_FLUID_LIMITS.fuel);
      expect(max[2]!).toBeLessThanOrEqual(FIRE_FLUID_LIMITS.soot);
      expect(max[3]!).toBeLessThanOrEqual(FIRE_FLUID_LIMITS.rate);
      expect(max[0]!).toBeGreaterThan(1);
      const bytes = await readTexture(device, fire.fluid.velocity.texture, 8);
      const half = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
      const velocity = Float32Array.from(half, halfToFloat);
      expect(allFinite(velocity)).toBe(true);
      // The solver's speed cap: maxCfl cells a step.
      const cap = (fire.fluid.params.maxCfl / (fire.fluid.stepSeconds * fire.grid.height)) * 1.01;
      for (const v of velocity) expect(Math.abs(v)).toBeLessThanOrEqual(cap);
      fire.destroy();
    });
  });

  it('a pressed torch adds fuel and heat where it is pressed, one for each touch', async () => {
    const device = await getTestDevice();
    const canvas = fakeCanvas(200, 200);
    const fire = make(device, { torchFuel: 10, torchHeat: 2 });
    const torch = createPointerIgnition(canvas, { radius: 0.05 });
    fire.ignition.torches.push(torch);
    sendPointer(canvas, 'pointerdown', 0.3, 0.4, 0, 1);
    sendPointer(canvas, 'pointerdown', 0.7, 0.6, 0, 2);
    await run(device, fire, 10);
    const dye = await readDye(device, fire);
    for (const [x, y] of [
      [0.3, 0.4],
      [0.7, 0.6],
    ] as const) {
      expect(total(dye, 1, disc(x, y, 0.06))).toBeGreaterThan(5);
      expect(dye.at(Math.floor(x * dye.width), Math.floor(y * dye.height), 0)).toBeGreaterThan(1.5);
    }
    // Nowhere else.
    expect(
      total(dye, 1, (u, v) => !disc(0.3, 0.4, 0.07)(u, v) && !disc(0.7, 0.6, 0.07)(u, v)),
    ).toBe(0);
    sendPointer(canvas, 'pointerup', 0.3, 0.4, 100, 1);
    sendPointer(canvas, 'pointerup', 0.7, 0.6, 100, 2);
    torch.destroy();
    fire.destroy();
  });
});

// --- Tools, off by default -------------------------------------------------------------------------------

// Where the flash analyser's cells flash (tests/flash.ts), as a 24 x 14 map of flashes per second:
//   FIRE_FLUID_FLASH_MAP='{}' [FIRE_FLUID_PRESET=name] npx vitest run tests/fire-fluid.test.ts --silent=false
describe.skipIf(!process.env.FIRE_FLUID_FLASH_MAP)('flash map', { timeout: 600_000 }, () => {
  it('maps the flashing cells', async () => {
    const params = JSON.parse(process.env.FIRE_FLUID_FLASH_MAP ?? '{}') as Record<string, unknown>;
    const mounted = await mountHeadless('fire-fluid', {
      width: 480,
      height: 270,
      preset: process.env.FIRE_FLUID_PRESET || undefined,
      params,
    });
    await mounted.runTo(1);
    const frames: CellSample[][] = [];
    for (let f = 0; f < 720; f++) {
      mounted.step();
      frames.push(sampleCells(await mounted.read(), 480, 270, 24, 14));
    }
    mounted.destroy();
    const rows: string[] = [];
    for (let r = 0; r < 14; r++) {
      let line = '';
      for (let c = 0; c < 24; c++) {
        const i = r * 24 + c;
        const sat = Float32Array.from(frames, (f) => f[i]!.saturation);
        const lum = findTransitions(
          Float32Array.from(frames, (f) => f[i]!.luminance),
          0.1,
          (a, b) => Math.min(a, b) < 0.8,
        );
        const red = findTransitions(
          Float32Array.from(frames, (f) => f[i]!.red),
          20,
          (_a, _b, k) => sat[k]! >= 0.8 || sat[k - 1]! >= 0.8,
        );
        const n = Math.max(maxFlashesPerWindow(lum, 60), maxFlashesPerWindow(red, 60));
        line += n === 0 ? '.' : String(n);
      }
      rows.push(line);
    }
    console.log(rows.join('\n'));
  });
});

// The marginal cost of one frame of each preset at 1920 x 1080 on Dawn (tests/bench.ts), and the
// passes it times. Nothing else should be using the GPU:
//   FIRE_FLUID_BENCH=1 npx vitest run tests/fire-fluid.test.ts --silent=false
describe.skipIf(!process.env.FIRE_FLUID_BENCH)('cost', { timeout: 600_000 }, () => {
  it('measures every preset', async () => {
    const bench = await createBenchDevice();
    const presets = (process.env.FIRE_FLUID_PRESETS ?? '').split(',').filter(Boolean);
    const effect = (await import('../src/effects/fire-fluid/index.ts')).effect;
    for (const preset of presets.length > 0 ? presets : Object.keys(effect.presets ?? {})) {
      const mounted = await mountHeadless('fire-fluid', {
        width: 1920,
        height: 1080,
        preset,
        device: bench.device,
        profiler: bench.profiler,
      });
      await mounted.runTo(1);
      const m = await bench.measure((encoder) => mounted.encode(encoder));
      console.log(
        `${preset.padEnd(28)} slope ${m.slopeMs.toFixed(2)} ms (${m.slopeMinMs.toFixed(2)}-${m.slopeMaxMs.toFixed(2)}), span ${m.spanMs.toFixed(2)} ms, ${m.passes} timed passes`,
      );
      mounted.destroy();
    }
    bench.destroy();
  });
});
