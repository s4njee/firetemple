import { describe, expect, it, vi } from 'vitest';
import {
  createForestSim,
  forestGridSize,
  toHalf,
  FOREST_STEPS_PER_SUBMIT,
  type ForestLayout,
  type ForestSim,
  type ForestStepParams,
} from '../src/gpu/sim/forest.ts';
import { createAmbientIgnition, type Igniter } from '../src/gpu/sim/ignition.ts';
import { getTestDevice, readTexture } from './gpu.ts';
import { measureFlashes } from './flash.ts';
import { mountHeadless, sendPointer, writePng, type HeadlessEffect } from './headless.ts';
import { forestGrid, type ForestFireInstance } from '../src/effects/forest-fire/index.ts';

// Epic 5, story 5.5 (forest-fire automaton): the claims its notes make, as numbers. The automaton
// is driven directly (src/gpu/sim/forest.ts), on small grids and for a few hundred steps at most,
// so the file stays quick on a software rasteriser.
//
// The rule is probabilistic and its dice are compared with probabilities computed in floating
// point, so two drivers can take different branches from the same seed. Every expectation here is
// therefore about a shape or a total, with room for a different run of luck; only the
// repeatability test compares two runs cell for cell, and those are on the same device.

vi.setConfig({ testTimeout: 120_000 });

const FUEL = 0;
const BURNING = 1;
const SCORCH = 2;
const SMOKE = 3;

function halfToFloat(half: number): number {
  const exponent = (half >> 10) & 0x1f;
  const fraction = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

interface Forest {
  device: GPUDevice;
  sim: ForestSim;
  width: number;
  height: number;
  /** Runs `count` steps; `igniters(step)` supplies what each one is given. */
  run(count: number, params: ForestStepParams, igniters?: (step: number) => Igniter[]): void;
  /** The newest state as floats, four per cell, row by row from the top. */
  read(): Promise<Float32Array>;
  destroy(): void;
}

async function plant(
  width: number,
  height: number,
  options: { seed?: number; layout?: ForestLayout; terrain?: number } = {},
): Promise<Forest> {
  const device = await getTestDevice();
  const sim = createForestSim(device, {
    seed: options.seed ?? 1,
    layout: options.layout ?? 'full',
  });
  sim.reseed({ terrain: options.terrain ?? 0 });
  sim.resize(width, height);
  return {
    device,
    sim,
    width,
    height,
    run(count, params, igniters) {
      let done = 0;
      while (done < count) {
        const encoder = device.createCommandEncoder();
        const batch = Math.min(FOREST_STEPS_PER_SUBMIT, count - done);
        for (let i = 0; i < batch; i++) sim.step(encoder, params, igniters?.(sim.steps) ?? []);
        device.queue.submit([encoder.finish()]);
        done += batch;
      }
    },
    async read() {
      const bytes = await readTexture(device, sim.current.texture, 8);
      const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      return Float32Array.from(halves, halfToFloat);
    },
    destroy: () => sim.destroy(),
  };
}

/** A tap at the middle of the grid, in the first step only. */
const tapAt =
  (x: number, y: number, radius: number) =>
  (step: number): Igniter[] =>
    step === 0 ? [{ fromX: x, fromY: y, toX: x, toY: y, radius, strength: 1 }] : [];

const CALM: ForestStepParams = { growth: 0, spread: 1, wind: 0, windAngle: 0, aspect: 1 };

const channel = (state: Float32Array, index: number) =>
  Float32Array.from({ length: state.length / 4 }, (_, cell) => state[cell * 4 + index]!);

const sum = (values: ArrayLike<number>) => {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i]!;
  return total;
};

/** Cells that have burnt or are burning. */
const burntMask = (state: Float32Array) =>
  Uint8Array.from({ length: state.length / 4 }, (_, cell) =>
    state[cell * 4 + SCORCH]! > 0.05 || state[cell * 4 + BURNING]! > 0 ? 1 : 0,
  );

/**
 * How far the burnt area reaches from (cx, cy) in each of `sectors` equal wedges, as the radius
 * of a wedge of a disc with the same area. Wedge 0 is centred on +x (right), and they run
 * anticlockwise as seen on screen (wedge sectors/4 is up).
 */
function reach(mask: Uint8Array, width: number, cx: number, cy: number, sectors: number): number[] {
  const area = new Float64Array(sectors);
  const height = mask.length / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const dx = x + 0.5 - cx;
      const dy = cy - (y + 0.5);
      const turn = Math.atan2(dy, dx) / (2 * Math.PI);
      area[((Math.round(turn * sectors) % sectors) + sectors) % sectors]! += 1;
    }
  }
  return Array.from(area, (cells) => Math.sqrt((2 * cells * sectors) / (2 * Math.PI)));
}

/** A picture of a state for looking at: fuel green, burning red, scorch blue. */
function dump(path: string, state: Float32Array, width: number): void {
  const cells = state.length / 4;
  const rgb = new Uint8Array(cells * 3);
  for (let cell = 0; cell < cells; cell++) {
    rgb[cell * 3] = Math.min(255, state[cell * 4 + BURNING]! * 400);
    rgb[cell * 3 + 1] = state[cell * 4 + FUEL]! * 200;
    rgb[cell * 3 + 2] = state[cell * 4 + SCORCH]! * 160 + state[cell * 4 + SMOKE]! * 90;
  }
  writePng(path, width, cells / width, rgb);
}

const mean = (values: readonly number[]) => sum(values) / values.length;

/** How far the burnt area reaches right, left, up and down the screen from (cx, cy), in cells. */
function extents(mask: Uint8Array, width: number, cx: number, cy: number): number[] {
  const out = [0, 0, 0, 0];
  const height = mask.length / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      out[0] = Math.max(out[0]!, x + 0.5 - cx);
      out[1] = Math.max(out[1]!, cx - (x + 0.5));
      out[2] = Math.max(out[2]!, cy - (y + 0.5));
      out[3] = Math.max(out[3]!, y + 0.5 - cy);
    }
  }
  return out;
}

describe('forestGridSize', () => {
  it('puts the asked number of cells on the shorter side and keeps the aspect', () => {
    expect(forestGridSize(1920, 1080, 180)).toEqual([320, 180]);
    expect(forestGridSize(1080, 1920, 180)).toEqual([180, 320]);
    expect(forestGridSize(500, 500, 64)).toEqual([64, 64]);
    // The same aspect at another pixel size is the same grid, so a zoom does not restart the fire.
    expect(forestGridSize(960, 540, 180)).toEqual(forestGridSize(3840, 2160, 180));
    // A very wide band is capped on its long side.
    expect(forestGridSize(40_000, 100, 200)[0]).toBe(2048);
  });
});

const burningCells = (state: Float32Array) => {
  let count = 0;
  for (let cell = 0; cell < state.length / 4; cell++) if (state[cell * 4 + BURNING]! > 0) count++;
  return count;
};

describe('toHalf', () => {
  it('writes what the GPU reads back', () => {
    for (const value of [0, 1, 0.5, 0.1, 0.3333, 0.0001, 0.99951171875]) {
      expect(halfToFloat(toHalf(value))).toBeCloseTo(value, 3);
    }
    // A mantissa that rounds up carries into the exponent rather than wrapping.
    expect(halfToFloat(toHalf(0.99999))).toBe(1);
  });
});

describe('forest automaton', () => {
  it('burns a round fire when there is no wind, not a diamond or a square', async () => {
    const sectors = new Array<number>(8).fill(0);
    const seeds = [1, 2];
    for (const seed of seeds) {
      const forest = await plant(96, 96, { seed });
      forest.run(80, CALM, tapAt(0.5, 0.5, 0.02));
      reach(burntMask(await forest.read()), 96, 48, 48, 8).forEach(
        (r, index) => (sectors[index]! += r / seeds.length),
      );
      forest.destroy();
    }
    const average = mean(sectors);
    // Far enough to be a shape rather than the tap, not so far that it reached the edge.
    expect(average).toBeGreaterThan(25);
    expect(average).toBeLessThan(44);
    for (const r of sectors) expect(Math.abs(r / average - 1)).toBeLessThan(0.1);
    // Along the grid's axes against along its diagonals: a diamond or a square would differ by
    // tens of percent.
    const axes = mean([sectors[0]!, sectors[2]!, sectors[4]!, sectors[6]!]);
    const diagonals = mean([sectors[1]!, sectors[3]!, sectors[5]!, sectors[7]!]);
    expect(Math.abs(axes / diagonals - 1)).toBeLessThan(0.06);
  });

  it('runs downwind, backs slowly upwind, and spreads equally to both flanks', async () => {
    const at = async (wind: number, windAngle: number) => {
      const forest = await plant(160, 80, { seed: 3 });
      forest.run(40, { ...CALM, wind, windAngle, aspect: 2 }, tapAt(0.25, 0.5, 0.025));
      const extent = extents(burntMask(await forest.read()), 160, 40, 40);
      forest.destroy();
      return extent;
    };
    const [calmRight, calmLeft] = await at(0, 0);
    expect(Math.abs(calmRight! / calmLeft! - 1)).toBeLessThan(0.2);

    const [head, back, up, down] = await at(1, 0);
    expect(head!).toBeGreaterThan(2.2 * calmRight!);
    expect(head!).toBeGreaterThan(3 * back!);
    expect(back!).toBeLessThan(calmLeft!);
    expect(Math.abs(up! / down! - 1)).toBeLessThan(0.2);
    // An ellipse along the wind: longer than it is wide.
    expect((head! + back!) / (up! + down!)).toBeGreaterThan(1.4);

    // A moderate wind shapes the fire less.
    const [midHead] = await at(0.5, 0);
    expect(midHead!).toBeGreaterThan(calmRight!);
    expect(midHead!).toBeLessThan(head!);
  });

  it('takes the wind direction as where the wind blows to: a quarter turn is up the screen', async () => {
    const forest = await plant(64, 128, { seed: 4 });
    forest.run(
      40,
      { ...CALM, wind: 1, windAngle: Math.PI / 2, aspect: 0.5 },
      tapAt(0.5, 0.75, 0.02),
    );
    const [right, left, up, down] = extents(burntMask(await forest.read()), 64, 32, 96);
    forest.destroy();
    expect(up!).toBeGreaterThan(2 * down!);
    expect(Math.abs(right! / left! - 1)).toBeLessThan(0.25);
  });

  it('puts every fire out: a burning cell burns down to nothing within a bounded time', async () => {
    // No spread: each cell the tap lit burns on its own fuel and must go out.
    const lone = await plant(32, 32);
    lone.run(1, { ...CALM, spread: 0 }, tapAt(0.5, 0.5, 0.1));
    expect(burningCells(await lone.read())).toBeGreaterThan(10);
    lone.run(24, { ...CALM, spread: 0 });
    expect(burningCells(await lone.read())).toBe(0);
    lone.destroy();

    // A fire that sweeps the whole map ends too, and leaves it consumed.
    const forest = await plant(48, 48);
    forest.run(200, CALM, tapAt(0.5, 0.5, 0.05));
    const state = await forest.read();
    expect(burningCells(state)).toBe(0);
    const fuel = channel(state, FUEL);
    expect(sum(fuel) / fuel.length).toBeLessThan(0.1);
    for (const value of state) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of state) expect(value).toBeLessThanOrEqual(1);
    forest.destroy();
  });

  it('keeps fuel within 0..1 and grows it back after a fire, as the scorch fades', async () => {
    const forest = await plant(48, 48);
    forest.run(200, CALM, tapAt(0.5, 0.5, 0.05));
    const burnt = await forest.read();
    const scorchBefore = sum(channel(burnt, SCORCH));
    forest.run(120, { ...CALM, growth: 0.02 });
    const grown = await forest.read();
    const fuel = channel(grown, FUEL);
    expect(sum(fuel) / fuel.length).toBeGreaterThan(sum(channel(burnt, FUEL)) / fuel.length + 0.4);
    expect(Math.max(...fuel)).toBeLessThanOrEqual(1);
    expect(Math.min(...fuel)).toBeGreaterThanOrEqual(0);
    expect(sum(channel(grown, SCORCH))).toBeLessThan(0.5 * scorchBefore);
    expect(burningCells(grown)).toBe(0);
    forest.destroy();
  });

  it('cannot cross a firebreak without spotting, and spotting cannot cross a wide one', async () => {
    const crossed = async (gap: number, wind: number) => {
      const forest = await plant(96, 48, { seed: 5 });
      forest.sim.paint(48, 0, gap, 48, [0, 0, 0, 0]);
      forest.run(160, { ...CALM, wind, aspect: 2 }, tapAt(0.3, 0.5, 0.04));
      const mask = burntMask(await forest.read());
      forest.destroy();
      let beyond = 0;
      for (let y = 0; y < 48; y++) for (let x = 48 + gap; x < 96; x++) beyond += mask[y * 96 + x]!;
      let before = 0;
      for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) before += mask[y * 96 + x]!;
      return { before, beyond };
    };
    const narrowCalm = await crossed(1, 0);
    expect(narrowCalm.before).toBeGreaterThan(48 * 30);
    expect(narrowCalm.beyond).toBe(0);
    // Strong wind throws embers two cells: a one-cell break no longer holds...
    expect((await crossed(1, 1)).beyond).toBeGreaterThan(200);
    // ...but a three-cell one does.
    expect((await crossed(3, 1)).beyond).toBe(0);
  });

  it('only catches where there is fuel', async () => {
    const forest = await plant(32, 32, { layout: 'empty' });
    forest.run(4, CALM, (step) => tapAt(0.5, 0.5, 0.2)(step % 1));
    expect(burningCells(await forest.read())).toBe(0);
    forest.destroy();
  });

  it('repeats a run exactly from the same seed, and differs with another', async () => {
    const run = async (seed: number) => {
      const forest = await plant(64, 48, { seed, layout: 'landscape', terrain: 0.6 });
      const lightning = createAmbientIgnition({ rate: 3, radius: 0.04, seed: 9 });
      forest.run(
        60,
        { ...CALM, growth: 0.01, wind: 0.6, windAngle: 1, aspect: 64 / 48, terrain: 0.6 },
        () => lightning.collect(1 / 15),
      );
      const state = await forest.read();
      forest.destroy();
      return state;
    };
    const a = await run(7);
    const b = await run(7);
    const c = await run(8);
    expect(burningCells(a)).toBeGreaterThan(0);
    let same = 0;
    let differ = 0;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]! - b[i]!) < 1e-5) same++;
      if (Math.abs(a[i]! - c[i]!) > 1e-3) differ++;
    }
    expect(same).toBe(a.length);
    expect(differ).toBeGreaterThan(a.length / 10);
  });

  it('bumps the generation when the grid is re-created, and only then', async () => {
    const forest = await plant(32, 32);
    const generation = forest.sim.generation;
    expect(forest.sim.resize(32, 32)).toBe(false);
    expect(forest.sim.generation).toBe(generation);
    expect(forest.sim.resize(40, 30)).toBe(true);
    expect(forest.sim.generation).toBe(generation + 1);
    expect([forest.sim.width, forest.sim.height]).toEqual([40, 30]);
    forest.destroy();
  });
});

describe('forest-fire effect', () => {
  it('never draws a cell smaller than two pixels', () => {
    expect(forestGrid(1920, 1080, 180)).toEqual([320, 180]);
    // A thumbnail: 135 pixels high holds at most 67 cells.
    expect(forestGrid(240, 135, 180)).toEqual([119, 67]);
    expect(forestGrid(1080, 1920, 180)).toEqual([180, 320]);
  });

  it('starts a fire where it is tapped, and releases its listeners when destroyed', async () => {
    const burningNear = async (mounted: HeadlessEffect, x: number, y: number) => {
      const forest = (mounted.instance as ForestFireInstance).forest;
      const bytes = await readTexture(mounted.device, forest.current.texture, 8);
      const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const cx = Math.floor(x * forest.width);
      const cy = Math.floor(y * forest.height);
      let total = 0;
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          total += halfToFloat(halves[((cy + dy) * forest.width + cx + dx) * 4 + BURNING]!);
        }
      }
      return total;
    };
    // No lightning, and a map with the same fuel everywhere, so only the tap can light anything.
    const options = { width: 320, height: 180, params: { lightning: 0, terrain: 0 } };
    const tapped = await mountHeadless('forest-fire', options);
    const instance = tapped.instance as ForestFireInstance;
    instance.forest.paint(0, 0, instance.forest.width, instance.forest.height, [1, 0, 0, 0]);
    expect(instance.generation).toBeGreaterThan(0);
    sendPointer(tapped.canvas, 'pointerdown', 0.4, 0.6, 0);
    sendPointer(tapped.canvas, 'pointerup', 0.4, 0.6, 30);
    await tapped.runTo(0.5);
    expect(await burningNear(tapped, 0.4, 0.6)).toBeGreaterThan(1);
    tapped.destroy();
    // A destroyed effect hears nothing: the next tap must not throw or reach the GPU.
    expect(() => sendPointer(tapped.canvas, 'pointerdown', 0.5, 0.5, 60)).not.toThrow();
  });
});

const study = process.env.FOREST_STUDY ?? '';

describe.skipIf(!study.includes('shape'))('study: shape of a fire', () => {
  it('prints reach by direction without wind', async () => {
    for (const spread of [0.6, 1, 1.5]) {
      const rows: number[][] = [];
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const forest = await plant(160, 160, { seed });
        forest.run(
          Math.round(110 / Math.sqrt(spread)),
          { ...CALM, spread },
          tapAt(0.5, 0.5, 0.012),
        );
        rows.push(reach(burntMask(await forest.read()), 160, 80, 80, 16));
        forest.destroy();
      }
      const sectors = rows[0]!.map((_, index) => mean(rows.map((row) => row[index]!)));
      console.log(`spread ${spread}: ${sectors.map((r) => r.toFixed(1)).join(' ')}`);
    }
  });

  it('prints head, flank and back with wind', async () => {
    for (const wind of [0, 0.25, 0.5, 0.75, 1]) {
      const steps = 60;
      const out = [0, 0, 0, 0];
      const seeds = [1, 2, 3, 4];
      for (const seed of seeds) {
        const forest = await plant(240, 120, { seed });
        forest.run(steps, { ...CALM, wind, aspect: 2 }, tapAt(0.25, 0.5, 0.02));
        const state = await forest.read();
        if (seed === 1) dump(`output/shots/forest-shape-wind${wind}.png`, state, 240);
        const extent = extents(burntMask(state), 240, 60, 60);
        extent.forEach((value, index) => (out[index]! += value / seeds.length));
        forest.destroy();
      }
      const [head, back, up, down] = out as [number, number, number, number];
      console.log(
        `wind ${wind}: head ${head.toFixed(1)} back ${back.toFixed(1)} flanks ${up.toFixed(1)} ${down.toFixed(1)} cells in ${steps} steps; length/width ${((head + back) / (up + down)).toFixed(2)}`,
      );
    }
  });
});

/**
 * Follows fires through a run: burning cells that touch (within two cells, so a spot fire belongs
 * to the fire that threw it) are one fire, and a fire keeps its identity from one snapshot to the
 * next through the cells still burning. Returns the number of cells each finished fire burnt.
 */
function createFireTracker(width: number, height: number) {
  const parent: number[] = [];
  const size: number[] = [];
  const find = (id: number): number => {
    while (parent[id]! !== id) {
      parent[id] = parent[parent[id]!]!;
      id = parent[id]!;
    }
    return id;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    parent[rb] = ra;
    size[ra]! += size[rb]!;
    size[rb] = 0;
    return ra;
  };
  let owner = new Int32Array(width * height).fill(-1);
  const alive = new Set<number>();
  const finished: number[] = [];
  const stack: number[] = [];

  return {
    finished,
    get burningFires() {
      return alive.size;
    },
    add(state: Float32Array) {
      const next = new Int32Array(width * height).fill(-1);
      const seen = new Set<number>();
      for (let start = 0; start < width * height; start++) {
        if (next[start]! !== -1 || !(state[start * 4 + BURNING]! > 0)) continue;
        // Flood one fire of this snapshot.
        const cells: number[] = [];
        let id = -1;
        stack.push(start);
        next[start] = -2;
        while (stack.length) {
          const cell = stack.pop()!;
          cells.push(cell);
          if (owner[cell]! >= 0) id = id < 0 ? find(owner[cell]!) : union(id, owner[cell]!);
          const cx = cell % width;
          const cy = (cell - cx) / width;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const x = cx + dx;
              const y = cy + dy;
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              const other = y * width + x;
              if (next[other]! !== -1 || !(state[other * 4 + BURNING]! > 0)) continue;
              next[other] = -2;
              stack.push(other);
            }
          }
        }
        if (id < 0) {
          id = parent.length;
          parent.push(id);
          size.push(0);
        }
        let fresh = 0;
        for (const cell of cells) {
          if (owner[cell]! < 0) fresh++;
          next[cell] = id;
        }
        size[find(id)]! += fresh;
        seen.add(id);
      }
      const roots = new Set([...seen].map(find));
      for (const id of alive) {
        const root = find(id);
        if (!roots.has(root)) {
          if (size[root]! > 0) finished.push(size[root]!);
          size[root] = 0;
        }
      }
      alive.clear();
      for (const root of roots) alive.add(root);
      for (let cell = 0; cell < next.length; cell++) {
        if (next[cell]! >= 0) next[cell] = find(next[cell]!);
      }
      owner = next;
    },
  };
}

interface Regime {
  name: string;
  growth: number;
  lightning: number;
  spread?: number;
  wind?: number;
  terrain?: number;
  rate?: number;
}

/** A long run with lightning, as the effect drives it: 15 steps a second on a 16 : 9 grid. */
async function regime(setup: Regime, seconds: number, grid: [number, number] = [320, 180]) {
  const [width, height] = grid;
  const rate = setup.rate ?? 15;
  const terrain = setup.terrain ?? 0.6;
  const forest = await plant(width, height, { layout: 'landscape', terrain });
  const lightning = createAmbientIgnition({
    rate: setup.lightning,
    radius: 1.6 / height,
    seed: 1,
  });
  const params: ForestStepParams = {
    growth: setup.growth / rate,
    spread: setup.spread ?? 1,
    wind: setup.wind ?? 0.3,
    windAngle: (20 * Math.PI) / 180,
    aspect: width / height,
    terrain,
  };
  const tracker = createFireTracker(width, height);
  const total = Math.round(seconds * rate);
  const warm = Math.round(total / 3);
  let strikes = 0;
  let fuel = 0;
  let burning = 0;
  let samples = 0;
  let quiet = 0;
  const every = 3;
  for (let step = 0; step < total; step += every) {
    forest.run(every, params, () => {
      const igniters = lightning.collect(1 / rate);
      if (step >= warm) strikes += igniters.length;
      return igniters;
    });
    const state = await forest.read();
    tracker.add(state);
    if (step === warm) tracker.finished.length = 0;
    if (step >= warm) {
      let f = 0;
      let b = 0;
      for (let cell = 0; cell < width * height; cell++) {
        f += state[cell * 4 + FUEL]!;
        if (state[cell * 4 + BURNING]! > 0) b++;
      }
      fuel += f / (width * height);
      burning += b / (width * height);
      if (b === 0) quiet++;
      samples++;
    }
    if (setup.name && step + every >= total) {
      dump(`output/shots/forest-regime-${setup.name.replace(/\W+/g, '-')}.png`, state, width);
    }
  }
  forest.destroy();
  const sizes = [...tracker.finished].sort((a, b) => a - b);
  const cells = width * height;
  const bins = new Array<number>(18).fill(0);
  for (const s of sizes) bins[Math.min(17, Math.floor(Math.log2(s)))]!++;
  return {
    name: setup.name,
    fires: sizes.length,
    strikes,
    meanCells: sizes.length ? sum(sizes) / sizes.length : 0,
    medianCells: sizes[Math.floor(sizes.length / 2)] ?? 0,
    largestShare: (sizes.at(-1) ?? 0) / cells,
    burntSharePerMinute: sum(sizes) / cells / ((total - warm) / rate / 60),
    meanFuel: fuel / samples,
    burningShare: burning / samples,
    quietShare: quiet / samples,
    log2Histogram: bins.join(' '),
  };
}

describe.skipIf(!study.includes('regime'))('study: fire sizes against growth and lightning', () => {
  const setups: Regime[] = JSON.parse(process.env.FOREST_REGIMES ?? '[]') as Regime[];
  it.each(setups.map((setup) => [setup.name, setup] as const))('%s', async (_name, setup) => {
    const result = await regime(setup, Number(process.env.FOREST_SECONDS ?? 300));
    console.log(`regime ${JSON.stringify(result)}`);
  });
});

describe.skipIf(!study.includes('flash'))('study: flashes after the system has organised', () => {
  const cases: [string, string | undefined, Record<string, unknown>][] = [
    ['defaults', undefined, {}],
    ['all sizes', 'all sizes', {}],
    ['windy day', 'windy day', {}],
    ['fastest', undefined, { rate: 40, spread: 2, wind: 1, lightning: 4 }],
    ['pixelated', undefined, { pixelated: true, rate: 40 }],
  ];
  it.each(cases)('%s', async (_name, preset, params) => {
    const report = await measureFlashes('forest-fire', { preset, params, settle: 90, seconds: 6 });
    console.log(`flash ${_name}: ${JSON.stringify(report)}`);
  });
});
