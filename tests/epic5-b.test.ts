import { describe, expect, it, vi } from 'vitest';
import type { BurnFrontInstance } from '../src/effects/burn-front/index.ts';
import { emberRegion } from '../src/effects/burn-front/index.ts';
import {
  demoRects,
  fuelBounds,
  openingSpot,
  type DomFuelInstance,
} from '../src/effects/dom-fuel/index.ts';
import { loadEffect } from '../src/effects/registry.ts';
import { defaultParams } from '../src/effects/types.ts';
import type { ObstacleRect } from '../src/gpu/dom-rects.ts';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import { noProfiler } from '../src/gpu/profiler.ts';
import {
  BURN_CODE,
  BURN_MAX_CELLS_PER_STEP,
  BURN_MAX_STEPS,
  BURN_NEVER,
  BURN_STEP_SECONDS,
  burnGridSize,
  burnStepValues,
  createBurnSim,
  type BurnSettings,
  type BurnSim,
} from '../src/gpu/sim/burn.ts';
import type { Igniter } from '../src/gpu/sim/ignition.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { fakeCanvas, mountHeadless, sendPointer } from './headless.ts';

// Epic 5, stories 5.3 and 5.4: the burn-front solver (src/gpu/sim/burn.ts) and the two effects
// built on it, burning paper (burn-front) and the page as fuel (dom-fuel).

vi.setConfig({ testTimeout: 120_000 });

/** Fuel everywhere (and well past the edges, so the edges are not fuel boundaries). */
const FULL: ObstacleRect[] = [{ x: -0.5, y: -0.5, width: 2, height: 2 }];
const EVEN: BurnSettings = { speed: 0.2, irregular: 0, burnTime: 0.3, crumble: 0 };

interface Grid {
  width: number;
  height: number;
  /** fuel, heat, char, clock per cell. */
  data: Float32Array;
}

async function readGrid(device: GPUDevice, texture: GPUTexture): Promise<Grid> {
  const bytes = await readTexture(device, texture, 8);
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return { width: texture.width, height: texture.height, data: Float32Array.from(half, fromHalf) };
}

const readState = (device: GPUDevice, sim: BurnSim) => readGrid(device, sim.state.texture);

const at = (grid: Grid, x: number, y: number, channel: number) =>
  grid.data[(y * grid.width + x) * 4 + channel]!;
/** The cell under a point in canvas uv. */
const cellAt = (grid: Grid, u: number, v: number): [number, number] => [
  Math.min(grid.width - 1, Math.floor(u * grid.width)),
  Math.min(grid.height - 1, Math.floor(v * grid.height)),
];
const litAt = (grid: Grid, u: number, v: number) => at(grid, ...cellAt(grid, u, v), 3) <= 0;
const fuelAt = (grid: Grid, u: number, v: number) => at(grid, ...cellAt(grid, u, v), 0);

function expectFinite(grid: Grid) {
  for (const value of grid.data) expect(Number.isFinite(value)).toBe(true);
}

const tap = (x: number, y: number, radius = 0.04): Igniter => ({
  fromX: x,
  fromY: y,
  toX: x,
  toY: y,
  radius,
  strength: 1,
});

function makeSim(device: GPUDevice, width: number, height: number, rects = FULL, grain = 5) {
  const sim = createBurnSim(device, { label: 'test burn', grain });
  sim.resize(width, height);
  sim.setRects(rects);
  return sim;
}

/** Runs `steps` single steps; `igniters` are there for the first step only, like a tap. */
async function run(
  device: GPUDevice,
  sim: BurnSim,
  settings: BurnSettings,
  steps: number,
  igniters: readonly Igniter[] = [],
) {
  let done = 0;
  while (done < steps) {
    const encoder = device.createCommandEncoder();
    const batch = Math.min(BURN_MAX_STEPS, steps - done);
    for (let i = 0; i < batch; i++) sim.step(encoder, settings, done + i === 0 ? igniters : []);
    device.queue.submit([encoder.finish()]);
    done += batch;
    if (done % 240 === 0) await device.queue.onSubmittedWorkDone();
  }
  await device.queue.onSubmittedWorkDone();
}

/** Runs the solver as an effect does (fixed steps plus the regrowth bookkeeping) for `seconds`. */
async function advance(
  device: GPUDevice,
  sim: BurnSim,
  settings: BurnSettings,
  seconds: number,
  igniters: readonly Igniter[] = [],
) {
  const frame = BURN_STEP_SECONDS * BURN_MAX_STEPS;
  const pending = [...igniters];
  for (let t = 0; t < seconds - 1e-9; t += frame) {
    const encoder = device.createCommandEncoder();
    sim.advance(encoder, frame, settings, [{ collect: () => pending.splice(0), destroy() {} }]);
    device.queue.submit([encoder.finish()]);
    if (Math.round(t / frame) % 60 === 0) await device.queue.onSubmittedWorkDone();
  }
  await device.queue.onSubmittedWorkDone();
}

/** Lit cells from the centre outwards along a direction (dx, dy), until the first unlit one. */
function litRun(grid: Grid, cx: number, cy: number, dx: number, dy: number): number {
  let n = 0;
  for (;;) {
    const x = cx + dx * (n + 1);
    const y = cy + dy * (n + 1);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return n;
    if (at(grid, x, y, 3) > 0) return n;
    n++;
  }
}

describe('burn solver: grid and limits', () => {
  it('puts `cells` on the shorter side, keeps the aspect, and caps the long side', () => {
    expect(burnGridSize(1920, 1080, 256)).toEqual([455, 256]);
    expect(burnGridSize(390, 844, 256)).toEqual([195, 422]);
    // Never finer than two pixels a cell.
    expect(burnGridSize(160, 90, 256)).toEqual([80, 45]);
    expect(burnGridSize(20000, 100, 256)[0]).toBe(2048);
  });

  it('caps the front at most of a cell per step, and keeps the lighting window inside exact ages', () => {
    const fast = burnStepValues({ speed: 10 }, 256);
    expect(BURN_STEP_SECONDS / fast.tau_min).toBeCloseTo(BURN_MAX_CELLS_PER_STEP, 5);
    const slow = burnStepValues({ speed: 0.001 }, 64);
    expect(slow.window).toBeLessThanOrEqual(15);
    expect(slow.tau_max * Math.SQRT2).toBeLessThan(slow.window);
    // The window always outlasts the slowest crossing it allows, diagonals included.
    for (const speed of [0.005, 0.05, 0.3]) {
      const v = burnStepValues({ speed, climb: 2 }, 200);
      expect(v.tau_max * Math.SQRT2 * 1.1).toBeLessThan(v.window);
    }
  });
});

describe('burn solver: the front', () => {
  it('spreads at the speed it is given, the same in every direction', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 129, 129);
    const seconds = 2;
    await run(device, sim, EVEN, seconds / BURN_STEP_SECONDS, [tap(0.5, 0.5)]);
    const grid = await readState(device, sim);
    expectFinite(grid);
    // Lit at once within half the igniter's radius, then `speed` canvas heights a second.
    const expected = (0.02 + EVEN.speed * seconds) * 129;
    const axis = [litRun(grid, 64, 64, 1, 0), litRun(grid, 64, 64, -1, 0)];
    axis.push(litRun(grid, 64, 64, 0, 1), litRun(grid, 64, 64, 0, -1));
    const diagonal = [1, -1].flatMap((dx) => [1, -1].map((dy) => litRun(grid, 64, 64, dx, dy)));
    const knight = litRun(grid, 64, 64, 2, 1) * Math.sqrt(5);
    for (const r of axis) expect(Math.abs(r - expected) / expected).toBeLessThan(0.06);
    for (const r of diagonal) {
      expect(Math.abs(r * Math.SQRT2 - expected) / expected).toBeLessThan(0.06);
    }
    expect(Math.abs(knight - expected) / expected).toBeLessThan(0.07);
    // No grid axis is favoured: axis and diagonal radii agree to a few percent.
    const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
    expect(Math.abs(mean(axis) - mean(diagonal) * Math.SQRT2) / mean(axis)).toBeLessThan(0.04);
    sim.destroy();
  });

  it('reaches a distant point after a plausible time and not before', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 160, 90);
    // From (0.1, 0.5) to (0.9, 0.5): 0.8 of the width is 1.42 canvas heights on a 16:9 grid.
    const distance = 0.8 * (160 / 90) - 0.02;
    const arrival = distance / EVEN.speed;
    await run(device, sim, EVEN, Math.round((arrival * 0.9) / BURN_STEP_SECONDS), [tap(0.1, 0.5)]);
    let grid = await readState(device, sim);
    expect(litAt(grid, 0.9, 0.5)).toBe(false);
    // ...but the front is on its way: the clock there counts down to the arrival.
    expect(at(grid, ...cellAt(grid, 0.9, 0.5), 3)).toBeLessThan(arrival * 0.2);
    await run(device, sim, EVEN, Math.round((arrival * 0.2) / BURN_STEP_SECONDS));
    grid = await readState(device, sim);
    expect(litAt(grid, 0.9, 0.5)).toBe(true);
    expectFinite(grid);
    sim.destroy();
  });

  it('moves in canvas heights, so the grid resolution does not change its speed', async () => {
    const device = await getTestDevice();
    const radii: number[] = [];
    for (const size of [64, 160]) {
      const sim = makeSim(device, size, size);
      await run(device, sim, EVEN, 90, [tap(0.5, 0.5, 0.05)]);
      const grid = await readState(device, sim);
      const c = size / 2;
      radii.push((litRun(grid, c, c, 1, 0) + 0.5) / size);
      sim.destroy();
    }
    expect(Math.abs(radii[0]! - radii[1]!) / radii[1]!).toBeLessThan(0.1);
  });

  it('is irregular where the noise says, and climbs faster than it falls', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 128, 128, FULL, 6);
    /** Radius of the lit region along 32 directions, max over min. */
    const spread = (grid: Grid) => {
      const radii = Array.from({ length: 32 }, (_, i) => {
        const angle = (i / 32) * Math.PI * 2;
        const lit = (r: number) =>
          at(grid, Math.round(64 + Math.cos(angle) * r), Math.round(64 + Math.sin(angle) * r), 3) <=
          0;
        let r = 0;
        while (r < 63 && lit(r + 1)) r++;
        return r;
      });
      return Math.max(...radii) / Math.min(...radii);
    };
    await run(device, sim, { ...EVEN, irregular: 0 }, 150, [tap(0.5, 0.5)]);
    const even = spread(await readState(device, sim));
    sim.reset();
    await run(device, sim, { ...EVEN, irregular: 1 }, 150, [tap(0.5, 0.5)]);
    const ragged = spread(await readState(device, sim));
    // A round front on even fuel (to the cell the radius is counted in), a ragged one on noise.
    expect(even).toBeLessThan(1.08);
    expect(ragged).toBeGreaterThan(1.15);
    sim.reset();

    await run(device, sim, { ...EVEN, climb: 2 }, 90, [tap(0.5, 0.5)]);
    const grid = await readState(device, sim);
    const up = litRun(grid, 64, 64, 0, -1);
    const down = litRun(grid, 64, 64, 0, 1);
    const side = litRun(grid, 64, 64, 1, 0);
    expect(up).toBeGreaterThan(side * 1.5);
    expect(down).toBeLessThan(side * 0.75);
    sim.destroy();
  });
});

describe('burn solver: fuel', () => {
  it('only ever consumes fuel, never below zero, and turns exactly that into char', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 96, 64);
    const settings: BurnSettings = { speed: 0.15, irregular: 1, burnTime: 0.4, crumble: 0 };
    let previous = await readState(device, sim);
    for (let round = 0; round < 12; round++) {
      await run(device, sim, settings, 20, round === 0 ? [tap(0.3, 0.6), tap(0.8, 0.2)] : []);
      const grid = await readState(device, sim);
      expectFinite(grid);
      for (let i = 0; i < grid.width * grid.height; i++) {
        const fuel = grid.data[i * 4]!;
        const char = grid.data[i * 4 + 2]!;
        expect(fuel).toBeGreaterThanOrEqual(0);
        expect(fuel).toBeLessThanOrEqual(previous.data[i * 4]!);
        // With nothing crumbling, fuel and char add up to what there was (to the random walk of
        // their separately rounded half-float steps).
        expect(Math.abs(fuel + char - 1)).toBeLessThan(0.03);
      }
      previous = grid;
    }
    // Something burnt.
    expect(Math.min(...Array.from({ length: 96 * 64 }, (_, i) => previous.data[i * 4]!))).toBe(0);
    sim.destroy();
  });

  it('does not light burnt-out cells again until they regrow', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 64, 64);
    const settings: BurnSettings = { ...EVEN, speed: 0.3 };
    await run(device, sim, settings, 6 * 60, [tap(0.5, 0.5)]);
    let grid = await readState(device, sim);
    for (let i = 0; i < 64 * 64; i++) {
      expect(grid.data[i * 4]).toBe(0);
      expect(grid.data[i * 4 + 3]).toBeLessThanOrEqual(-BURN_CODE);
    }
    // Taps on ash do nothing.
    await run(device, sim, settings, 30, [tap(0.3, 0.3, 0.1), tap(0.7, 0.6, 0.1)]);
    grid = await readState(device, sim);
    expectFinite(grid);
    for (let i = 0; i < 64 * 64; i++) {
      expect(grid.data[i * 4]).toBe(0);
      expect(grid.data[i * 4 + 1]).toBeLessThan(0.01);
      expect(grid.data[i * 4 + 3]).toBeLessThanOrEqual(-BURN_CODE);
    }
    sim.destroy();
  });

  it('regrows cell by cell a fixed time after each burnt out, also past 32 seconds', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 48, 48);
    const regrow = 40;
    const settings: BurnSettings = { ...EVEN, speed: 0.5, regrowth: 'each cell', regrow };
    await advance(device, sim, settings, 3, [tap(0.5, 0.5)]);
    const burnt = await readState(device, sim);
    expect(fuelAt(burnt, 0.5, 0.5)).toBe(0);
    await advance(device, sim, settings, regrow - 5);
    let grid = await readState(device, sim);
    for (let i = 0; i < 48 * 48; i++) expect(grid.data[i * 4]).toBe(0);
    await advance(device, sim, settings, 8);
    grid = await readState(device, sim);
    for (let i = 0; i < 48 * 48; i++) {
      expect(grid.data[i * 4]).toBe(1);
      expect(grid.data[i * 4 + 3]).toBe(BURN_NEVER);
    }
    // And it burns again.
    await run(device, sim, settings, 30, [tap(0.5, 0.5)]);
    expect(litAt(await readState(device, sim), 0.5, 0.5)).toBe(true);
    sim.destroy();
  });

  it('regrows everything at once only when everything has burnt out, after the pause', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 64, 40);
    const regrow = 36;
    const settings: BurnSettings = { ...EVEN, speed: 0.12, regrowth: 'all burnt', regrow };
    // Crossing 1.6 canvas heights at 0.12 takes over 10 seconds: nothing may regrow meanwhile,
    // though the first cells burnt out long ago.
    await advance(device, sim, settings, 9, [tap(0.05, 0.5)]);
    let grid = await readState(device, sim);
    expect(fuelAt(grid, 0.05, 0.5)).toBe(0);
    expect(fuelAt(grid, 0.98, 0.5)).toBeGreaterThan(0);
    // All burnt by about 14 s; still bare just before the pause ends...
    await advance(device, sim, settings, 5 + regrow - 2);
    grid = await readState(device, sim);
    for (let i = 0; i < 64 * 40; i++) expect(grid.data[i * 4]).toBe(0);
    // ...and whole again shortly after it (the fade-in takes 1.5 s).
    await advance(device, sim, settings, 6);
    grid = await readState(device, sim);
    for (let i = 0; i < 64 * 40; i++) expect(grid.data[i * 4]).toBe(1);
    expectFinite(grid);
    sim.destroy();
  });
});

describe('burn solver: gaps and moving fuel', () => {
  const left: ObstacleRect = { x: 0.04, y: 0.1, width: 0.4, height: 0.8 };
  // A gap of 0.12 canvas heights on a square grid.
  const right: ObstacleRect = { x: 0.56, y: 0.1, width: 0.4, height: 0.8 };

  it.each([
    [0, false],
    [0.08, false],
    [0.18, true],
  ])('with a jump of %f, a gap of 0.12 is crossed: %s', async (jump, crosses) => {
    const device = await getTestDevice();
    const sim = makeSim(device, 96, 96, [left, right]);
    await run(device, sim, { ...EVEN, speed: 0.25, jump }, 8 * 60, [tap(0.1, 0.5)]);
    const grid = await readState(device, sim);
    expectFinite(grid);
    expect(fuelAt(grid, 0.2, 0.5)).toBe(0);
    expect(fuelAt(grid, 0.8, 0.5)).toBe(crosses ? 0 : 1);
    // The fire is only ever carried within half the jump of the fuel, never further out.
    const map = await readGrid(device, sim.map.texture);
    for (let i = 0; i < 96 * 96; i++) {
      if (map.data[i * 4]! > jump / 2 + 0.5 / 96) expect(grid.data[i * 4 + 3]).toBe(BURN_NEVER);
    }
    sim.destroy();
  });

  it('keeps what has burnt when the fuel moves, and does not relight it', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 96, 96, [left]);
    await run(device, sim, { ...EVEN, speed: 0.3 }, 5 * 60, [tap(0.2, 0.5)]);
    const before = await readState(device, sim);
    expect(fuelAt(before, 0.2, 0.5)).toBe(0);
    // A layout change: the element moves right and grows, over fresh space and its own ash.
    sim.setRects([{ x: 0.24, y: 0.1, width: 0.6, height: 0.8 }]);
    await run(device, sim, { ...EVEN, speed: 0.3 }, 3 * 60);
    const after = await readState(device, sim);
    expectFinite(after);
    // Burnt cells are still burnt, and nothing caught from them.
    expect(fuelAt(after, 0.3, 0.5)).toBe(0);
    expect(at(after, ...cellAt(after, 0.3, 0.5), 3)).toBeLessThanOrEqual(-BURN_CODE);
    expect(fuelAt(after, 0.7, 0.5)).toBe(1);
    expect(litAt(after, 0.7, 0.5)).toBe(false);
    sim.destroy();
  });

  it('carries the state over a resize and bumps the generation', async () => {
    const device = await getTestDevice();
    const sim = makeSim(device, 80, 60);
    await run(device, sim, { ...EVEN, speed: 0.3 }, 60, [tap(0.3, 0.5)]);
    const generation = sim.generation;
    expect(sim.resize(160, 120)).toBe(true);
    expect(sim.resize(160, 120)).toBe(false);
    expect(sim.generation).toBe(generation + 1);
    const grid = await readState(device, sim);
    expect(grid.width).toBe(160);
    expect(fuelAt(grid, 0.3, 0.5)).toBe(0);
    expect(fuelAt(grid, 0.9, 0.5)).toBe(1);
    sim.destroy();
  });
});

describe('burn-front', () => {
  it('starts as a whole sheet with real coverage, and a tap lights it where it lands', async () => {
    const mounted = await mountHeadless('burn-front', {
      width: 160,
      height: 90,
      params: { embers: 0, origin: 'centre' },
    });
    const instance = mounted.instance as BurnFrontInstance;
    mounted.step(1);
    const first = await mounted.read();
    let opaque = 0;
    for (let i = 3; i < first.length; i += 4) if (first[i] === 255) opaque++;
    expect(opaque).toBe(160 * 90);

    sendPointer(mounted.canvas, 'pointerdown', 0.85, 0.25, 20);
    sendPointer(mounted.canvas, 'pointerup', 0.85, 0.25, 40);
    await mounted.runTo(1.5);
    const grid = await readState(mounted.device, instance.sim);
    expect(litAt(grid, 0.85, 0.25)).toBe(true);
    // The opening spark lit the centre; the far corner is untouched.
    expect(litAt(grid, 0.5, 0.5)).toBe(true);
    expect(fuelAt(grid, 0.05, 0.95)).toBe(1);

    await mounted.runTo(8);
    const later = await mounted.read();
    let holes = 0;
    for (let i = 3; i < later.length; i += 4) if (later[i] === 0) holes++;
    expect(holes).toBeGreaterThan(100);
    mounted.destroy();
  });

  it('starts its embers where the origin says', () => {
    expect(emberRegion('centre', 0)).toEqual([0.48, 0.46, 0.52, 0.54]);
    const bottom = emberRegion('bottom edge', 0.1);
    expect(bottom[1]).toBeGreaterThan(0.8);
    expect(emberRegion('anywhere', 0)[0]).toBeCloseTo(0.04, 5);
  });
});

describe('dom-fuel', () => {
  it('falls back to its stand-in rectangles without a DOM, and burns only there', async () => {
    const mounted = await mountHeadless('dom-fuel', { width: 192, height: 108 });
    const instance = mounted.instance as DomFuelInstance;
    await mounted.runTo(4);
    expect(instance.demo).toBe(true);
    expect(instance.rects).toEqual(demoRects(192 / 108));
    const grid = await readState(mounted.device, instance.sim);
    const map = await readGrid(mounted.device, instance.sim.map.texture);
    let burning = 0;
    for (let i = 0; i < grid.width * grid.height; i++) {
      // Lit cells are fuel or bridges: never further from an element than half the jump.
      if (grid.data[i * 4 + 3]! <= 0) {
        burning++;
        expect(map.data[i * 4]!).toBeLessThan(28 / 108 / 2 + 1e-3);
      }
    }
    expect(burning).toBeGreaterThan(20);
    mounted.destroy();
  });

  it('helps embers land on fuel and starts the fire at the foot of the largest element', () => {
    const rects = demoRects(16 / 9);
    const [x0, y0, x1, y1] = fuelBounds(rects);
    expect([x0, y0, x1, y1].every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(x1 - x0).toBeGreaterThan(0.8);
    const [x, y] = openingSpot(rects);
    const largest = rects[1]!;
    expect(x).toBeGreaterThan(largest.x);
    expect(y).toBeGreaterThan(largest.y + largest.height / 2);
    expect(fuelBounds([])).toEqual([0, 0, 1, 1]);
    // A portrait canvas gets its own arrangement.
    expect(demoRects(0.5).every((r) => r.x + r.width <= 1 && r.y + r.height <= 1)).toBe(true);
  });
});

describe.each(['burn-front', 'dom-fuel'])('%s lifecycle', (id) => {
  it('runs with every drive and releases every listener it added', async () => {
    const device = await getTestDevice();
    const effect = await loadEffect(id);
    const target = device.createTexture({
      size: [64, 48],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    for (const drive of ['none', 'scroll', 'audio']) {
      const canvas = fakeCanvas(64, 48);
      let listening = 0;
      const add = canvas.addEventListener.bind(canvas);
      const remove = canvas.removeEventListener.bind(canvas);
      canvas.addEventListener = (...args: Parameters<typeof add>) => {
        listening++;
        add(...args);
      };
      canvas.removeEventListener = (...args: Parameters<typeof remove>) => {
        listening--;
        remove(...args);
      };
      await expectValid(device, async () => {
        const instance = await effect.create({
          device,
          format: 'rgba8unorm',
          canvas,
          params: { ...defaultParams(effect.params), drive },
          profiler: noProfiler,
          hdr: false,
        });
        instance.resize(64, 48, 1);
        for (let frame = 0; frame < 4; frame++) {
          const encoder = device.createCommandEncoder();
          instance.frame({ time: frame / 60, delta: 1 / 60, frame }, encoder, target.createView());
          device.queue.submit([encoder.finish()]);
        }
        instance.destroy();
      });
      expect(listening).toBe(0);
    }
    target.destroy();
  });
});
