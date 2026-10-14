import { describe, expect, it, vi } from 'vitest';
import {
  COMBUSTION_ALPHA_MAX,
  COMBUSTION_MAX_SUBSTEPS,
  COMBUSTION_T_MAX,
  createCombustionSim,
  planCombustion,
  type CombustionSettings,
  type CombustionSim,
} from '../src/gpu/sim/combustion.ts';
import { gridSize, REFERENCE_ROWS } from '../src/effects/combustion-front/index.ts';
import { loadEffect } from '../src/effects/registry.ts';
import { defaultParams } from '../src/effects/types.ts';
import { noProfiler } from '../src/gpu/profiler.ts';
import type { Igniter } from '../src/gpu/sim/ignition.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { fakeCanvas, mountHeadless, sendPointer } from './headless.ts';

// Epic 5, story 5.6: reaction-diffusion combustion. The claims of the notes, as numbers: the
// front moves by itself at a speed set by D and k, a point-lit front is a circle, no setting can
// make the fields leave their bounds, and the stability limit the module enforces is real.
//
// The tables in the notes come from the block at the end:
//   COMBUSTION_MEASURE=1 npx vitest run --silent=false tests/epic5-c.test.ts

vi.setConfig({ testTimeout: 120_000 });

const STEP = 1 / 60;

/** The defaults of the effect, in cells of its 384-row grid. */
const BASE: CombustionSettings = {
  diffusion: 14,
  release: 1,
  rate: 6,
  cooling: 0.6,
  regrow: 0,
  kinetics: 'threshold',
  ignition: 0.25,
  activation: 8,
};
const UNIFORM = { patchiness: 0, scale: 3 };

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

interface Fields {
  width: number;
  height: number;
  /** Temperature, fuel, capacity and reaction rate, row by row. */
  t: Float32Array;
  f: Float32Array;
  capacity: Float32Array;
  rate: Float32Array;
}

async function readFields(device: GPUDevice, sim: CombustionSim): Promise<Fields> {
  const bytes = await readTexture(device, sim.state.texture, 8);
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const count = sim.width * sim.height;
  const fields: Fields = {
    width: sim.width,
    height: sim.height,
    t: new Float32Array(count),
    f: new Float32Array(count),
    capacity: new Float32Array(count),
    rate: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    fields.t[i] = halfToFloat(halves[i * 4]!);
    fields.f[i] = halfToFloat(halves[i * 4 + 1]!);
    fields.capacity[i] = halfToFloat(halves[i * 4 + 2]!);
    fields.rate[i] = halfToFloat(halves[i * 4 + 3]!);
  }
  return fields;
}

interface RunOptions {
  igniters?: readonly Igniter[];
  /** Seconds the igniters are held for. Default 0.2. */
  hold?: number;
  alphaMax?: number;
  maxSubsteps?: number;
}

/** Advances `sim` by `seconds` in 60 Hz steps, one submission per step. */
function run(
  device: GPUDevice,
  sim: CombustionSim,
  settings: CombustionSettings,
  seconds: number,
  clock: { time: number },
  options: RunOptions = {},
): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    const encoder = device.createCommandEncoder();
    const lit = clock.time < (options.hold ?? 0.2) ? (options.igniters ?? []) : [];
    sim.advance(encoder, STEP, settings, lit, sim.width / sim.height, options);
    device.queue.submit([encoder.finish()]);
    clock.time += STEP;
  }
}

const tap = (x: number, y: number, radius: number, strength = 1.5): Igniter => ({
  fromX: x,
  fromY: y,
  toX: x,
  toY: y,
  radius,
  strength,
});

/** Where the fuel of `row` first rises through `level` going right, in cells (interpolated). */
function frontAlongRow(fields: Fields, row: number, level = 0.5): number {
  const base = row * fields.width;
  for (let x = 0; x < fields.width - 1; x++) {
    const a = fields.f[base + x]!;
    const b = fields.f[base + x + 1]!;
    if (a <= level && b > level) return x + (level - a) / (b - a);
  }
  return fields.f[base]! > level ? 0 : fields.width - 1;
}

interface PlaneFront {
  /** Cells per second; 0 when the front died. */
  speed: number;
  /** Cells between fuel 0.9 and fuel 0.1: the reaction zone. */
  reaction: number;
  /** Cells from the temperature peak forward to a tenth of it: the preheated zone. */
  preheat: number;
  /** Cells from the peak back to half of it: the glowing tail. */
  tail: number;
  peak: number;
  substeps: number;
}

/** Lights the left edge of a long strip of uniform fuel and times the front between two marks. */
async function planeFront(
  device: GPUDevice,
  settings: CombustionSettings,
  options: { length?: number; seconds?: number; alphaMax?: number } = {},
): Promise<PlaneFront> {
  const length = options.length ?? 640;
  const sim = createCombustionSim(device, { width: length, height: 8 });
  sim.lay(UNIFORM);
  const clock = { time: 0 };
  // The whole left edge, 10 cells deep (the radius is in canvas heights; the strip is 8 high).
  const igniters = [{ fromX: 0, fromY: 0, toX: 0, toY: 1, radius: 1.25, strength: 1.5 }];
  const from = length * 0.25;
  const to = length * 0.8;
  let first: { x: number; time: number } | undefined;
  let last: { x: number; time: number } | undefined;
  let fields = await readFields(device, sim);
  let previous = 0;
  const limit = options.seconds ?? 90;
  while (clock.time < limit) {
    run(device, sim, settings, 0.25, clock, { igniters, hold: 1, alphaMax: options.alphaMax });
    fields = await readFields(device, sim);
    const x = frontAlongRow(fields, 4);
    if (x >= from && !first) first = { x, time: clock.time };
    if (first && x <= to) last = { x, time: clock.time };
    if (x > to) break;
    // A front that has not moved a hundredth of a cell in a quarter second, after its start, is dead.
    if (clock.time > 2 && x - previous < 0.0025) break;
    previous = x;
  }
  const plan = planCombustion(settings.diffusion, STEP, undefined, options.alphaMax);
  const result: PlaneFront = {
    speed: 0,
    reaction: 0,
    preheat: 0,
    tail: 0,
    peak: 0,
    substeps: plan.substeps,
  };
  if (first && last && last.time > first.time) {
    result.speed = (last.x - first.x) / (last.time - first.time);
    const base = 4 * fields.width;
    const row = (source: Float32Array) => source.subarray(base, base + fields.width);
    const t = row(fields.t);
    result.reaction = frontAlongRow(fields, 4, 0.9) - frontAlongRow(fields, 4, 0.1);
    let peakAt = 0;
    for (let x = 0; x < t.length; x++) if (t[x]! > t[peakAt]!) peakAt = x;
    result.peak = t[peakAt]!;
    let ahead = peakAt;
    while (ahead < t.length - 1 && t[ahead]! > result.peak * 0.1) ahead++;
    let behind = peakAt;
    while (behind > 0 && t[behind]! > result.peak * 0.5) behind--;
    result.preheat = ahead - peakAt;
    result.tail = peakAt - behind;
  }
  sim.destroy();
  return result;
}

interface RoundFront {
  mean: number;
  /** (largest - smallest radius) / mean radius over 64 directions. */
  spread: number;
  /** Mean radius along the axes over mean radius along the diagonals. */
  axisOverDiagonal: number;
  time: number;
}

/** Radius of the burnt region around the centre in `rays` directions (fuel crossing 0.5). */
function radii(fields: Fields, rays = 64): number[] {
  const cx = (fields.width - 1) / 2;
  const cy = (fields.height - 1) / 2;
  const sample = (x: number, y: number) => {
    const x0 = Math.min(fields.width - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(fields.height - 2, Math.max(0, Math.floor(y)));
    const fx = x - x0;
    const fy = y - y0;
    const at = (ix: number, iy: number) => fields.f[iy * fields.width + ix]!;
    return (
      (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
      (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
    );
  };
  const out: number[] = [];
  const reach = Math.min(cx, cy) - 1;
  for (let ray = 0; ray < rays; ray++) {
    const angle = (ray / rays) * Math.PI * 2;
    let radius = 0;
    let before = sample(cx, cy);
    for (let r = 0.5; r <= reach; r += 0.5) {
      const value = sample(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      if (before <= 0.5 && value > 0.5) {
        radius = r - 0.5 + (0.5 * (0.5 - before)) / (value - before);
        break;
      }
      before = value;
    }
    out.push(radius);
  }
  return out;
}

function roundness(fields: Fields): Omit<RoundFront, 'time'> {
  const all = radii(fields);
  const mean = all.reduce((sum, r) => sum + r, 0) / all.length;
  const pick = (offset: number) => [0, 16, 32, 48].map((ray) => all[ray + offset]!);
  const average = (values: number[]) => values.reduce((sum, r) => sum + r, 0) / values.length;
  return {
    mean,
    spread: (Math.max(...all) - Math.min(...all)) / Math.max(mean, 1e-6),
    axisOverDiagonal: average(pick(0)) / Math.max(average(pick(8)), 1e-6),
  };
}

/** Lights the centre of a square of uniform fuel and runs until the front is `target` cells out. */
async function roundFront(
  device: GPUDevice,
  settings: CombustionSettings,
  options: { size?: number; target?: number; ember?: number; seconds?: number } = {},
): Promise<RoundFront & { history: { time: number; mean: number }[] }> {
  const size = options.size ?? 192;
  const target = options.target ?? size * 0.36;
  const sim = createCombustionSim(device, { width: size, height: size });
  sim.lay(UNIFORM);
  const clock = { time: 0 };
  const igniters = [tap(0.5, 0.5, (options.ember ?? 8) / size)];
  const history: { time: number; mean: number }[] = [];
  let shape = roundness(await readFields(device, sim));
  while (clock.time < (options.seconds ?? 60) && shape.mean < target) {
    run(device, sim, settings, 0.25, clock, { igniters });
    shape = roundness(await readFields(device, sim));
    history.push({ time: clock.time, mean: shape.mean });
  }
  sim.destroy();
  return { ...shape, time: clock.time, history };
}

/** How rough the temperature field is: mean |T - average of its four neighbours| over mean T. */
function roughness(fields: Fields): number {
  let rough = 0;
  let total = 0;
  for (let y = 1; y < fields.height - 1; y++) {
    for (let x = 1; x < fields.width - 1; x++) {
      const i = y * fields.width + x;
      const around =
        (fields.t[i - 1]! +
          fields.t[i + 1]! +
          fields.t[i - fields.width]! +
          fields.t[i + fields.width]!) /
        4;
      rough += Math.abs(fields.t[i]! - around);
      total += fields.t[i]!;
    }
  }
  return rough / Math.max(total, 1e-9);
}

/** Pure diffusion of a hot spot for `steps` sub-steps at a forced alpha. */
async function diffuseAt(
  device: GPUDevice,
  alpha: number,
  stencil: 5 | 9,
  steps = 240,
): Promise<{ rough: number; fields: Fields }> {
  const sim = createCombustionSim(device, { width: 48, height: 48 });
  sim.lay(UNIFORM);
  const settings: CombustionSettings = {
    ...BASE,
    // One sub-step per call with D dt = alpha.
    diffusion: alpha / STEP,
    rate: 0,
    cooling: 0,
    stencil,
  };
  const clock = { time: 0 };
  run(device, sim, settings, steps * STEP, clock, {
    igniters: [tap(0.5, 0.5, 0.1, 1)],
    hold: 2 * STEP,
    alphaMax: 1,
    maxSubsteps: 1,
  });
  const fields = await readFields(device, sim);
  sim.destroy();
  return { rough: roughness(fields), fields };
}

describe('planCombustion', () => {
  it('splits a step so that alpha never exceeds a quarter', () => {
    for (const diffusion of [0, 1, 14.9, 15, 15.1, 60, 119, 240, 1e4, 1e9]) {
      for (const seconds of [1 / 240, 1 / 120, STEP, 2 * STEP, 0.1]) {
        const plan = planCombustion(diffusion, seconds);
        expect(plan.alpha).toBeLessThanOrEqual(COMBUSTION_ALPHA_MAX + 1e-12);
        expect(plan.substeps).toBeGreaterThanOrEqual(1);
        expect(plan.substeps).toBeLessThanOrEqual(COMBUSTION_MAX_SUBSTEPS);
        expect(plan.dt * plan.substeps).toBeCloseTo(seconds, 10);
        // Either the diffusivity asked for is simulated, or the plan says it was lowered.
        if (!plan.clamped) expect(plan.diffusion).toBeCloseTo(diffusion, 6);
        else expect(plan.diffusion).toBeLessThan(diffusion);
      }
    }
  });

  it('takes one sub-step a step at the default diffusivity and no steps for no time', () => {
    expect(planCombustion(BASE.diffusion, STEP).substeps).toBe(1);
    expect(planCombustion(15, STEP).substeps).toBe(1);
    expect(planCombustion(15.1, STEP).substeps).toBe(2);
    expect(planCombustion(60, STEP).substeps).toBe(4);
    expect(planCombustion(60, STEP).alpha).toBeCloseTo(0.25, 10);
    expect(planCombustion(60, 2 * STEP).substeps).toBe(8);
    expect(planCombustion(60, 0).substeps).toBe(0);
    expect(planCombustion(Number.NaN, STEP).alpha).toBe(0);
    expect(planCombustion(1e6, STEP).clamped).toBe(true);
  });
});

describe('combustion: the model', () => {
  it('leaves cold, full ground exactly as it is', async () => {
    // Nothing is lit, so nothing may move: not through rounding on a GPU that truncates half
    // floats, and not through the random rounding that guards against it.
    const device = await getTestDevice();
    const sim = createCombustionSim(device, { width: 40, height: 24 });
    sim.lay(UNIFORM);
    run(device, sim, { ...BASE, regrow: 0.2 }, 30 * STEP, { time: 0 });
    const fields = await readFields(device, sim);
    expect(Math.max(...fields.t)).toBe(0);
    expect(Math.min(...fields.f)).toBe(1);
    expect(Math.max(...fields.f)).toBe(1);
    expect(Math.max(...fields.rate)).toBe(0);
    sim.destroy();
  });

  it('carries a front by itself, faster with more diffusion, and not at all when cooling wins', async () => {
    const device = await getTestDevice();
    const edge = [{ fromX: 0, fromY: 0, toX: 0, toY: 1, radius: 1.5, strength: 1.5 }];
    const speed = async (settings: CombustionSettings) => {
      const sim = createCombustionSim(device, { width: 128, height: 4 });
      sim.lay(UNIFORM);
      const clock = { time: 0 };
      run(device, sim, settings, 1.5, clock, { igniters: edge });
      const early = frontAlongRow(await readFields(device, sim), 2);
      run(device, sim, settings, 1.5, clock, { igniters: edge });
      const fields = await readFields(device, sim);
      sim.destroy();
      return { speed: (frontAlongRow(fields, 2) - early) / 1.5, fields };
    };
    // Measured on the development GPU: 11.1 cells/s at the defaults (D 14, k 6).
    const base = await speed(BASE);
    expect(base.speed).toBeGreaterThan(9.5);
    expect(base.speed).toBeLessThan(12.5);
    // The igniter let go after 0.2 s: what moves the front is its own heat, and it is hot.
    const peak = Math.max(...base.fields.t);
    expect(peak).toBeGreaterThan(0.6);
    expect(peak).toBeLessThan(BASE.release);
    // Behind the front the fuel is gone, ahead of it untouched.
    expect(base.fields.f[2 * 128 + 5]!).toBeLessThan(0.02);
    expect(base.fields.f[2 * 128 + 120]!).toBe(1);

    // Four times D: twice the speed, as sqrt(D k) says (a little more, the front being better resolved).
    const fast = await speed({ ...BASE, diffusion: 4 * BASE.diffusion });
    expect(fast.speed / base.speed).toBeGreaterThan(1.9);
    expect(fast.speed / base.speed).toBeLessThan(2.4);

    // Cooling at 3 per second takes heat away faster than the reaction supplies it: extinction.
    const dead = await speed({ ...BASE, cooling: 3 });
    expect(dead.speed).toBeLessThan(0.1);
    expect(Math.max(...dead.fields.t)).toBeLessThan(0.05);
    expect(dead.fields.f[2 * 128 + 60]!).toBe(1);
  });

  it('keeps a point-lit front close to a circle, closer with the 9-point Laplacian', async () => {
    const device = await getTestDevice();
    const settings = { ...BASE, diffusion: 7 };
    const nine = await roundFront(
      device,
      { ...settings, stencil: 9 },
      { size: 96, target: 30, ember: 6 },
    );
    const five = await roundFront(
      device,
      { ...settings, stencil: 5 },
      { size: 96, target: 30, ember: 6 },
    );
    expect(nine.mean).toBeGreaterThan(29);
    expect(five.mean).toBeGreaterThan(29);
    // Largest minus smallest radius, as a share of the mean, over 64 directions.
    expect(nine.spread).toBeLessThan(0.06);
    expect(nine.spread).toBeLessThan(five.spread * 0.8);
    // The front at the effect's default diffusivity is rounder still.
    const base = await roundFront(device, BASE, { size: 96, target: 30, ember: 6 });
    expect(base.spread).toBeLessThan(0.04);
  });

  it('grows fuel back at the stated rate even when one sub-step adds less than a half float holds', async () => {
    const device = await getTestDevice();
    const sim = createCombustionSim(device, { width: 32, height: 32 });
    // One huge front that has passed everywhere: no fuel, no heat.
    sim.lay({ ...UNIFORM, fronts: [[0.5, 0.5, 5]], peak: 0, heal: 1000 });
    let fields = await readFields(device, sim);
    expect(Math.max(...fields.f)).toBeLessThan(1e-3);
    // 16 sub-steps a step: each adds 0.02 / 960 = 2.1e-5, under the spacing of half floats
    // above 0.03 (3.1e-5). Rounded to nearest it would stall there; truncated, sooner.
    const settings = { ...BASE, diffusion: 240, regrow: 0.02 };
    expect(planCombustion(settings.diffusion, STEP).substeps).toBe(16);
    run(device, sim, settings, 3, { time: 0 });
    fields = await readFields(device, sim);
    const mean = fields.f.reduce((sum, value) => sum + value, 0) / fields.f.length;
    expect(mean).toBeGreaterThan(0.06 * 0.93);
    expect(mean).toBeLessThan(0.06 * 1.07);
    sim.destroy();
  });

  it('keeps the old fire when the fuel is laid again or the grid changes size', async () => {
    const device = await getTestDevice();
    const sim = createCombustionSim(device, { width: 48, height: 32 });
    sim.lay({ patchiness: 0, scale: 3, fronts: [[0.5, 0.5, 0.3]] });
    const before = await readFields(device, sim);
    const heat = (fields: Fields) =>
      fields.t.reduce((sum, value) => sum + value, 0) / fields.t.length;
    const fuel = (fields: Fields) =>
      fields.f.reduce((sum, value) => sum + value, 0) / fields.f.length;
    expect(heat(before)).toBeGreaterThan(0.02);
    expect(Math.min(...before.f)).toBeLessThan(0.05);

    sim.lay({ patchiness: 1, scale: 3 }, true);
    const relaid = await readFields(device, sim);
    expect(sim.generation).toBe(0);
    expect(heat(relaid)).toBeCloseTo(heat(before), 5);
    // The capacity is now patchy, and no cell holds more than its capacity.
    expect(Math.min(...relaid.capacity)).toBeLessThan(0.5);
    for (let i = 0; i < relaid.f.length; i++)
      expect(relaid.f[i]!).toBeLessThanOrEqual(relaid.capacity[i]!);

    const patchy = { patchiness: 1, scale: 3 };
    expect(sim.resize(48, 32, patchy)).toBe(false);
    expect(sim.resize(96, 64, patchy)).toBe(true);
    expect(sim.generation).toBe(1);
    expect([sim.width, sim.height]).toEqual([96, 64]);
    const resized = await readFields(device, sim);
    expect(heat(resized)).toBeGreaterThan(heat(before) * 0.9);
    expect(heat(resized)).toBeLessThan(heat(before) * 1.1);
    expect(fuel(resized)).toBeGreaterThan(fuel(relaid) * 0.95);
    expect(fuel(resized)).toBeLessThan(fuel(relaid) * 1.05);
    sim.destroy();
  });
});

describe('combustion: stability', () => {
  it('stays finite and inside its bounds at the extremes of every setting', async () => {
    const device = await getTestDevice();
    const extremes = {
      diffusion: [0, 1e6],
      release: [0, 100],
      rate: [0, 1e5],
      cooling: [0, 1e4],
      regrow: [0, 1e3],
      ignition: [0, 100],
      activation: [0, 1e3],
      kinetics: ['threshold', 'arrhenius'],
      stencil: [9, 5],
    } as const;
    const keys = Object.keys(extremes) as (keyof typeof extremes)[];
    // Every setting at each extreme with the others at their defaults, then mixed corners.
    const cases: CombustionSettings[] = [];
    for (const key of keys) {
      for (const value of extremes[key]) cases.push({ ...BASE, [key]: value });
    }
    let state = 99;
    const coin = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 31) as 0 | 1;
    for (let i = 0; i < 14; i++) {
      cases.push(Object.fromEntries(keys.map((key) => [key, extremes[key][coin()]])) as never);
    }
    cases.push({
      ...BASE,
      diffusion: Number.NaN,
      rate: Number.POSITIVE_INFINITY,
      cooling: Number.NaN,
    });

    const sim = createCombustionSim(device, { width: 40, height: 24 });
    const igniters = [tap(0.3, 0.5, 0.2, 1e6), tap(0.7, 0.5, 0.1, 1.5)];
    for (const settings of cases) {
      sim.lay({ patchiness: 1, scale: 4, fronts: [[0.6, 0.4, 0.25]], peak: 3 });
      run(device, sim, settings, 10 * STEP, { time: 0 }, { igniters, hold: 5 * STEP });
      const fields = await readFields(device, sim);
      const where = JSON.stringify(settings);
      for (const [name, field, high] of [
        ['T', fields.t, COMBUSTION_T_MAX],
        ['F', fields.f, 1],
        ['rate', fields.rate, 8],
      ] as const) {
        let low = Infinity;
        let top = -Infinity;
        let bad = 0;
        for (const value of field) {
          if (!Number.isFinite(value)) bad++;
          low = Math.min(low, value);
          top = Math.max(top, value);
        }
        expect(bad, `${name} not finite with ${where}`).toBe(0);
        expect(low, `${name} below 0 with ${where}`).toBeGreaterThanOrEqual(0);
        expect(top, `${name} above ${high} with ${where}`).toBeLessThanOrEqual(high);
      }
    }
    sim.destroy();
  });

  it('enforces a limit that is real: diffusion past it breaks into a checkerboard', async () => {
    const device = await getTestDevice();
    // At the limit the module allows, a hot spot spreads out smoothly with either stencil.
    for (const stencil of [9, 5] as const) {
      const safe = await diffuseAt(device, COMBUSTION_ALPHA_MAX, stencil, 120);
      expect(safe.rough).toBeLessThan(0.02);
      expect(Math.max(...safe.fields.t)).toBeLessThan(0.2);
    }
    // Theory: the 9-point scheme is stable to 3/8, the 5-point one to 1/4. Just past each, the
    // clamp to [0, T_MAX] is all that stops the numbers leaving the scale.
    const nine = await diffuseAt(device, 0.42, 9, 120);
    expect(nine.rough).toBeGreaterThan(0.5);
    const five = await diffuseAt(device, 0.3, 5, 120);
    expect(five.rough).toBeGreaterThan(0.5);
    // And the 9-point scheme really does hold between the two limits.
    const between = await diffuseAt(device, 0.34, 9, 120);
    expect(between.rough).toBeLessThan(0.02);
  });
});

describe('combustion-front: the effect', () => {
  it('sizes the grid by rows, with square cells and a cap on very wide canvases', () => {
    expect(gridSize(384, 16 / 9)).toEqual({ width: 683, height: 384 });
    expect(gridSize(256, 1)).toEqual({ width: 256, height: 256 });
    expect(gridSize(384, 9 / 19.5)).toEqual({ width: 177, height: 384 });
    // Six times wider than high: 1024 columns at most, so fewer rows.
    expect(gridSize(384, 6)).toEqual({ width: 1024, height: 171 });
    expect(gridSize(Number.NaN, 0)).toEqual({ width: 384, height: 384 });
    expect(REFERENCE_ROWS).toBe(384);
  });

  it('starts as a picture, lights where it is tapped, and counts grid changes', async () => {
    const mounted = await mountHeadless('combustion-front', {
      width: 96,
      height: 54,
      params: { view: 'temperature', embers: 0, grid: 192 },
    });
    const instance = mounted.instance as typeof mounted.instance & {
      readonly generation: number;
      readonly grid: { width: number; height: number } | undefined;
    };
    expect(instance.generation).toBe(0);
    expect(instance.grid).toMatchObject({ width: 341, height: 192 });

    // The diagnostic maps are opaque and plain: grey, 0.9 of the value before tonemapping.
    const at = (pixels: Uint8Array, x: number, y: number) =>
      pixels.subarray(
        (Math.floor(y * 54) * 96 + Math.floor(x * 96)) * 4,
        (Math.floor(y * 54) * 96 + Math.floor(x * 96)) * 4 + 4,
      );
    mounted.step(2);
    let pixels = await mounted.read();
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
    // Fronts are already burning, and the far corner is cold.
    expect(Math.max(...pixels.filter((_, i) => i % 4 === 0))).toBeGreaterThan(120);
    expect(at(pixels, 0.06, 0.1)[0]).toBeLessThan(4);

    // A tap in the cold corner: hot on the next step, and still burning after the finger is gone.
    sendPointer(mounted.canvas, 'pointerdown', 0.06, 0.1, 100);
    mounted.step(2);
    sendPointer(mounted.canvas, 'pointerup', 0.06, 0.1, 130);
    mounted.step(2);
    pixels = await mounted.read();
    expect(at(pixels, 0.06, 0.1)[0]).toBeGreaterThan(120);
    // Forty frames later the fuel where the finger was has burnt; elsewhere it is untouched.
    mounted.step(40);
    mounted.params.view = 'fuel';
    mounted.step(1);
    const fuel = await mounted.read();
    expect(at(fuel, 0.06, 0.1)[0]).toBeLessThan(40);
    expect(at(fuel, 0.06, 0.6)[0]).toBeGreaterThan(150);

    // A new grid size re-creates the textures (generation) and carries the fire across.
    mounted.params.grid = 256;
    mounted.step(1);
    expect(instance.generation).toBe(1);
    expect(instance.grid).toMatchObject({ width: 455, height: 256 });
    const after = await mounted.read();
    expect(at(after, 0.06, 0.1)[0]).toBeLessThan(40);
    expect(at(after, 0.06, 0.6)[0]).toBeGreaterThan(150);
    // The same shape again is not a new grid; another shape is.
    mounted.instance.resize(192, 108, 1);
    expect(instance.generation).toBe(1);
    mounted.instance.resize(96, 96, 1);
    expect(instance.generation).toBe(2);
    mounted.destroy();
  });

  it('takes every drive without a DOM and releases its listeners', async () => {
    const device = await getTestDevice();
    const effect = await loadEffect('combustion-front');
    const canvas = fakeCanvas(64, 36);
    let listeners = 0;
    const add = canvas.addEventListener.bind(canvas);
    const remove = canvas.removeEventListener.bind(canvas);
    canvas.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    }) as typeof canvas.addEventListener;
    canvas.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    }) as typeof canvas.removeEventListener;
    const params = defaultParams(effect.params) as Record<string, unknown>;
    const target = device.createTexture({
      size: [64, 36],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    await expectValid(device, async () => {
      const instance = await effect.create({
        device,
        format: 'rgba8unorm',
        canvas,
        params: params as never,
        profiler: noProfiler,
        hdr: false,
      });
      expect(listeners).toBeGreaterThan(0);
      instance.resize(64, 36, 1);
      for (const [frame, drive] of ['none', 'scroll', 'audio', 'none'].entries()) {
        params.drive = drive;
        const encoder = device.createCommandEncoder();
        instance.frame({ time: frame / 60, delta: 1 / 60, frame }, encoder, target.createView());
        device.queue.submit([encoder.finish()]);
      }
      instance.destroy();
    });
    expect(listeners).toBe(0);
    target.destroy();
  });
});

// The measurements quoted in the notes. Slow (minutes), so it only runs when asked.
describe.skipIf(!process.env.COMBUSTION_MEASURE)('combustion measurements', () => {
  vi.setConfig({ testTimeout: 3_600_000 });
  const which = (process.env.COMBUSTION_MEASURE ?? '').split(',');
  const wanted = (name: string) => which.includes('1') || which.includes(name);
  const fixed = (value: number, digits = 2) => value.toFixed(digits);
  const line = (label: string, front: PlaneFront, settings: CombustionSettings) =>
    console.log(
      `${label.padEnd(26)} v=${fixed(front.speed)} cells/s  v/sqrt(Dk)=${fixed(
        front.speed / Math.sqrt(settings.diffusion * settings.rate),
        3,
      )}  reaction=${fixed(front.reaction, 1)}  preheat=${front.preheat}  tail=${front.tail}  peak=${fixed(
        front.peak,
      )}  substeps=${front.substeps}`,
    );

  it.skipIf(!wanted('speed'))('front speed and width against D, Q and k', async () => {
    const device = await getTestDevice();
    const sweep = async (label: string, list: Partial<CombustionSettings>[]) => {
      console.log(`--- ${label}`);
      for (const change of list) {
        const settings = { ...BASE, ...change };
        line(JSON.stringify(change), await planeFront(device, settings), settings);
      }
    };
    await sweep(
      'D',
      [1.75, 3.5, 7, 14, 28, 56, 112, 224].map((diffusion) => ({ diffusion })),
    );
    await sweep(
      'k (C fixed at 0.6)',
      [1.5, 3, 6, 12, 24, 48].map((rate) => ({ rate })),
    );
    await sweep(
      'k (C / k fixed at 0.1)',
      [1.5, 3, 6, 12, 24, 48].map((rate) => ({ rate, cooling: rate * 0.1 })),
    );
    await sweep(
      'D and k together (C / k 0.1): same width, speed in proportion',
      [0.25, 0.5, 1, 2, 4].map((value) => ({
        diffusion: 14 * value,
        rate: 6 * value,
        cooling: 0.6 * value,
      })),
    );
    await sweep(
      'Q',
      [0.5, 0.6, 0.7, 0.8, 1, 1.25, 1.5, 2].map((release) => ({ release })),
    );
    await sweep(
      'ignition',
      [0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4].map((ignition) => ({ ignition })),
    );
    await sweep(
      'C',
      [0, 0.3, 0.6, 1.2, 1.8, 2.4, 3].map((cooling) => ({ cooling })),
    );
    await sweep(
      'thin fronts (D / k small, C / k 0.1)',
      [1, 0.5, 0.35, 0.25, 0.18, 0.12].map((ratio) => ({
        diffusion: 16 * ratio,
        rate: 16,
        cooling: 1.6,
      })),
    );
  });

  it.skipIf(!wanted('round'))('roundness of a point-lit front', async () => {
    const device = await getTestDevice();
    for (const [label, change] of [
      ['defaults (D / k = 2.3)', {}],
      ['D / k = 9.3', { diffusion: 56 }],
      ['D / k = 4.7', { diffusion: 28 }],
      ['D / k = 1.2', { diffusion: 7 }],
      ['D / k = 0.58', { diffusion: 3.5 }],
      ['D / k = 0.29', { diffusion: 1.75 }],
    ] as const) {
      for (const stencil of [9, 5] as const) {
        const settings = { ...BASE, ...change, stencil };
        const front = await roundFront(device, settings, { size: 256, target: 90 });
        console.log(
          `${label.padEnd(20)} ${stencil}-point: radius ${fixed(front.mean, 1)} at ${fixed(
            front.time,
          )} s, spread ${fixed(front.spread * 100, 2)}%, axis/diagonal ${fixed(front.axisOverDiagonal, 4)}`,
        );
      }
    }
  });

  it.skipIf(!wanted('curvature'))('a curved front is slower than a flat one', async () => {
    const device = await getTestDevice();
    const plane = await planeFront(device, BASE);
    const front = await roundFront(device, BASE, { size: 384, target: 150, ember: 8 });
    console.log(`plane front: ${fixed(plane.speed)} cells/s`);
    for (let i = 2; i < front.history.length; i += 2) {
      const a = front.history[i - 2]!;
      const b = front.history[i]!;
      const speed = (b.mean - a.mean) / (b.time - a.time);
      const radius = (a.mean + b.mean) / 2;
      console.log(
        `radius ${fixed(radius, 1)}: ${fixed(speed)} cells/s, deficit ${fixed(
          plane.speed - speed,
        )}, deficit x radius ${fixed((plane.speed - speed) * radius, 1)} (D = ${BASE.diffusion})`,
      );
    }
    for (const ember of [2, 3, 4, 5, 6, 8]) {
      const lit = await roundFront(device, BASE, { size: 128, target: 40, ember, seconds: 8 });
      console.log(
        `ember radius ${ember} cells: front at ${fixed(lit.mean, 1)} after ${fixed(lit.time)} s`,
      );
    }
  });

  it.skipIf(!wanted('pulse'))('does the front pulsate?', async () => {
    const device = await getTestDevice();
    // Speed of a plane front over time: position sampled every step, differenced over 0.1 s.
    const history = async (settings: CombustionSettings, seconds: number, length = 512) => {
      const sim = createCombustionSim(device, { width: length, height: 8 });
      sim.lay(UNIFORM);
      const clock = { time: 0 };
      const igniters = [{ fromX: 0, fromY: 0, toX: 0, toY: 1, radius: 1.25, strength: 1.5 }];
      const positions: number[] = [];
      const peaks: number[] = [];
      while (clock.time < seconds) {
        run(device, sim, settings, STEP, clock, { igniters, hold: 1 });
        const fields = await readFields(device, sim);
        const x = frontAlongRow(fields, 4);
        positions.push(x);
        let peak = 0;
        for (let i = Math.max(0, Math.floor(x) - 20); i < Math.min(length, x + 20); i++) {
          peak = Math.max(peak, fields.t[4 * length + i]!);
        }
        peaks.push(peak);
        if (x > length * 0.92) break;
      }
      sim.destroy();
      const speeds: number[] = [];
      for (let i = 6; i < positions.length; i++)
        speeds.push((positions[i]! - positions[i - 6]!) * 10);
      // Skip the start, where the igniter still drives the front.
      const from = Math.floor(speeds.length * 0.35);
      const part = speeds.slice(from);
      const hot = peaks.slice(from + 6);
      const mean = part.reduce((sum, v) => sum + v, 0) / Math.max(1, part.length);
      let crossings = 0;
      for (let i = 1; i < part.length; i++)
        if (part[i - 1]! < mean && part[i]! >= mean) crossings++;
      return {
        mean,
        low: Math.min(...part),
        high: Math.max(...part),
        hz: crossings / (part.length / 60),
        peakLow: Math.min(...hot),
        peakHigh: Math.max(...hot),
        reached: positions[positions.length - 1]!,
        time: clock.time,
      };
    };
    const report = async (label: string, settings: CombustionSettings, seconds = 40) => {
      const h = await history(settings, seconds);
      console.log(
        `${label.padEnd(44)} v=${fixed(h.mean)} [${fixed(h.low)} .. ${fixed(h.high)}] cells/s, ${fixed(
          h.hz,
        )} swings/s, peak T ${fixed(h.peakLow)} .. ${fixed(h.peakHigh)}, reached ${fixed(h.reached, 0)} in ${fixed(h.time, 1)} s`,
      );
    };
    await report('threshold, defaults', BASE);
    await report('threshold, near extinction (C 1.5)', { ...BASE, cooling: 1.5 });
    await report('threshold, near extinction (ignition 0.36)', { ...BASE, ignition: 0.36 });
    await report('threshold, thin (D 3.5)', { ...BASE, diffusion: 3.5 });
    for (const activation of [4, 6, 7, 8, 9, 10, 12]) {
      await report(
        `arrhenius beta ${activation}, k 24, no loss`,
        { ...BASE, kinetics: 'arrhenius', activation, rate: 24, cooling: 0 },
        60,
      );
    }
    for (const [cooling, rate, activation] of [
      [0.6, 6, 6],
      [0.6, 32, 6],
      [0.1, 32, 6],
      [0.1, 32, 8],
      [0.03, 32, 8],
      [0.03, 32, 9],
    ] as const) {
      await report(
        `arrhenius beta ${activation}, k ${rate}, C ${cooling}`,
        { ...BASE, kinetics: 'arrhenius', activation, rate, cooling },
        60,
      );
    }
  });

  it.skipIf(!wanted('kernel'))('can an ember light an Arrhenius front?', async () => {
    const device = await getTestDevice();
    for (const [activation, cooling] of [
      [6, 0.1],
      [8, 0.03],
      [8, 0],
      [9, 0],
    ] as const) {
      for (const ember of [8, 13, 20]) {
        const settings: CombustionSettings = {
          ...BASE,
          kinetics: 'arrhenius',
          activation,
          rate: 32,
          cooling,
        };
        const lit = await roundFront(device, settings, {
          size: 256,
          target: 90,
          ember,
          seconds: 30,
        });
        console.log(
          `beta ${activation}, C ${cooling}, ember ${ember} cells: radius ${fixed(lit.mean, 1)} after ${fixed(
            lit.time,
          )} s, spread ${fixed(lit.spread * 100, 1)}%`,
        );
      }
    }
  });

  it.skipIf(!wanted('stable'))('largest stable timestep', async () => {
    const device = await getTestDevice();
    for (const stencil of [9, 5] as const) {
      for (const alpha of [0.2, 0.25, 0.3, 0.34, 0.36, 0.37, 0.38, 0.39, 0.4, 0.45, 0.5]) {
        const { rough, fields } = await diffuseAt(device, alpha, stencil);
        const peak = fields.t.reduce((max, value) => Math.max(max, value), 0);
        console.log(
          `${stencil}-point alpha ${alpha}: roughness ${rough.toExponential(2)}, peak ${fixed(peak, 3)}`,
        );
      }
    }
  });
});
