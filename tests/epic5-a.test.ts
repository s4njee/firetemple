import { describe, expect, it, vi } from 'vitest';
import {
  baseFuel,
  doomGrid,
  DRIVE_SHARE,
  type DoomFireInstance,
} from '../src/effects/doom-fire/index.ts';
import { DOOM_LEVELS, DOOM_PALETTE, doomRamp } from '../src/effects/doom-fire/palette.ts';
import { loadEffect } from '../src/effects/registry.ts';
import { defaultParams } from '../src/effects/types.ts';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import { noProfiler } from '../src/gpu/profiler.ts';
import {
  createDoomFire,
  DOOM_BACKENDS,
  DOOM_HEAT_MAX,
  DOOM_MAX_STEPS,
  DOOM_QUANTUM,
  doomCooling,
  type DoomBackend,
  type DoomFire,
  type DoomInput,
} from '../src/gpu/sim/doom.ts';
import type { RenderTarget } from '../src/gpu/targets.ts';
import { follow } from '../src/gpu/sim/excitation.ts';
import { createBenchDevice } from './bench.ts';
import { analyseFlashes, sampleCells, type CellSample } from './flash.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import {
  BACKDROPS,
  compositeOver,
  fakeCanvas,
  mountHeadless,
  sendPointer,
  writePng,
  type HeadlessEffect,
} from './headless.ts';

// Epic 5, first group: Doom fire (story 5.1) and what it demonstrates of the shared simulation
// inputs: pointer ignition (5.2), fuel and stray embers (5.7), an outside drive (5.8).
//
// Set EPIC5A_SHOTS=<directory> to also write pictures of the pointer tests, which the headless
// screenshot tool cannot take because it has no pointer.

vi.setConfig({ testTimeout: 120_000 });

const SHOTS = process.env.EPIC5A_SHOTS;

/** Heat (the red channel) of every cell of a state texture, row by row from the top. */
async function heatOf(device: GPUDevice, state: RenderTarget): Promise<Float32Array> {
  const bytes = await readTexture(device, state.texture, 8);
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const heat = new Float32Array(state.width * state.height);
  for (let i = 0; i < heat.length; i++) heat[i] = fromHalf(halves[i * 4]!);
  return heat;
}

const sum = (values: ArrayLike<number>) => {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total;
};
const maxOf = (values: ArrayLike<number>) => {
  let best = -Infinity;
  for (let i = 0; i < values.length; i++) best = Math.max(best, values[i]!);
  return best;
};
const maxDifference = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
};
/** Mean heat of each row, top row first. */
function rowMeans(heat: Float32Array, width: number, height: number): number[] {
  return Array.from(
    { length: height },
    (_, y) => sum(heat.subarray(y * width, (y + 1) * width)) / width,
  );
}

/** Everything the kernel can do, switched on at once. */
const LIVELY: DoomInput = {
  fuel: 0.9,
  reach: 0.6,
  spread: 3,
  wind: 0.3,
  sway: 1.2,
  patchy: 0.6,
  grain: 0.4,
  lift: 0.5,
  uneven: 0.5,
};

/** The original's rule: white noise only, a flat base, a fair coin. */
const ORIGINAL: DoomInput = { fuel: 1, reach: 0.5, spread: 3, grain: 1 };

/** A scripted run: lively fire, a tap, a drag across it, and the lumps and gusts moving. */
function scriptedInput(step: number): DoomInput {
  const igniters =
    step === 20
      ? [{ fromX: 0.3, fromY: 0.3, toX: 0.3, toY: 0.3, radius: 0.08, strength: 1 }]
      : step >= 40 && step < 46
        ? [
            {
              fromX: 0.1 + (step - 40) * 0.12,
              fromY: 0.5,
              toX: 0.1 + (step - 39) * 0.12,
              toY: 0.4,
              radius: 0.05,
              strength: 0.8,
            },
          ]
        : [];
  return { ...LIVELY, drift: step * 0.02, gustClimb: step * 0.25, gustBeat: 30, igniters };
}

/** Runs `steps` scripted steps, several per command encoder, as an effect does on a slow frame. */
function runScript(
  device: GPUDevice,
  fire: DoomFire,
  from: number,
  steps: number,
  batch = 3,
): void {
  for (let step = from; step < from + steps; step += batch) {
    const inputs = Array.from({ length: Math.min(batch, from + steps - step) }, (_, i) =>
      scriptedInput(step + i),
    );
    const encoder = device.createCommandEncoder();
    fire.advance(encoder, inputs);
    device.queue.submit([encoder.finish()]);
  }
}

describe('doom fire solver: the two backends', () => {
  const WIDTH = 96;
  const HEIGHT = 64;

  async function run(backend: DoomBackend, seed = 5, steps = 150): Promise<Float32Array> {
    const device = await getTestDevice();
    const fire = createDoomFire(device, { width: WIDTH, height: HEIGHT, backend, seed });
    await expectValid(device, () => runScript(device, fire, 0, steps));
    expect(fire.tick).toBe(steps);
    const heat = await heatOf(device, fire.current);
    fire.destroy();
    return heat;
  }

  it('produce the same state from the same seed and inputs', async () => {
    const [render, compute] = await Promise.all([run('render'), run('compute')]);
    // There is a fire to compare, and it is not a flat field.
    expect(sum(render) / render.length).toBeGreaterThan(0.05);
    expect(new Set(render).size).toBeGreaterThan(100);
    // Heat moves by integer arithmetic and sits on a grid of 1/1024, so the two agree to within
    // one step of that grid (only the igniters and the lumps of fuel are float work).
    const worst = maxDifference(render, compute);
    expect(worst).toBeLessThanOrEqual(DOOM_QUANTUM * 1.001);
    console.log(`doom fire: render and compute differ by at most ${worst} after 150 steps`);
  });

  it('are repeatable from the seed, and a different seed is a different fire', async () => {
    const [a, b, c] = await Promise.all([run('render', 5), run('render', 5), run('render', 6)]);
    expect(maxDifference(a, b)).toBe(0);
    expect(maxDifference(a, c)).toBeGreaterThan(0.1);
  });

  it('can be switched in the middle of a run without disturbing the fire', async () => {
    const device = await getTestDevice();
    const fire = createDoomFire(device, {
      width: WIDTH,
      height: HEIGHT,
      backend: 'render',
      seed: 5,
    });
    await expectValid(device, () => {
      runScript(device, fire, 0, 75);
      fire.backend = 'compute';
      runScript(device, fire, 75, 75);
    });
    const mixed = await heatOf(device, fire.current);
    fire.destroy();
    expect(maxDifference(mixed, await run('render'))).toBeLessThanOrEqual(DOOM_QUANTUM * 1.001);
  });

  it('carries at most DOOM_MAX_STEPS steps in one encoder and drops the rest', async () => {
    const device = await getTestDevice();
    const fire = createDoomFire(device, { width: 32, height: 32 });
    const encoder = device.createCommandEncoder();
    fire.advance(
      encoder,
      Array.from({ length: DOOM_MAX_STEPS + 3 }, () => ORIGINAL),
    );
    device.queue.submit([encoder.finish()]);
    expect(fire.tick).toBe(DOOM_MAX_STEPS);
    fire.destroy();
  });
});

describe('doom fire solver: the rule', () => {
  it.each(DOOM_BACKENDS)(
    'with the original settings, every cell is a cell of the row below, or that less the cooling (%s)',
    async (backend) => {
      const device = await getTestDevice();
      const width = 48;
      const height = 64;
      const fire = createDoomFire(device, { width, height, backend, seed: 3 });
      fire.warm(80, ORIGINAL);
      const before = await heatOf(device, fire.previous);
      const after = await heatOf(device, fire.current);
      fire.destroy();

      // Reach 0.5 of 64 rows: a mean loss of 32 quanta, so the coin costs 64 or nothing.
      expect(doomCooling(0.5, 64)).toBe(32 * 256);
      const loss = 64 * DOOM_QUANTUM;
      const outcomes = { kept: 0, cooled: 0 };
      const shifts = new Set<number>();
      for (let y = 0; y < height - 1; y++) {
        for (let x = 0; x < width; x++) {
          const value = after[y * width + x]!;
          // Three choices: the column itself and one to either side (clamped at the edges).
          const matches = [-1, 0, 1].filter((shift) => {
            const source = before[(y + 1) * width + Math.min(width - 1, Math.max(0, x + shift))]!;
            return value === source || value === Math.max(0, source - loss);
          });
          expect(matches.length).toBeGreaterThan(0);
          if (matches.length === 1 && before[(y + 1) * width + x]! > loss) {
            shifts.add(matches[0]!);
            const source =
              before[(y + 1) * width + Math.min(width - 1, Math.max(0, x + matches[0]!))]!;
            if (value === source) outcomes.kept++;
            else outcomes.cooled++;
          }
        }
      }
      // All three columns are used, and the coin is fair.
      expect([...shifts].sort()).toEqual([-1, 0, 1]);
      const share = outcomes.cooled / (outcomes.cooled + outcomes.kept);
      expect(share).toBeGreaterThan(0.42);
      expect(share).toBeLessThan(0.58);
      // The bottom row is the fuel, held.
      for (let x = 0; x < width; x++) expect(after[(height - 1) * width + x]).toBe(1);
    },
  );

  it('keeps heat on its grid of 1/1024 and inside 0..DOOM_HEAT_MAX', async () => {
    const device = await getTestDevice();
    const fire = createDoomFire(device, { width: 96, height: 64, seed: 2 });
    runScript(device, fire, 0, 60);
    // An igniter far hotter than anything should be: it is clamped like everything else.
    const searing = { fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5, radius: 0.1, strength: 6 };
    fire.warm(3, { ...LIVELY, igniters: [searing] });
    const heat = await heatOf(device, fire.current);
    // An ordinary one raises a cell to its own heat and no further, however long it is held.
    const held = { fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5, radius: 0.1, strength: 1 };
    fire.clear();
    fire.warm(30, { ...LIVELY, fuel: 0, igniters: [held] });
    const hottest = maxOf(await heatOf(device, fire.current));
    expect(hottest).toBeGreaterThan(0.9);
    expect(hottest).toBeLessThanOrEqual(1);
    fire.destroy();
    expect(maxOf(heat)).toBe(DOOM_HEAT_MAX);
    for (const value of heat) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(value / DOOM_QUANTUM)).toBe(true);
    }
  });

  it.each([
    [64, 0],
    [128, 0],
    [128, 0.5],
    [192, 1],
  ])('reaches the same share of a %i-row grid with lift %f', async (rows, lift) => {
    const device = await getTestDevice();
    const width = 64;
    const fire = createDoomFire(device, { width, height: rows });
    fire.warm(rows * 2, { ...ORIGINAL, lift });
    const means = rowMeans(await heatOf(device, fire.current), width, rows);
    fire.destroy();
    // Reach 0.5: heat falls in a straight line from 1 at the base to 0 half-way up.
    const at = (share: number) => means[Math.round((rows - 1) * (1 - share))]!;
    expect(at(0)).toBe(1);
    expect(at(0.125)).toBeGreaterThan(0.75 - 0.06);
    expect(at(0.125)).toBeLessThan(0.75 + 0.06);
    expect(at(0.25)).toBeGreaterThan(0.5 - 0.06);
    expect(at(0.25)).toBeLessThan(0.5 + 0.06);
    expect(at(0.375)).toBeGreaterThan(0.25 - 0.06);
    expect(at(0.375)).toBeLessThan(0.25 + 0.06);
    // The coin is fair but not kind: a few cells win it far more often than they lose.
    expect(at(0.7)).toBeLessThan(0.01);
    expect(at(0.95)).toBe(0);
  });

  it('dies from the base up when the fuel is taken away, and relights when it comes back', async () => {
    const device = await getTestDevice();
    const width = 64;
    const height = 64;
    const fire = createDoomFire(device, { width, height });
    fire.warm(100, LIVELY);
    expect(sum(await heatOf(device, fire.current))).toBeGreaterThan(100);

    // No fuel: after a few steps the base is cold while the top of the fire is still burning.
    fire.warm(8, { ...LIVELY, fuel: 0 });
    const lifting = rowMeans(await heatOf(device, fire.current), width, height);
    expect(lifting[height - 1]).toBe(0);
    expect(lifting[height - 3]).toBe(0);
    expect(maxOf(lifting)).toBeGreaterThan(0.1);
    // ...and once every cell has had time to climb out of its reach, nothing is left at all.
    fire.warm(120, { ...LIVELY, fuel: 0 });
    expect(maxOf(await heatOf(device, fire.current))).toBe(0);

    fire.warm(4, LIVELY);
    const relit = rowMeans(await heatOf(device, fire.current), width, height);
    expect(relit[height - 1]).toBeGreaterThan(0.3);
    expect(relit[height - 3]).toBeGreaterThan(0.2);
    expect(relit[height - 16]).toBe(0);
    fire.destroy();
  });

  it('lights where an igniter lands, carries the heat upward, and lets it die', async () => {
    const device = await getTestDevice();
    const width = 96;
    const height = 96;
    const fire = createDoomFire(device, { width, height });
    const calm: DoomInput = { fuel: 0, reach: 0.5, lift: 0.5, grain: 0.25 };
    const tap = { fromX: 0.25, fromY: 0.75, toX: 0.25, toY: 0.75, radius: 0.06, strength: 1 };
    /** Heat-weighted mean position, in cells. */
    const centre = (heat: Float32Array) => {
      let x = 0;
      let y = 0;
      for (let i = 0; i < heat.length; i++) {
        x += (i % width) * heat[i]!;
        y += Math.floor(i / width) * heat[i]!;
      }
      const total = sum(heat);
      return { x: x / total, y: y / total, total };
    };

    fire.warm(1, { ...calm, igniters: [tap] });
    const lit = centre(await heatOf(device, fire.current));
    expect(lit.total).toBeGreaterThan(10);
    expect(lit.x).toBeGreaterThan(0.25 * width - 1.5);
    expect(lit.x).toBeLessThan(0.25 * width + 0.5);
    expect(lit.y).toBeGreaterThan(0.75 * height - 1.5);
    expect(lit.y).toBeLessThan(0.75 * height + 0.5);

    // Ten steps at a lift of 0.5: about fifteen rows higher, and cooler.
    fire.warm(10, calm);
    const risen = centre(await heatOf(device, fire.current));
    expect(lit.y - risen.y).toBeGreaterThan(11);
    expect(lit.y - risen.y).toBeLessThan(19);
    expect(Math.abs(risen.x - lit.x)).toBeLessThan(3);
    expect(risen.total).toBeLessThan(lit.total);

    fire.warm(40, calm);
    expect(maxOf(await heatOf(device, fire.current))).toBe(0);
    fire.destroy();
  });

  it('leans with the wind', async () => {
    const device = await getTestDevice();
    const width = 128;
    const height = 64;
    const drift = async (wind: number) => {
      const fire = createDoomFire(device, { width, height });
      const tap = { fromX: 0.5, fromY: 0.9, toX: 0.5, toY: 0.9, radius: 0.08, strength: 1 };
      // No cooling to speak of and no sideways noise: only the wind moves the heat.
      const still: DoomInput = { fuel: 0, reach: 100, wind, spread: 1, grain: 0 };
      fire.warm(1, { ...still, igniters: [tap] });
      fire.warm(20, still);
      const heat = await heatOf(device, fire.current);
      fire.destroy();
      let x = 0;
      for (let i = 0; i < heat.length; i++) x += (i % width) * heat[i]!;
      // The tap is at uv 0.5: between the two middle columns.
      return x / sum(heat) - (0.5 * width - 0.5);
    };
    // Twenty steps at half a cell a step: ten cells downwind, give or take the dice (a cell
    // takes one whole neighbour or the other, so heat is not conserved step by step).
    expect(await drift(0.5)).toBeGreaterThan(8);
    expect(await drift(0.5)).toBeLessThan(12);
    expect(await drift(-0.5)).toBeLessThan(-8);
    expect(await drift(-0.5)).toBeGreaterThan(-12);
    // A whole cell a step is exact, and so is no wind.
    expect(await drift(1)).toBeCloseTo(20, 2);
    expect(await drift(0)).toBeCloseTo(0, 2);
  });

  it('keeps burning through a change of grid, and counts the generation', async () => {
    const device = await getTestDevice();
    const fire = createDoomFire(device, { width: 96, height: 64 });
    expect(fire.generation).toBe(0);
    fire.warm(100, ORIGINAL);
    const before = await heatOf(device, fire.current);
    const oldView = fire.current.view;

    expect(fire.resize(96, 64)).toBe(false);
    expect(fire.generation).toBe(0);

    await expectValid(device, () => {
      expect(fire.resize(144, 96)).toBe(true);
    });
    expect(fire.generation).toBe(1);
    expect([fire.width, fire.height]).toEqual([144, 96]);
    expect(fire.current.view).not.toBe(oldView);
    // The same fire on a finer grid: the same mean heat, in both the state and the one before.
    const after = await heatOf(device, fire.current);
    const previous = await heatOf(device, fire.previous);
    const mean = sum(before) / before.length;
    expect(sum(after) / after.length).toBeGreaterThan(mean * 0.95);
    expect(sum(after) / after.length).toBeLessThan(mean * 1.05);
    expect(maxDifference(after, previous)).toBe(0);

    // It steps on in either backend without a validation error.
    await expectValid(device, () => {
      fire.warm(2, ORIGINAL);
      fire.backend = 'compute';
      fire.warm(2, ORIGINAL);
    });
    fire.clear();
    expect(fire.tick).toBe(0);
    expect(maxOf(await heatOf(device, fire.current))).toBe(0);
    expect(maxOf(await heatOf(device, fire.previous))).toBe(0);
    fire.destroy();
  });
});

describe('doom-fire: grid, fuel and palette', () => {
  it('sizes the grid from the canvas shape, never from its size', () => {
    expect(doomGrid(1920, 1080, 192)).toEqual(doomGrid(960, 540, 192));
    expect(doomGrid(1920, 1080, 192)).toEqual(doomGrid(3840, 2160, 192));
    expect(doomGrid(1920, 1080, 192)).toEqual([344, 192]);
    // `resolution` is the shorter side, whichever that is.
    expect(doomGrid(390, 844, 96)).toEqual([96, 208]);
    expect(doomGrid(500, 500, 64)).toEqual([64, 64]);
    // Whole compute workgroups, so dragging a window edge rarely changes the grid.
    for (const [w, h] of [
      [1280, 717],
      [1283, 720],
      [886, 160],
      [300, 150],
    ] as const) {
      const [columns, rows] = doomGrid(w, h, 100);
      expect(columns % 8).toBe(0);
      expect(rows % 8).toBe(0);
    }
    expect(doomGrid(1300, 720, 128)).toEqual(doomGrid(1320, 720, 128));
    // A very wide band stops growing.
    expect(doomGrid(4000, 100, 256)).toEqual([1024, 256]);
  });

  it('raises the base fuel by a share of its calm level, never above the clamp', () => {
    expect(baseFuel(0.8, 0)).toBe(0.8);
    expect(baseFuel(0.8, 1)).toBeCloseTo(0.8 * (1 + DRIVE_SHARE), 9);
    expect(baseFuel(0.8, 0.5)).toBeCloseTo(0.8 * (1 + DRIVE_SHARE / 2), 9);
    // A fire that is out stays out however hard it is driven.
    expect(baseFuel(0, 1)).toBe(0);
    expect(baseFuel(1, 5)).toBeLessThanOrEqual(DOOM_HEAT_MAX);
    expect(baseFuel(3, 0)).toBe(1);
  });

  it('has the original palette as a ramp: black at heat 0, white-hot at heat 1', () => {
    expect(DOOM_PALETTE).toHaveLength(37);
    expect(DOOM_LEVELS).toBe(37);
    expect(doomRamp(0)).toEqual([0, 0, 0]);
    const top = doomRamp(1);
    expect(top[0]).toBeGreaterThan(3);
    expect(top[1]).toBeCloseTo(top[0], 6);
    expect(top[2]).toBeCloseTo(top[0], 6);
    // The low end is red: no green or blue to speak of until the palette turns orange.
    const low = doomRamp(4 / 36);
    expect(low[0]).toBeGreaterThan(low[1] * 5);
    // Brightness never falls as heat rises.
    const luminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    for (let level = 1; level < DOOM_LEVELS; level++) {
      expect(luminance(doomRamp(level / 36))).toBeGreaterThanOrEqual(
        luminance(doomRamp((level - 1) / 36)),
      );
    }
  });
});

// --- The effect ----------------------------------------------------------------------------------

const WIDTH = 240;
const HEIGHT = 136;

const fireOf = (mounted: HeadlessEffect) => (mounted.instance as DoomFireInstance).fire;

/** Rows (from the top) and columns that contain any non-zero byte. */
function lit(pixels: Uint8Array, width = WIDTH, height = HEIGHT) {
  const rows = new Set<number>();
  const columns = new Set<number>();
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! + pixels[i + 3]! > 0) {
        rows.add(y);
        columns.add(x);
        count++;
      }
    }
  }
  return { rows: [...rows], columns: [...columns], count };
}

function shot(name: string, pixels: Uint8Array, width = WIDTH, height = HEIGHT): void {
  if (!SHOTS) return;
  writePng(`${SHOTS}/${name}.png`, width, height, compositeOver(pixels, BACKDROPS.dark!));
}

/** No bloom, so the only light is what the display pass wrote; no embers unless asked for. */
const BARE = { bloom: 0, embers: 0 };

describe('doom-fire: the picture', () => {
  it('is a fire on its first frame, anchored to the bottom edge, transparent above', async () => {
    const mounted = await mountHeadless('doom-fire', {
      width: WIDTH,
      height: HEIGHT,
      params: BARE,
    });
    mounted.step();
    const first = lit(await mounted.read());
    await mounted.runTo(2);
    const later = lit(await mounted.read());
    mounted.destroy();
    for (const frame of [first, later]) {
      expect(Math.max(...frame.rows)).toBe(HEIGHT - 1);
      // Every column burns at the base, and the fire fills a good part of its reach.
      expect(frame.columns.length).toBe(WIDTH);
      expect(frame.rows.length).toBeGreaterThan(HEIGHT * 0.25);
      // Height 0.55: the top third of the canvas is clear page.
      expect(Math.min(...frame.rows)).toBeGreaterThan(HEIGHT * 0.33);
    }
  });

  it('is the same fire at 30, 60 and 120 frames a second', async () => {
    const device = await getTestDevice();
    const at = async (fps: number) => {
      // Embers on: they are scheduled by the simulation's clock, not the frame's.
      const mounted = await mountHeadless('doom-fire', {
        width: WIDTH,
        height: HEIGHT,
        fps,
        params: { embers: 2 },
      });
      const fire = fireOf(mounted);
      // The first frame also runs the warm-up, which is the same number of steps at any rate.
      const start = Math.ceil(0.55 * fire.height * 1.3);
      while (fire.tick < start + 90) mounted.step();
      expect(fire.tick).toBe(start + 90);
      const heat = await heatOf(device, fire.current);
      const frames = mounted.time.frame;
      mounted.destroy();
      return { heat, frames };
    };
    const [slow, normal, fast] = await Promise.all([at(30), at(60), at(120)]);
    // 90 steps at 45 a second are two seconds, however many frames that took.
    expect(slow.frames).toBe(60);
    expect(normal.frames).toBe(120);
    expect(fast.frames).toBe(240);
    expect(maxDifference(slow.heat, normal.heat)).toBe(0);
    expect(maxDifference(fast.heat, normal.heat)).toBe(0);
  });

  it('draws the same picture with either backend', async () => {
    const render = async (backend: string) => {
      const mounted = await mountHeadless('doom-fire', {
        width: WIDTH,
        height: HEIGHT,
        params: { backend },
      });
      await mounted.runTo(1.5);
      const pixels = await mounted.read();
      mounted.destroy();
      return pixels;
    };
    const [a, b] = await Promise.all([render('render'), render('compute')]);
    expect(lit(a).count).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
    expect(maxDifference(a, b)).toBeLessThanOrEqual(1);
  });

  it('follows the resolution parameter while running, without losing the fire', async () => {
    const device = await getTestDevice();
    const mounted = await mountHeadless('doom-fire', {
      width: WIDTH,
      height: HEIGHT,
      params: BARE,
    });
    const fire = fireOf(mounted);
    await mounted.runTo(1);
    expect([fire.width, fire.height]).toEqual(doomGrid(WIDTH, HEIGHT, 192));
    const generation = fire.generation;
    const before = lit(await mounted.read()).count;

    await expectValid(device, async () => {
      mounted.params.resolution = 64;
      mounted.step();
      await device.queue.onSubmittedWorkDone();
    });
    expect([fire.width, fire.height]).toEqual(doomGrid(WIDTH, HEIGHT, 64));
    expect(fire.generation).toBe(generation + 1);
    // The very next frame is still about as much fire: the state was carried over, not restarted.
    const after = lit(await mounted.read()).count;
    expect(after).toBeGreaterThan(before * 0.85);
    expect(after).toBeLessThan(before * 1.15);

    // A canvas resize that keeps the shape keeps the grid.
    mounted.instance.resize(WIDTH * 2, HEIGHT * 2, 2);
    mounted.instance.resize(WIDTH, HEIGHT, 1);
    mounted.step();
    expect(fire.generation).toBe(generation + 1);
    mounted.destroy();
  });

  it('shows whole cells when pixelated', async () => {
    // 64 rows on a 128-pixel-high canvas: every cell is 2 x 2 pixels.
    const mounted = await mountHeadless('doom-fire', {
      width: 256,
      height: 128,
      preset: 'classic doom',
      params: { resolution: 64, bloom: 0 },
    });
    await mounted.runTo(1);
    const pixels = await mounted.read();
    mounted.destroy();
    expect(doomGrid(256, 128, 64)).toEqual([128, 64]);
    let worst = 0;
    for (let y = 0; y < 128; y += 2) {
      for (let x = 0; x < 256; x += 2) {
        for (let c = 0; c < 4; c++) {
          const corner = pixels[(y * 256 + x) * 4 + c]!;
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const) {
            worst = Math.max(worst, Math.abs(pixels[((y + dy) * 256 + x + dx) * 4 + c]! - corner));
          }
        }
      }
    }
    // The output pass dithers, by up to one 8-bit step either way.
    expect(worst).toBeLessThanOrEqual(2);
    // ...and neighbouring cells do differ: it is a mosaic, not a gradient.
    expect(new Set(pixels).size).toBeGreaterThan(30);
  });
});

describe('doom-fire: fuel and embers (story 5.7)', () => {
  it('goes out when the fuel is taken away and relights when it is given back', async () => {
    const mounted = await mountHeadless('doom-fire', {
      width: WIDTH,
      height: HEIGHT,
      params: BARE,
    });
    await mounted.runTo(1);
    expect(lit(await mounted.read()).count).toBeGreaterThan(WIDTH * HEIGHT * 0.2);

    mounted.params.fuel = 0;
    await mounted.runTo(1.4);
    const lifting = lit(await mounted.read());
    shot('fuel-lifting', await mounted.read());
    // The base has gone dark first; what is left is in the air.
    expect(lifting.count).toBeGreaterThan(0);
    expect(Math.max(...lifting.rows)).toBeLessThan(HEIGHT - 8);
    await mounted.runTo(5);
    expect(lit(await mounted.read()).count).toBe(0);

    mounted.params.fuel = 0.9;
    await mounted.runTo(5.3);
    const relighting = lit(await mounted.read());
    shot('fuel-relighting', await mounted.read());
    expect(Math.max(...relighting.rows)).toBe(HEIGHT - 1);
    expect(Math.min(...relighting.rows)).toBeGreaterThan(HEIGHT * 0.6);
    await mounted.runTo(8);
    expect(lit(await mounted.read()).count).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
    mounted.destroy();
  });

  it('is never dead while embers fall, even with no fuel', async () => {
    const mounted = await mountHeadless('doom-fire', {
      width: WIDTH,
      height: HEIGHT,
      preset: 'burnt out',
      params: { bloom: 0 },
    });
    let alight = 0;
    let largest = 0;
    const frames = 480;
    for (let frame = 0; frame < frames; frame++) {
      mounted.step();
      if (frame % 6 !== 0) continue;
      const count = lit(await mounted.read()).count;
      if (count > 0) alight++;
      largest = Math.max(largest, count);
      if (frame === 240) shot('burnt-out', await mounted.read());
    }
    mounted.destroy();
    // Something is burning in most of the samples, and it is sparks, not a wall of fire.
    expect(alight).toBeGreaterThan((frames / 6) * 0.7);
    expect(largest).toBeGreaterThan(20);
    expect(largest).toBeLessThan(WIDTH * HEIGHT * 0.1);
  });
});

describe('doom-fire: pointer ignition (story 5.2)', () => {
  it.skipIf(!SHOTS)('pictures of drawing, for looking at', async () => {
    const width = 960;
    const height = 540;
    const mounted = await mountHeadless('doom-fire', {
      width,
      height,
      preset: 'draw with the pointer',
    });
    await mounted.runTo(1);
    // A held touch on the left, and a looping stroke on the right drawn over half a second.
    sendPointer(mounted.canvas, 'pointerdown', 0.2, 0.7, 0, 1);
    sendPointer(mounted.canvas, 'pointerdown', 0.55, 0.6, 0, 2);
    for (let frame = 0; frame < 45; frame++) {
      const t = frame / 45;
      sendPointer(
        mounted.canvas,
        'pointermove',
        0.55 + 0.3 * t + 0.05 * Math.sin(t * 12),
        0.6 + 0.12 * Math.sin(t * 9),
        frame * 16,
        2,
      );
      mounted.step();
      if (frame === 20) shot('draw-0', await mounted.read(), width, height);
    }
    shot('draw-1', await mounted.read(), width, height);
    sendPointer(mounted.canvas, 'pointerup', 0.85, 0.6, 800, 2);
    mounted.step(20);
    shot('draw-2', await mounted.read(), width, height);
    sendPointer(mounted.canvas, 'pointerup', 0.2, 0.7, 1200, 1);
    mounted.step(30);
    shot('draw-3', await mounted.read(), width, height);
    mounted.destroy();
  });

  /** A dark stage: no fuel and no embers, so the only fire is what the pointer lights. */
  const stage = () =>
    mountHeadless('doom-fire', {
      width: WIDTH,
      height: HEIGHT,
      params: { ...BARE, fuel: 0, brush: 0.05 },
    });
  const centreRow = (rows: number[]) => rows.reduce((a, b) => a + b, 0) / rows.length;

  it('lights a spot on a tap, which rises and dies', async () => {
    const mounted = await stage();
    mounted.step(2);
    expect(lit(await mounted.read()).count).toBe(0);

    sendPointer(mounted.canvas, 'pointerdown', 0.3, 0.7, 10);
    mounted.step(2);
    sendPointer(mounted.canvas, 'pointerup', 0.3, 0.7, 40);
    mounted.step(3);
    const spot = lit(await mounted.read());
    shot('tap-lit', await mounted.read());
    expect(spot.count).toBeGreaterThan(20);
    // Round the tap, and nowhere else.
    expect(Math.min(...spot.columns)).toBeGreaterThan(0.3 * WIDTH - 0.12 * HEIGHT);
    expect(Math.max(...spot.columns)).toBeLessThan(0.3 * WIDTH + 0.12 * HEIGHT);
    expect(Math.max(...spot.rows)).toBeLessThan(0.7 * HEIGHT + 0.08 * HEIGHT);

    mounted.step(24);
    const risen = lit(await mounted.read());
    shot('tap-risen', await mounted.read());
    expect(risen.count).toBeGreaterThan(0);
    expect(centreRow(risen.rows)).toBeLessThan(centreRow(spot.rows) - HEIGHT * 0.1);

    await mounted.runTo(4);
    expect(lit(await mounted.read()).count).toBe(0);
    mounted.destroy();
  });

  it('draws a line of fire along a drag, with no gaps however fast the stroke', async () => {
    const mounted = await stage();
    mounted.step();
    sendPointer(mounted.canvas, 'pointerdown', 0.15, 0.8, 0);
    mounted.step();
    // The whole stroke inside two frames: three move events, 0.7 of the canvas width.
    sendPointer(mounted.canvas, 'pointermove', 0.4, 0.75, 16);
    sendPointer(mounted.canvas, 'pointermove', 0.65, 0.8, 24);
    mounted.step();
    sendPointer(mounted.canvas, 'pointermove', 0.85, 0.75, 32);
    sendPointer(mounted.canvas, 'pointerup', 0.85, 0.75, 40);
    mounted.step(3);
    const stroke = lit(await mounted.read());
    shot('drag-lit', await mounted.read());
    mounted.step(20);
    shot('drag-risen', await mounted.read());
    mounted.destroy();
    for (let x = Math.ceil(0.15 * WIDTH); x <= Math.floor(0.85 * WIDTH); x++) {
      expect(stroke.columns).toContain(x);
    }
    // A line, not a flood: it stays near the stroke's height.
    expect(Math.min(...stroke.rows)).toBeGreaterThan(0.5 * HEIGHT);
  });

  it('follows several touches at once', async () => {
    const mounted = await stage();
    mounted.step();
    sendPointer(mounted.canvas, 'pointerdown', 0.2, 0.8, 0, 1);
    sendPointer(mounted.canvas, 'pointerdown', 0.5, 0.6, 0, 2);
    sendPointer(mounted.canvas, 'pointerdown', 0.8, 0.8, 0, 3);
    // Held for a third of a second: three standing flames.
    mounted.step(20);
    const pixels = await mounted.read();
    shot('three-touches', pixels);
    const touches = lit(pixels);
    for (const id of [1, 2, 3]) sendPointer(mounted.canvas, 'pointerup', 0, 0, 400, id);
    mounted.destroy();
    for (const x of [0.2, 0.5, 0.8]) expect(touches.columns).toContain(Math.round(x * WIDTH));
    // Dark between them.
    expect(touches.columns).not.toContain(Math.round(0.35 * WIDTH));
    expect(touches.columns).not.toContain(Math.round(0.65 * WIDTH));
    // A held touch is a flame standing on the finger: lit well above it, not below it.
    expect(Math.min(...touches.rows)).toBeLessThan(0.6 * HEIGHT - 0.15 * HEIGHT);
    expect(Math.max(...touches.rows)).toBeLessThan(0.8 * HEIGHT + 0.08 * HEIGHT);
  });
});

describe('doom-fire: an outside drive (story 5.8)', () => {
  // There is no page to scroll and no sound here, so the drive's level is played by hand: the
  // base fuel the effect would get from `baseFuel(0.6, level)`, with the level following a beat
  // through the same rise-fast, fall-slow smoothing as the audio drive.
  it.each([2.3, 3, 4])(
    'a drive pumping at %f beats a second stays under the flash threshold',
    async (beats) => {
      const width = 480;
      const height = 270;
      const mounted = await mountHeadless('doom-fire', {
        width,
        height,
        preset: 'fed by scrolling',
        params: { drive: 'none' },
      });
      await mounted.runTo(1);
      let level = 0;
      const cells: CellSample[][] = [];
      for (let frame = 0; frame < 360; frame++) {
        const t = frame / 60;
        const kick = (t * beats) % 1 < 0.25 ? 1 : 0;
        level = follow(level, kick, 1 / 60, 0.03, 0.35);
        mounted.params.fuel = baseFuel(0.6, level);
        mounted.step();
        cells.push(sampleCells(await mounted.read(), width, height, 24, 14));
      }
      mounted.destroy();
      // As tests/flash.ts measures every effect: 480 x 270 standing for 1080p.
      const report = analyseFlashes({
        cells,
        cellAreaPx: (width / 24) * (height / 14) * 16,
        fps: 60,
      });
      expect(report.verdict, JSON.stringify(report)).not.toBe('high');
      expect(report.frameFlashes).toBe(0);
      console.log(`doom fire, drive at ${beats} beats a second: ${JSON.stringify(report)}`);
    },
  );
});

describe('doom-fire: lifecycle', () => {
  it.each(['none', 'scroll', 'audio'])(
    'releases every listener it put on the canvas (drive: %s)',
    async (drive) => {
      const device = await getTestDevice();
      const canvas = fakeCanvas(WIDTH, HEIGHT);
      const listeners: { signal?: AbortSignal; removed: boolean; handler: unknown }[] = [];
      const add = canvas.addEventListener.bind(canvas);
      const remove = canvas.removeEventListener.bind(canvas);
      canvas.addEventListener = ((type: string, handler: EventListener, options?: unknown) => {
        const signal =
          typeof options === 'object' && options !== null
            ? (options as AddEventListenerOptions).signal
            : undefined;
        listeners.push({ signal, removed: false, handler });
        add(type, handler, options as AddEventListenerOptions);
      }) as typeof canvas.addEventListener;
      canvas.removeEventListener = ((type: string, handler: EventListener) => {
        for (const listener of listeners) if (listener.handler === handler) listener.removed = true;
        remove(type, handler);
      }) as typeof canvas.removeEventListener;

      const effect = await loadEffect('doom-fire');
      const target = device.createTexture({
        size: [WIDTH, HEIGHT],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const params = { ...defaultParams(effect.params), drive: 'none' };
      await expectValid(device, async () => {
        const instance = await effect.create({
          device,
          format: 'rgba8unorm',
          canvas,
          params,
          profiler: noProfiler,
          hdr: false,
        });
        instance.resize(WIDTH, HEIGHT, 1);
        const frame = (index: number) => {
          const encoder = device.createCommandEncoder();
          instance.frame(
            { time: index / 60, delta: 1 / 60, frame: index },
            encoder,
            target.createView(),
          );
          device.queue.submit([encoder.finish()]);
        };
        frame(0);
        // The drive is switched while running: the old source must be let go of too.
        params.drive = drive;
        frame(1);
        params.drive = 'none';
        frame(2);
        params.drive = drive;
        frame(3);
        expect(listeners.length).toBeGreaterThan(0);
        instance.destroy();
        await device.queue.onSubmittedWorkDone();
      });
      target.destroy();
      for (const listener of listeners) {
        expect(listener.removed || listener.signal?.aborted === true).toBe(true);
      }
    },
  );
});

// Indicative cost on Dawn (this machine's GPU, whatever else is using it). Not part of the normal
// run: EPIC5A_BENCH=1 npx vitest run tests/epic5-a.test.ts -t "cost" --silent=false
describe.skipIf(!process.env.EPIC5A_BENCH)('doom fire: cost on Dawn (indicative)', () => {
  it('times one step in each backend at several grid sizes, and the whole effect at 1080p', async () => {
    const bench = await createBenchDevice();
    const lines: string[] = [];
    const per = (ms: number, count: number) => (ms / count).toFixed(4);
    for (const [width, height] of [
      [168, 96],
      [344, 192],
      [456, 256],
      [1024, 576],
      [1920, 1080],
    ] as const) {
      for (const backend of DOOM_BACKENDS) {
        const fire = createDoomFire(bench.device, { width, height, backend });
        fire.warm(4, LIVELY);
        const steps = 8;
        const result = await bench.measure((encoder) => {
          for (let i = 0; i < steps; i++) {
            fire.advance(encoder, [LIVELY], bench.profiler.pass('step'));
          }
        });
        lines.push(
          `${width} x ${height} ${backend}: ${per(result.slopeMs, steps)} ms a step (${per(result.slopeMinMs, steps)} to ${per(result.slopeMaxMs, steps)}), ${result.metric}`,
        );
        fire.destroy();
      }
    }
    for (const [id, params] of [
      ['bloom-tuning', {}],
      ['doom-fire', { backend: 'render' }],
      ['doom-fire', { backend: 'compute' }],
      ['doom-fire', { backend: 'render', resolution: 256, rate: 60 }],
    ] as const) {
      const mounted = await mountHeadless(id, {
        width: 1920,
        height: 1080,
        device: bench.device,
        profiler: bench.profiler,
        params,
      });
      mounted.step(4);
      await bench.device.queue.onSubmittedWorkDone();
      const result = await bench.measure((encoder) => mounted.encode(encoder));
      lines.push(
        `${id} ${JSON.stringify(params)} at 1920 x 1080: ${result.slopeMs.toFixed(3)} ms a frame (${result.slopeMinMs.toFixed(3)} to ${result.slopeMaxMs.toFixed(3)}), span ${result.spanMs.toFixed(3)} ms`,
      );
      mounted.destroy();
    }
    console.log(`doom fire cost:\n${lines.join('\n')}`);
    bench.destroy();
  });
});
