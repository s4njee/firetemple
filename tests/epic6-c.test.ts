import { describe, expect, it, vi } from 'vitest';
import type { FireHazeInstance } from '../src/effects/fire-haze/index.ts';
import {
  BURNER_Y,
  burnerTongues,
  shapesFromObstacles,
  standInRects,
  testShapes,
  type FireObstaclesInstance,
} from '../src/effects/fire-obstacles/index.ts';
import type { ObstacleRect } from '../src/gpu/dom-rects.ts';
import { createFluid, halfToFloat, type Fluid } from '../src/gpu/sim/fluid.ts';
import { createObstacleShapes, type ObstacleShape } from '../src/gpu/sim/obstacle-shapes.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless } from './headless.ts';

// Epic 6, stories 6.8 (fire-obstacles) and 6.9 (fire-haze): the claims of their notes as numbers.
// Solids hold no flow, a plume goes round a plate rather than through it, a moved element moves the
// mask without resetting the gas, and the haze's displacement is zero in cold air and bounded in hot.
// GPU floats are compared loosely (Mesa's software rasteriser in CI), and no test relies on a sign
// of zero.

vi.setConfig({ testTimeout: 120_000 });

// --- Readback -------------------------------------------------------------------------------------

async function readHalf(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const bytes = await readTexture(device, texture, 8);
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, texture.width * texture.height * 4);
  const out = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) out[i] = halfToFloat(half[i]!);
  return out;
}

interface Snapshot {
  width: number;
  height: number;
  dyeWidth: number;
  dyeHeight: number;
  solid: (i: number, j: number) => boolean;
  /** Staggered velocity: u on the left face of cell (i, j), v on its top face. */
  u: (i: number, j: number) => number;
  v: (i: number, j: number) => number;
  fields: Float32Array;
  dye: Float32Array;
  /** The sim cell a dye texel lies in (fluid-core.wgsl's dye_cell). */
  dyeCell: (x: number, y: number) => [number, number];
}

async function snapshot(device: GPUDevice, fluid: Fluid): Promise<Snapshot> {
  await device.queue.onSubmittedWorkDone();
  const g = fluid.grid;
  const mask = await readTexture(device, fluid.obstacles.texture, 1);
  const velocity = await readHalf(device, fluid.velocity.texture);
  const fields = await readHalf(device, fluid.fields);
  const dye = await readHalf(device, fluid.dye.texture);
  return {
    width: g.width,
    height: g.height,
    dyeWidth: g.dyeWidth,
    dyeHeight: g.dyeHeight,
    solid: (i, j) => fluid.obstacles.enabled && mask[j * g.width + i]! >= 128,
    u: (i, j) => velocity[(j * g.velocityWidth + i) * 4]!,
    v: (i, j) => velocity[(j * g.velocityWidth + i) * 4 + 1]!,
    fields,
    dye,
    dyeCell: (x, y) => [
      Math.min(Math.floor(((x + 0.5) * g.width) / g.dyeWidth), g.width - 1),
      Math.min(Math.floor(((y + 0.5) * g.height) / g.dyeHeight), g.height - 1),
    ],
  };
}

/** Mean of dye channel `c` over a uv box. */
function dyeMean(s: Snapshot, box: [number, number, number, number], c = 0): number {
  const [x0, y0, x1, y1] = box;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * s.dyeHeight); y < Math.ceil(y1 * s.dyeHeight); y++) {
    for (let x = Math.floor(x0 * s.dyeWidth); x < Math.ceil(x1 * s.dyeWidth); x++) {
      sum += s.dye[(y * s.dyeWidth + x) * 4 + c]!;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

function dyeTotal(s: Snapshot, c = 0): number {
  let sum = 0;
  for (let k = c; k < s.dye.length; k += 4) sum += s.dye[k]!;
  return sum;
}

/** Everything the solids are supposed to hold at zero; returns the largest magnitude found and how many solid cells there were. */
function insideSolids(s: Snapshot): { cells: number; flow: number; fields: number; dye: number } {
  let cells = 0;
  let flow = 0;
  let fields = 0;
  for (let j = 0; j < s.height; j++) {
    for (let i = 0; i < s.width; i++) {
      if (!s.solid(i, j)) continue;
      cells++;
      flow = Math.max(
        flow,
        Math.abs(s.u(i, j)),
        Math.abs(s.u(i + 1, j)),
        Math.abs(s.v(i, j)),
        Math.abs(s.v(i, j + 1)),
      );
      for (let c = 0; c < 4; c++) {
        fields = Math.max(fields, Math.abs(s.fields[(j * s.width + i) * 4 + c]!));
      }
    }
  }
  let dye = 0;
  for (let y = 0; y < s.dyeHeight; y++) {
    for (let x = 0; x < s.dyeWidth; x++) {
      const [i, j] = s.dyeCell(x, y);
      if (!s.solid(i, j)) continue;
      for (let c = 0; c < 4; c++)
        dye = Math.max(dye, Math.abs(s.dye[(y * s.dyeWidth + x) * 4 + c]!));
    }
  }
  return { cells, flow, fields, dye };
}

function maxSpeed(s: Snapshot): number {
  let top = 0;
  for (let j = 0; j < s.height; j++) {
    for (let i = 0; i < s.width; i++) {
      top = Math.max(top, Math.abs(s.u(i, j)), Math.abs(s.v(i, j)));
    }
  }
  return top;
}

// --- 6.8: the plume and the solids, on the solver directly -------------------------------------

/** A plume on a square 64-cell grid, with or without solids, stepped one submit at a time. */
async function runPlume(
  device: GPUDevice,
  shapes: readonly ObstacleShape[],
  steps: number,
): Promise<{ fluid: Fluid; snap: Snapshot }> {
  const fluid = createFluid({
    device,
    resolution: 64,
    dyeResolution: 128,
    params: {
      boundary: 'open',
      buoyancy: 3,
      buoyancyWeights: [1, 0, 0, 0],
      dyeDissipation: [0.3, 0, 0, 0],
      velocityDissipation: 0.3,
    },
  });
  const solids = createObstacleShapes({ device, fluid });
  solids.set(shapes);
  for (let k = 0; k < steps; k++) {
    const encoder = device.createCommandEncoder();
    solids.rasterize(encoder);
    fluid.addDye([0.5, 0.86], [0.5, 0.86], 0.05, [0.12, 0, 0, 0]);
    fluid.addForce([0.5, 0.86], [0.5, 0.86], 0.05, [0, -0.02]);
    fluid.advance(encoder, 1);
    device.queue.submit([encoder.finish()]);
  }
  const snap = await snapshot(device, fluid);
  solids.destroy();
  return { fluid, snap };
}

describe('fire-obstacles: solids in the solver', () => {
  const plate: ObstacleShape = {
    kind: 'rounded-box',
    x: 0.5,
    y: 0.5,
    size: [0.16, 0.035],
    radius: 0.01,
  };

  it('holds no flow, no field and no gas inside the solids', async () => {
    const device = await getTestDevice();
    const { fluid, snap } = await expectValid(device, () =>
      runPlume(device, [plate, { kind: 'circle', x: 0.25, y: 0.3, size: [0.08, 0.08] }], 90),
    );
    const inside = insideSolids(snap);
    expect(inside.cells).toBeGreaterThan(50);
    expect(inside.flow).toBeLessThan(1e-5);
    expect(inside.fields).toBeLessThan(1e-5);
    expect(inside.dye).toBeLessThan(1e-5);
    // ...while the gas around them moves.
    expect(maxSpeed(snap)).toBeGreaterThan(0.1);
    fluid.destroy();
  });

  it('sends the plume round a plate, not through it', async () => {
    const device = await getTestDevice();
    const blocked = await runPlume(device, [plate], 120);
    const free = await runPlume(device, [], 120);
    // At the plate's height: the middle column (where the plate is) and the two strips beside it.
    const middle: [number, number, number, number] = [0.42, 0.47, 0.58, 0.53];
    const under: [number, number, number, number] = [0.4, 0.54, 0.6, 0.6];
    const over: [number, number, number, number] = [0.4, 0.4, 0.6, 0.46];
    const left: [number, number, number, number] = [0.18, 0.44, 0.33, 0.56];
    const right: [number, number, number, number] = [0.67, 0.44, 0.82, 0.56];
    const beside = (s: Snapshot) => 0.5 * (dyeMean(s, left) + dyeMean(s, right));
    if (process.env.EPIC6C_MEASURE) {
      for (const [name, s] of [
        ['blocked', blocked.snap],
        ['free', free.snap],
      ] as const) {
        console.log(name, {
          middle: dyeMean(s, middle),
          under: dyeMean(s, under),
          over: dyeMean(s, over),
          left: dyeMean(s, left),
          right: dyeMean(s, right),
        });
      }
    }
    // Without the plate the plume rises straight up the middle...
    expect(dyeMean(free.snap, middle)).toBeGreaterThan(0.05);
    expect(dyeMean(free.snap, over)).toBeGreaterThan(0.05);
    expect(beside(free.snap)).toBeLessThan(0.01);
    // ...with it, nothing is in the plate or has come through it, the gas pools under it and the
    // heat has gone round both ends.
    expect(dyeMean(blocked.snap, middle)).toBeLessThan(1e-4);
    expect(dyeMean(blocked.snap, over)).toBeLessThan(0.5 * dyeMean(free.snap, over));
    expect(dyeMean(blocked.snap, under)).toBeGreaterThan(1.5 * dyeMean(free.snap, under));
    expect(dyeMean(blocked.snap, left)).toBeGreaterThan(0.05);
    expect(dyeMean(blocked.snap, right)).toBeGreaterThan(0.05);
    blocked.fluid.destroy();
    free.fluid.destroy();
  });

  it('turns page rectangles and test shapes into solver shapes', () => {
    const rects = standInRects(16 / 9);
    const shapes = shapesFromObstacles(
      rects.map((rect) => ({ rect })),
      16 / 9,
    );
    expect(shapes).toHaveLength(rects.length);
    for (const [k, shape] of shapes.entries()) {
      const rect = rects[k]!;
      expect(shape.kind).toBe('rounded-box');
      expect(shape.x).toBeCloseTo(rect.x + rect.width / 2, 6);
      expect(shape.size[1]).toBeCloseTo(rect.height / 2, 6);
    }
    for (const set of ['card row', 'circle', 'slanted plate'] as const) {
      expect(testShapes(set, 16 / 9).length).toBeGreaterThan(0);
    }
  });
});

describe('fire-obstacles: the burner', () => {
  const aspect = 16 / 9;
  it('spreads tongues over the burner width', () => {
    const tongues = burnerTongues(0.7, aspect, []);
    expect(tongues.length).toBeGreaterThanOrEqual(10);
    for (const { x } of tongues) expect(Math.abs(x - 0.5)).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(burnerTongues(0.05, aspect, []).length).toBe(3);
  });

  it('moves the burner beside an element that covers it, not under it', () => {
    // An article over the middle of the canvas that runs off its bottom edge.
    const article = shapesFromObstacles(
      [{ rect: { x: 0.14, y: 0.05, width: 0.72, height: 1, radius: 0.01 } }],
      aspect,
    );
    const tongues = burnerTongues(0.7, aspect, article);
    expect(tongues.length).toBeGreaterThan(2);
    for (const { x } of tongues) expect(x < 0.14 || x > 0.86).toBe(true);
    expect(tongues.some(({ x }) => x < 0.14)).toBe(true);
    expect(tongues.some(({ x }) => x > 0.86)).toBe(true);
    // A card that only covers part of the line just loses the tongues under it.
    const card = shapesFromObstacles(
      [{ rect: { x: 0.4, y: 0.6, width: 0.2, height: BURNER_Y + 0.01 - 0.6 } }],
      aspect,
    );
    const partial = burnerTongues(0.7, aspect, card);
    expect(partial.length).toBeGreaterThan(4);
    for (const { x } of partial) expect(x < 0.4 || x > 0.6).toBe(true);
    for (const { x } of partial) expect(Math.abs(x - 0.5)).toBeLessThanOrEqual(0.35 + 1e-9);
  });
});

// --- 6.8: the effect follows the layout ------------------------------------------------------

describe('fire-obstacles: the effect', () => {
  const cellOf = (fluid: Fluid, x: number, y: number): [number, number] => [
    Math.floor(x * fluid.grid.width),
    Math.floor(y * fluid.grid.height),
  ];

  it('re-rasterises a moved rectangle without resetting the flow', async () => {
    const mounted = await mountHeadless('fire-obstacles', {
      width: 192,
      height: 108,
      params: { resolution: '96', embers: 0 },
    });
    const { device } = mounted;
    const instance = mounted.instance as FireObstaclesInstance;
    const fluid = instance.fluid;
    const a: ObstacleRect = { x: 0.15, y: 0.45, width: 0.25, height: 0.2, radius: 0.02 };
    const b: ObstacleRect = { x: 0.6, y: 0.45, width: 0.25, height: 0.2, radius: 0.02 };
    instance.layout([a]);
    await expectValid(device, async () => {
      mounted.step(20);
    });
    const generation = fluid.generation;
    const before = await snapshot(device, fluid);
    expect(before.solid(...cellOf(fluid, 0.27, 0.55))).toBe(true);
    expect(before.solid(...cellOf(fluid, 0.72, 0.55))).toBe(false);
    const heatBefore = dyeTotal(before);
    expect(heatBefore).toBeGreaterThan(0);

    instance.layout([b]);
    mounted.step(1);
    const after = await snapshot(device, fluid);
    // The mask moved...
    expect(after.solid(...cellOf(fluid, 0.27, 0.55))).toBe(false);
    expect(after.solid(...cellOf(fluid, 0.72, 0.55))).toBe(true);
    // ...the grids were not re-created, the gas is still there and still moving...
    expect(fluid.generation).toBe(generation);
    expect(dyeTotal(after)).toBeGreaterThan(0.6 * heatBefore);
    expect(maxSpeed(after)).toBeGreaterThan(0.5 * maxSpeed(before));
    // ...and the new solid holds none of it.
    const inside = insideSolids(after);
    expect(inside.flow).toBeLessThan(1e-5);
    expect(inside.dye).toBeLessThan(1e-5);
    mounted.destroy();
  });

  it('uses stand-in rectangles when there is no page', async () => {
    const mounted = await mountHeadless('fire-obstacles', {
      width: 160,
      height: 90,
      params: { resolution: '96' },
    });
    mounted.step(2);
    const instance = mounted.instance as FireObstaclesInstance;
    expect(instance.demo).toBe(true);
    expect(instance.rects.length).toBe(standInRects(16 / 9).length);
    expect(instance.fluid.obstacles.enabled).toBe(true);
    mounted.params.shapes = 'circle';
    mounted.step(1);
    expect(instance.demo).toBe(false);
    expect(instance.shapes.count).toBe(1);
    mounted.destroy();
  });
});

// --- 6.9: the haze displacement ----------------------------------------------------------------

const srgbToLinear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

describe('fire-haze: displacement from the gas', () => {
  it('is zero where the gas is cold and bounded by the strength where it is hot', async () => {
    // A narrow source in the middle, no wisps and no pointer: the sides stay cold.
    const mounted = await mountHeadless('fire-haze', {
      width: 192,
      height: 108,
      params: {
        view: 'displacement',
        resolution: '96',
        sourceWidth: 0.15,
        embers: 0,
        strength: 1,
      },
    });
    await expectValid(mounted.device, () => mounted.runTo(0.5));
    const rgba = await mounted.read();
    let cold = 0;
    let coldWorst = 0;
    let hot = 0;
    let bent = 0;
    let largest = 0;
    let coldAtSides = 0;
    for (let y = 0; y < 108; y++) {
      for (let x = 0; x < 192; x++) {
        const k = (y * 192 + x) * 4;
        // 0.5 is no displacement and 0.25 is one `strength` (shimmer.wgsl's displacement view).
        const sx = (srgbToLinear(rgba[k]!) - 0.5) / 0.25;
        const sy = (srgbToLinear(rgba[k + 1]!) - 0.5) / 0.25;
        const mask = srgbToLinear(rgba[k + 2]!);
        const length = Math.hypot(sx, sy);
        if (mask === 0) {
          cold++;
          coldWorst = Math.max(coldWorst, length);
          if (x < 30 || x > 162) coldAtSides++;
        } else {
          hot++;
          largest = Math.max(largest, length);
          if (length > 0.05) bent++;
        }
      }
    }
    // Cold air: one 8-bit step around 0.5 is about 0.02 of a strength.
    expect(cold).toBeGreaterThan(1000);
    expect(coldAtSides).toBeGreaterThan(0.8 * 2 * 30 * 108);
    expect(coldWorst).toBeLessThan(0.025);
    // Hot air bends the picture, never further than `strength`.
    expect(hot).toBeGreaterThan(500);
    expect(bent).toBeGreaterThan(200);
    expect(largest).toBeLessThan(1.03);
    const instance = mounted.instance as FireHazeInstance;
    expect(instance.fluid.grid.width).toBe(96);
    mounted.destroy();
  });

  it('leaves the picture untouched when nothing is hot', async () => {
    const still = await mountHeadless('fire-haze', {
      width: 160,
      height: 90,
      params: { resolution: '96', heat: 0, embers: 0, glow: 0 },
    });
    const bare = await mountHeadless('fire-haze', {
      width: 160,
      height: 90,
      params: { resolution: '96', heat: 0, embers: 0, glow: 0, strength: 0 },
    });
    still.step(3);
    bare.step(3);
    const a = await still.read();
    const b = await bare.read();
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    // The dither is the same pattern in both (same frame numbers), so the pictures are identical.
    expect(worst).toBeLessThanOrEqual(1);
    still.destroy();
    bare.destroy();
  });
});
