import { describe, expect, it } from 'vitest';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import {
  createFire3d,
  fire3dFluidParams,
  FIRE3D_LIMITS,
  DEFAULT_FIRE3D_PARAMS,
  type Fire3d,
  type Fire3dParams,
} from '../src/gpu/sim/fire3d.ts';
import { expectValid, getTestDevice } from './gpu.ts';

// The 3D combustion model (src/gpu/sim/fire3d.ts). Small grids and few steps, so it runs in seconds on
// CI's software rasteriser; shapes and totals are checked, never single cells.

interface Fields {
  /** Sum of each channel over the grid: T, F, S, R. */
  total: number[];
  max: number[];
  min: number[];
  /** Temperature-weighted mean height, length units. */
  heatHeight: number;
  finite: boolean;
}

async function readFields(device: GPUDevice, fire: Fire3d): Promise<Fields> {
  const texture = fire.fields.texture;
  const { width, height, depthOrArrayLayers: depth } = texture;
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height * depth,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: depth },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const view = new DataView(buffer.getMappedRange());
  const total = [0, 0, 0, 0];
  const max = [-Infinity, -Infinity, -Infinity, -Infinity];
  const min = [Infinity, Infinity, Infinity, Infinity];
  let weighted = 0;
  let finite = true;
  for (let k = 0; k < depth; k++) {
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        for (let c = 0; c < 4; c++) {
          const v = fromHalf(view.getUint16((k * height + j) * bytesPerRow + i * 8 + c * 2, true));
          if (!Number.isFinite(v)) finite = false;
          total[c] = total[c]! + v;
          max[c] = Math.max(max[c]!, v);
          min[c] = Math.min(min[c]!, v);
          if (c === 0) weighted += v * ((j + 0.5) / height) * fire.grid.size[1];
        }
      }
    }
  }
  buffer.unmap();
  buffer.destroy();
  return { total, max, min, heatHeight: total[0]! > 0 ? weighted / total[0]! : 0, finite };
}

async function submit(device: GPUDevice, record: (encoder: GPUCommandEncoder) => void) {
  const encoder = device.createCommandEncoder();
  record(encoder);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

/** A small fire: one log-like source across the middle of the floor. */
function create(device: GPUDevice, params: Partial<Fire3dParams> = {}): Fire3d {
  const fire = createFire3d({ device, resolution: 16, scalarResolution: 16, params });
  const [w, , d] = fire.grid.size;
  fire.setSources([
    {
      from: [w * 0.3, 0.04, d / 2],
      to: [w * 0.7, 0.04, d / 2],
      radius: 0.08,
      fuel: 1,
    },
  ]);
  return fire;
}

describe('fire3d', () => {
  it('maps its parameters onto the solver: an open top, T lifts, smoke weighs, R expands', () => {
    const p = fire3dFluidParams({ ...DEFAULT_FIRE3D_PARAMS, wind: 0, smokeWeight: 0.2 });
    expect(p.openTop).toBe(true);
    expect(p.buoyancyDirection).toEqual([0, 1, 0]);
    expect(p.buoyancyWeights).toEqual([1, 0, -0.2, 0]);
    expect(p.divergenceWeights).toEqual([0, 0, 0, DEFAULT_FIRE3D_PARAMS.expansion]);
    const windy = fire3dFluidParams({ ...DEFAULT_FIRE3D_PARAMS, wind: 1 });
    expect(windy.buoyancyDirection![0]).toBeCloseTo(Math.SQRT1_2, 6);
    // Leaning keeps the vertical lift what it was.
    expect(windy.buoyancy! * windy.buoyancyDirection![1]).toBeCloseTo(
      DEFAULT_FIRE3D_PARAMS.buoyancy,
      6,
    );
  });

  it('burns: fuel from the source ignites, heats the gas, makes smoke, and the heat rises', async () => {
    const device = await getTestDevice();
    const fire = await expectValid(device, () => create(device));
    await submit(device, (encoder) => fire.advance(encoder, 30));
    const f = await readFields(device, fire);
    expect(f.finite).toBe(true);
    expect(f.max[0]).toBeGreaterThan(1); // hotter than 1300 K somewhere
    expect(f.total[2]).toBeGreaterThan(0); // smoke
    expect(f.max[3]).toBeGreaterThan(0.5); // something is burning
    // The heat has risen above the source.
    expect(f.heatHeight).toBeGreaterThan(0.12);
    fire.destroy();
  });

  it('does not light without heat: no bed, no igniter, no fire; one igniter lights it', async () => {
    const device = await getTestDevice();
    const cold = create(device, { bedTemperature: 0 });
    await submit(device, (encoder) => cold.advance(encoder, 20));
    const unlit = await readFields(device, cold);
    expect(unlit.max[0]).toBeLessThan(1e-3);
    expect(unlit.total[1]).toBeGreaterThan(0); // fuel is there, waiting
    // An ember on the source.
    const [w, , d] = cold.grid.size;
    cold.addHeat([w / 2, 0.06, d / 2], [w / 2, 0.06, d / 2], 0.08, 1.2);
    await submit(device, (encoder) => cold.advance(encoder, 20));
    const lit = await readFields(device, cold);
    expect(lit.max[0]).toBeGreaterThan(0.8);
    expect(lit.max[3]).toBeGreaterThan(0.5);
    cold.destroy();
  });

  it('stays finite and inside its bounds under absurd input', async () => {
    const device = await getTestDevice();
    const fire = create(device, {
      fuelRate: 1e6,
      heat: 1e4,
      soot: 1e4,
      burn: 1e3,
      buoyancy: 500,
      expansion: 50,
      vorticity: 100,
    });
    for (let i = 0; i < 40; i++) {
      const x = (i % 7) / 7;
      fire.addHeat([x, 0.2, 0.3], [x, 0.8, 0.3], 0.1, 1e30, 1e30);
    }
    expect(fire.addHeat([Number.NaN, 0, 0], [0, 0, 0], 0.1, 1)).toBe(false);
    await submit(device, (encoder) => fire.advance(encoder, 30));
    const f = await readFields(device, fire);
    expect(f.finite).toBe(true);
    for (let c = 0; c < 4; c++) expect(f.min[c]).toBeGreaterThanOrEqual(0);
    expect(f.max[0]).toBeLessThanOrEqual(FIRE3D_LIMITS.temperature * 1.001);
    expect(f.max[1]).toBeLessThanOrEqual(FIRE3D_LIMITS.fuel * 1.001);
    expect(f.max[2]).toBeLessThanOrEqual(FIRE3D_LIMITS.smoke * 1.001);
    expect(f.max[3]).toBeLessThanOrEqual(FIRE3D_LIMITS.rate * 1.001);
    fire.destroy();
  });

  it('cools: with the source gone, the heat dies away and the smoke thins', async () => {
    const device = await getTestDevice();
    const fire = create(device);
    await submit(device, (encoder) => fire.advance(encoder, 20));
    const burning = await readFields(device, fire);
    fire.setSources([]);
    await submit(device, (encoder) => fire.advance(encoder, 90));
    const out = await readFields(device, fire);
    // Three seconds at the default losses (0.5 / s at the floor, more higher up, plus radiation).
    expect(out.total[0]!).toBeLessThan(burning.total[0]! * 0.3);
    expect(out.max[3]).toBeLessThan(0.05);
    fire.destroy();
  });

  it('seeds a burning fire for the first frame without any GPU step', async () => {
    const device = await getTestDevice();
    const fire = create(device);
    fire.seed();
    const f = await readFields(device, fire);
    expect(f.max[0]).toBeGreaterThan(0.8);
    expect(f.total[2]).toBeGreaterThan(0);
    fire.destroy();
  });

  it('runs the same at 60 and 120 Hz', async () => {
    const device = await getTestDevice();
    const run = async (frames: number, delta: number) => {
      const fire = create(device);
      for (let i = 0; i < frames; i++)
        await submit(device, (encoder) => fire.update(encoder, delta));
      const f = await readFields(device, fire);
      fire.destroy();
      return f;
    };
    const a = await run(30, 1 / 60);
    const b = await run(60, 1 / 120);
    expect(b.total[0]!).toBeCloseTo(a.total[0]!, 0);
    expect(b.heatHeight).toBeCloseTo(a.heatHeight, 3);
  });
});

// --- The effect --------------------------------------------------------------------------------

describe('fire-3d effect', () => {
  async function render(
    params: Record<string, unknown>,
    script: (frame: number, canvas: HTMLCanvasElement) => void = () => {},
    frames = 12,
  ): Promise<Uint8Array> {
    const { mountHeadless } = await import('./headless.ts');
    const device = await getTestDevice();
    return expectValid(device, async () => {
      // The smallest grid and step rate keep this quick on a software rasteriser.
      const mounted = await mountHeadless('fire-3d', {
        width: 96,
        height: 64,
        params: { grid: '32', stepRate: '30', ...params },
      });
      for (let frame = 0; frame < frames; frame++) {
        script(frame, mounted.canvas);
        mounted.step();
      }
      const pixels = await mounted.read();
      mounted.destroy();
      return pixels;
    });
  }

  it('runs every preset, a grid change and a source change without a validation error', async () => {
    const { loadEffect } = await import('../src/effects/registry.ts');
    const effect = await loadEffect('fire-3d');
    for (const preset of Object.values(effect.presets ?? {})) {
      const image = await render({ ...preset }, () => {}, 4);
      expect(new Set(image).size).toBeGreaterThan(8);
    }
    // A drive with no page to scroll is a level of 0, not an error.
    await render({ drive: 'scroll' }, () => {}, 2);
  });

  it('switches grid and source while running', async () => {
    const { mountHeadless } = await import('./headless.ts');
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const mounted = await mountHeadless('fire-3d', { width: 64, height: 48 });
      mounted.step(2);
      mounted.params.grid = '32';
      mounted.step(2);
      mounted.params.source = 'burner';
      mounted.params.resolution = '1/4';
      mounted.step(2);
      expect(new Set(await mounted.read()).size).toBeGreaterThan(8);
      mounted.destroy();
    });
  });

  it('a drag with drag = heat or fuel feeds the fire where the pointer ray crosses the box', async () => {
    const { sendPointer } = await import('./headless.ts');
    // A drag across the middle of the picture, through the flames.
    const drag = (frame: number, canvas: HTMLCanvasElement) => {
      if (frame === 2) sendPointer(canvas, 'pointerdown', 0.35, 0.45, 30);
      if (frame > 2 && frame < 9)
        sendPointer(canvas, 'pointermove', 0.35 + frame * 0.03, 0.45, frame * 16);
      if (frame === 9) sendPointer(canvas, 'pointerup', 0.62, 0.45, 150);
    };
    const quiet = await render({ embers: 0 });
    for (const mode of ['heat', 'fuel']) {
      const fed = await render({ embers: 0, drag: mode }, drag);
      let differing = 0;
      for (let i = 0; i < quiet.length; i++) if (quiet[i] !== fed[i]) differing++;
      expect(differing, mode).toBeGreaterThan(50);
    }
    // With drag = orbit the same gesture turns the camera instead, which also changes the picture.
    const orbited = await render({ embers: 0, orbit: 0 }, drag);
    let moved = 0;
    for (let i = 0; i < quiet.length; i++) if (quiet[i] !== orbited[i]) moved++;
    expect(moved).toBeGreaterThan(50);
  });
});
