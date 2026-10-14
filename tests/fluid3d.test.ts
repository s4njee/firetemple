import { describe, expect, it } from 'vitest';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import {
  computeFluid3dGrid,
  computeScalarGrid,
  createFluid3d,
  fluid3dTextureBytes,
  pointOnRay,
  rayBox,
  type Fluid3d,
  type Fluid3dParams,
} from '../src/gpu/sim/fluid3d.ts';
import { expectValid, getTestDevice } from './gpu.ts';

// Ported from Water Temple's tests/fluid3d.test.ts. Grids and step counts are kept small so the whole
// file runs in seconds on CI's software rasteriser; the long study is behind FLUID3D_STUDY. GPU numbers
// are compared to at most 5 decimal places and never by the sign of zero.

// --- Helpers -------------------------------------------------------------------------------------

/** Reads a whole 3D texture back as a flat array of numbers (`channels` per texel, x fastest). */
async function read3d(
  device: GPUDevice,
  texture: GPUTexture,
  format: 'half4' | 'float1',
): Promise<Float32Array> {
  const { width, height, depthOrArrayLayers: depth } = texture;
  const bytesPerTexel = format === 'half4' ? 8 : 4;
  const rowBytes = width * bytesPerTexel;
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
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
  const padded = new Uint8Array(buffer.getMappedRange());
  const channels = format === 'half4' ? 4 : 1;
  const out = new Float32Array(width * height * depth * channels);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  let o = 0;
  for (let k = 0; k < depth; k++) {
    for (let j = 0; j < height; j++) {
      const row = (k * height + j) * bytesPerRow;
      for (let i = 0; i < width * channels; i++) {
        out[o++] =
          format === 'half4'
            ? fromHalf(view.getUint16(row + i * 2, true))
            : view.getFloat32(row + i * 4, true);
      }
    }
  }
  buffer.unmap();
  buffer.destroy();
  return out;
}

async function submit(device: GPUDevice, record: (encoder: GPUCommandEncoder) => void) {
  const encoder = device.createCommandEncoder();
  record(encoder);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

function create(
  device: GPUDevice,
  params: Partial<Fluid3dParams> = {},
  resolution = 16,
  scalarResolution = 24,
  size: readonly [number, number, number] = [1, 1, 1],
): Fluid3d {
  return createFluid3d({
    device,
    resolution,
    scalarResolution,
    size,
    params: { velocityDissipation: 0, scalarDissipation: 0, ...params },
  });
}

interface Velocity {
  nx: number;
  ny: number;
  nz: number;
  /** Faces: u(i, j, k) i = 0..nx; v(i, j, k) j = 0..ny; w(i, j, k) k = 0..nz. */
  u(i: number, j: number, k: number): number;
  v(i: number, j: number, k: number): number;
  w(i: number, j: number, k: number): number;
}

async function readVelocity(device: GPUDevice, fluid: Fluid3d): Promise<Velocity> {
  const { width: nx, height: ny, depth: nz, velocitySize } = fluid.grid;
  const data = await read3d(device, fluid.velocity.texture, 'half4');
  const at = (i: number, j: number, k: number, c: number) =>
    data[((k * velocitySize[1] + j) * velocitySize[0] + i) * 4 + c]!;
  return {
    nx,
    ny,
    nz,
    u: (i, j, k) => at(i, j, k, 0),
    v: (i, j, k) => at(i, j, k, 1),
    w: (i, j, k) => at(i, j, k, 2),
  };
}

function cellDivergence(v: Velocity, i: number, j: number, k: number): number {
  return (
    v.u(i + 1, j, k) -
    v.u(i, j, k) +
    v.v(i, j + 1, k) -
    v.v(i, j, k) +
    v.w(i, j, k + 1) -
    v.w(i, j, k)
  );
}

/** Root-mean-square divergence over the cells, and the largest. */
function divergence(v: Velocity): { l2: number; max: number } {
  let sum = 0;
  let max = 0;
  for (let k = 0; k < v.nz; k++) {
    for (let j = 0; j < v.ny; j++) {
      for (let i = 0; i < v.nx; i++) {
        const d = cellDivergence(v, i, j, k);
        sum += d * d;
        max = Math.max(max, Math.abs(d));
      }
    }
  }
  return { l2: Math.sqrt(sum / (v.nx * v.ny * v.nz)), max };
}

/** Sum of u^2 + v^2 + w^2 over all real faces: proportional to the kinetic energy. */
function energy(v: Velocity): number {
  let sum = 0;
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j < v.ny; j++) for (let i = 0; i <= v.nx; i++) sum += v.u(i, j, k) ** 2;
  for (let k = 0; k < v.nz; k++)
    for (let j = 0; j <= v.ny; j++) for (let i = 0; i < v.nx; i++) sum += v.v(i, j, k) ** 2;
  for (let k = 0; k <= v.nz; k++)
    for (let j = 0; j < v.ny; j++) for (let i = 0; i < v.nx; i++) sum += v.w(i, j, k) ** 2;
  return sum;
}

function allFinite(data: ArrayLike<number>): boolean {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let worst = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

interface Blob {
  total: number;
  /** Centroid in length units. */
  centre: [number, number, number];
  min: number;
  max: number;
}

/** Statistics of channel `c` of the scalar. */
async function readInk(
  device: GPUDevice,
  fluid: Fluid3d,
  c = 3,
): Promise<Blob & { data: Float32Array }> {
  const data = await read3d(device, fluid.density.texture, 'half4');
  const [sx, sy, sz] = fluid.grid.scalarSize;
  const size = fluid.grid.size;
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  const centre: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < sz; k++) {
    for (let j = 0; j < sy; j++) {
      for (let i = 0; i < sx; i++) {
        const v = data[((k * sy + j) * sx + i) * 4 + c]!;
        total += v;
        min = Math.min(min, v);
        max = Math.max(max, v);
        centre[0] += v * ((i + 0.5) / sx) * size[0];
        centre[1] += v * ((j + 0.5) / sy) * size[1];
        centre[2] += v * ((k + 0.5) / sz) * size[2];
      }
    }
  }
  if (total > 0) for (let n = 0; n < 3; n++) centre[n] = centre[n]! / total;
  return { total, centre, min, max, data };
}

const gaussian =
  (cx: number, cy: number, cz: number, sigma: number, peak = 1) =>
  (x: number, y: number, z: number): [number, number, number, number] => {
    const v = peak * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / (2 * sigma ** 2));
    return [v, v, v, v];
  };

describe('grid sizes', () => {
  it('rounds every axis to a multiple of 8 and keeps cells cubic', () => {
    const g = computeFluid3dGrid(64, [1, 1.25, 1]);
    // `resolution` counts the cells along the LONGEST side, which is y here.
    expect([g.width, g.height, g.depth]).toEqual([48, 64, 48]);
    expect(g.cellSize).toBeCloseTo(1 / 64, 9);
    const small = computeFluid3dGrid(20, [1, 1, 1]);
    expect(small.width % 8).toBe(0);
    expect(computeFluid3dGrid(1000, [1, 1, 1]).width).toBe(256);
    expect(computeFluid3dGrid(Number.NaN, [1, 1, 1]).width).toBe(64);
  });

  it('sizes the scalar grid in proportion to the box', () => {
    expect(computeScalarGrid(96, [1, 1.25, 1])).toEqual([77, 96, 77]);
    expect(computeScalarGrid(5, [1, 1, 1])).toEqual([16, 16, 16]);
  });

  it('adds up texture memory', () => {
    const mb = fluid3dTextureBytes([64, 64, 64], [96, 96, 96]) / 2 ** 20;
    expect(mb).toBeGreaterThan(20);
    expect(mb).toBeLessThan(80);
  });
});

describe('smoke', () => {
  it('steps with every scheme without a validation error', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      for (const params of [
        {},
        { pressureSolver: 'jacobi' as const, pressureIterations: 4 },
        { velocityScheme: 'maccormack' as const, vorticity: 3, buoyancy: 1 },
        {
          scalarScheme: 'semi-lagrangian' as const,
          obstacle: { center: [0.5, 0.5, 0.5] as const, radius: 0.15 },
        },
        { openTop: true, divergenceWeights: [0, 0, 0, 1] as const, buoyancy: -2 },
        {
          openTop: true,
          pressureSolver: 'jacobi' as const,
          obstacle: { center: [0.5, 0.5, 0.5] as const, radius: 0.15 },
        },
      ]) {
        const fluid = create(device, params);
        fluid.addDensity([0.5, 0.7, 0.5], [0.5, 0.7, 0.5], 0.1, [1, 2, 3, 1]);
        fluid.addImpulse([0.5, 0.5, 0.5], [0.6, 0.5, 0.5], 0.1, [1, 0, 0]);
        await submit(device, (encoder) => fluid.advance(encoder, 2));
        fluid.destroy();
      }
    });
  });
});

// --- Physics -------------------------------------------------------------------------------------------

/** A divergent velocity: an outward Gaussian push from the middle of the box. */
const outward =
  (sigma: number, amp = 1) =>
  (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - 0.5;
    const dy = y - 0.5;
    const dz = z - 0.5;
    const g = amp * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sigma * sigma));
    return [dx * g, dy * g, dz * g];
  };

describe('at rest', () => {
  it('a fluid at rest stays at rest and keeps its ink', async () => {
    const device = await getTestDevice();
    const fluid = create(device);
    fluid.setDensity(gaussian(0.5, 0.5, 0.5, 0.12));
    const before = await readInk(device, fluid);
    await submit(device, (encoder) => fluid.advance(encoder, 20));
    const v = await readVelocity(device, fluid);
    expect(energy(v)).toBeLessThan(1e-9);
    const after = await readInk(device, fluid);
    expect(after.total).toBeCloseTo(before.total, 1);
    for (let n = 0; n < 3; n++) expect(after.centre[n]).toBeCloseTo(before.centre[n]!, 3);
    fluid.destroy();
  });

  it('keeps a uniform ink at rest too, whatever the gravity (a body force is balanced by pressure)', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { gravity: [0, -3, 0] });
    fluid.setDensity(() => [0, 0, 0, 0]);
    await submit(device, (encoder) => fluid.advance(encoder, 20));
    const v = await readVelocity(device, fluid);
    // The pressure cancels a uniform force to within the solve's accuracy.
    expect(energy(v)).toBeLessThan(1e-3);
    fluid.destroy();
  });
});

describe('projection', () => {
  async function reduction(params: Partial<Fluid3dParams>, iterations: number, resolution = 16) {
    const device = await getTestDevice();
    const fluid = create(device, { warmStart: false, ...params }, resolution);
    fluid.setVelocity(outward(0.15, 6));
    const before = divergence(await readVelocity(device, fluid));
    await submit(device, (encoder) => fluid.project(encoder, iterations));
    const after = divergence(await readVelocity(device, fluid));
    fluid.destroy();
    return { before: before.l2, after: after.l2, ratio: after.l2 / before.l2 };
  }

  it('one multigrid V-cycle removes most of the divergence of a divergent field', async () => {
    const one = await reduction({ pressureSolver: 'multigrid' }, 1);
    expect(one.before).toBeGreaterThan(0.01);
    // Water Temple measured a quarter left after one V(2,2) cycle at 32 cells; 16 cells does as well.
    expect(one.ratio).toBeLessThan(0.35);
  });

  it('more V-cycles reduce it further, and a cycle beats the same work in plain sweeps', async () => {
    const one = await reduction({ pressureSolver: 'multigrid' }, 1);
    const three = await reduction({ pressureSolver: 'multigrid' }, 3);
    expect(three.ratio).toBeLessThan(one.ratio * 0.2);
    expect(three.ratio).toBeLessThan(0.03);
    const sweeps = await reduction({ pressureSolver: 'jacobi' }, 6);
    expect(one.ratio).toBeLessThan(sweeps.ratio * 0.5);
  });

  it('plain Jacobi reduces the divergence monotonically with more sweeps', async () => {
    const ratios: number[] = [];
    for (const n of [4, 16, 48])
      ratios.push((await reduction({ pressureSolver: 'jacobi' }, n)).ratio);
    expect(ratios[0]!).toBeLessThan(1);
    expect(ratios[1]!).toBeLessThan(ratios[0]!);
    expect(ratios[2]!).toBeLessThan(ratios[1]!);
  });

  it('a warm start continues from where the last solve stopped', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { pressureSolver: 'jacobi' });
    fluid.setVelocity(outward(0.15, 6));
    const d0 = divergence(await readVelocity(device, fluid)).l2;
    await submit(device, (encoder) => fluid.project(encoder, 8));
    const d1 = divergence(await readVelocity(device, fluid)).l2;
    await submit(device, (encoder) => fluid.project(encoder, 8));
    const d2 = divergence(await readVelocity(device, fluid)).l2;
    expect(d1).toBeLessThan(d0);
    expect(d2).toBeLessThan(d1);
    fluid.destroy();
  });

  it('works on a box that is not a cube', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { warmStart: false }, 32, 24, [0.5, 1, 0.75]);
    expect([fluid.grid.width, fluid.grid.height, fluid.grid.depth]).toEqual([16, 32, 24]);
    fluid.setVelocity(outward(0.12, 6));
    const before = divergence(await readVelocity(device, fluid)).l2;
    await submit(device, (encoder) => fluid.project(encoder, 2));
    const after = divergence(await readVelocity(device, fluid)).l2;
    expect(after).toBeLessThan(before * 0.2);
    fluid.destroy();
  });
});

describe('advection', () => {
  const axes = [
    { name: 'x', velocity: [0.3, 0, 0], axis: 0 },
    { name: 'y', velocity: [0, 0.3, 0], axis: 1 },
    { name: 'z', velocity: [0, 0, -0.3], axis: 2 },
  ] as const;

  it.each(axes)(
    'a uniform velocity along $name carries a blob the expected distance',
    async ({ velocity, axis }) => {
      const device = await getTestDevice();
      const fluid = create(device, { scalarOnly: true }, 16, 32);
      fluid.setVelocity(() => velocity);
      fluid.setDensity(gaussian(0.5, 0.5, 0.5, 0.08));
      const before = await readInk(device, fluid);
      const steps = 20;
      await submit(device, (encoder) => fluid.advance(encoder, steps));
      const after = await readInk(device, fluid);
      const expected = velocity[axis] * steps * fluid.stepSeconds;
      expect(after.centre[axis]! - before.centre[axis]!).toBeCloseTo(expected, 2);
      for (let n = 0; n < 3; n++) {
        if (n !== axis) expect(after.centre[n]).toBeCloseTo(before.centre[n]!, 3);
      }
      // MacCormack keeps the blob's mass and never overshoots it.
      expect(after.total / before.total).toBeGreaterThan(0.95);
      expect(after.total / before.total).toBeLessThan(1.05);
      expect(after.max).toBeLessThanOrEqual(before.max * 1.001);
      expect(after.min).toBeGreaterThanOrEqual(0);
      fluid.destroy();
    },
  );
});

describe('buoyancy', () => {
  async function drift(params: Partial<Fluid3dParams>, centre = 0.5) {
    const device = await getTestDevice();
    const fluid = create(device, params, 16, 24);
    fluid.setDensity(gaussian(0.5, centre, 0.5, 0.1, 1));
    const before = await readInk(device, fluid);
    await submit(device, (encoder) => fluid.advance(encoder, 40));
    const after = await readInk(device, fluid);
    fluid.destroy();
    return {
      dy: after.centre[1]! - before.centre[1]!,
      dx: after.centre[0]! - before.centre[0]!,
      dz: after.centre[2]! - before.centre[2]!,
    };
  }

  it('moves a dense blob along gravity and a light one against it', async () => {
    const dense = await drift({ buoyancy: 8 });
    const light = await drift({ buoyancy: -8 });
    expect(dense.dy).toBeLessThan(-0.02);
    expect(light.dy).toBeGreaterThan(0.02);
    expect(Math.abs(dense.dx)).toBeLessThan(0.01);
    expect(Math.abs(dense.dz)).toBeLessThan(0.01);
    // Symmetric: the same size of drift either way, to within the asymmetry of the walls.
    expect(Math.abs(dense.dy + light.dy)).toBeLessThan(0.3 * Math.abs(dense.dy));
  });

  it('follows the buoyancy direction', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { buoyancy: 8, buoyancyDirection: [1, 0, 0] }, 16, 24);
    fluid.setDensity(gaussian(0.4, 0.5, 0.5, 0.1, 1));
    const before = await readInk(device, fluid);
    await submit(device, (encoder) => fluid.advance(encoder, 40));
    const after = await readInk(device, fluid);
    expect(after.centre[0]! - before.centre[0]!).toBeGreaterThan(0.02);
    expect(Math.abs(after.centre[1]! - before.centre[1]!)).toBeLessThan(0.01);
    fluid.destroy();
  });

  it('follows the channels named by buoyancyWeights (new in the port)', async () => {
    // The blob is the same in every channel (`gaussian` fills all four). Weighting red lifts it as the
    // default alpha weight would; a zero weight leaves it where it is.
    const lifted = await drift({ buoyancy: -8, buoyancyWeights: [1, 0, 0, 0] });
    const still = await drift({ buoyancy: -8, buoyancyWeights: [0, 0, 0, 0] });
    expect(lifted.dy).toBeGreaterThan(0.02);
    expect(Math.abs(still.dy)).toBeLessThan(0.002);
    // Two channels against each other cancel.
    const balanced = await drift({ buoyancy: -8, buoyancyWeights: [1, -1, 0, 0] });
    expect(Math.abs(balanced.dy)).toBeLessThan(0.002);
  });
});

describe('walls', () => {
  it('leave zero normal velocity at the six faces and keep the ink in', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { vorticity: 4, buoyancy: 4, scalarDissipation: 0 }, 16, 24);
    fluid.setDensity(gaussian(0.5, 0.3, 0.5, 0.15, 2));
    const before = await readInk(device, fluid);
    // Shove the fluid hard towards every wall.
    const points: [number, number, number][] = [
      [0.9, 0.5, 0.5],
      [0.1, 0.5, 0.5],
      [0.5, 0.9, 0.5],
      [0.5, 0.1, 0.5],
      [0.5, 0.5, 0.9],
      [0.5, 0.5, 0.1],
    ];
    const directions: [number, number, number][] = [
      [3, 0, 0],
      [-3, 0, 0],
      [0, 3, 0],
      [0, -3, 0],
      [0, 0, 3],
      [0, 0, -3],
    ];
    points.forEach((p, i) => fluid.addImpulse(p, p, 0.12, directions[i]!));
    await submit(device, (encoder) => fluid.advance(encoder, 30));
    const v = await readVelocity(device, fluid);
    let worst = 0;
    for (let k = 0; k < v.nz; k++) {
      for (let j = 0; j < v.ny; j++)
        worst = Math.max(worst, Math.abs(v.u(0, j, k)), Math.abs(v.u(v.nx, j, k)));
    }
    for (let k = 0; k < v.nz; k++) {
      for (let i = 0; i < v.nx; i++)
        worst = Math.max(worst, Math.abs(v.v(i, 0, k)), Math.abs(v.v(i, v.ny, k)));
    }
    for (let j = 0; j < v.ny; j++) {
      for (let i = 0; i < v.nx; i++)
        worst = Math.max(worst, Math.abs(v.w(i, j, 0)), Math.abs(v.w(i, j, v.nz)));
    }
    expect(worst).toBeLessThan(1e-6);
    expect(energy(v)).toBeGreaterThan(1e-3); // the fluid did move
    const after = await readInk(device, fluid);
    expect(after.total / before.total).toBeGreaterThan(0.8);
    expect(after.total / before.total).toBeLessThan(1.25);
    expect(after.min).toBeGreaterThanOrEqual(0);
    fluid.destroy();
  });

  it('stop ink at a wall: a long push into it leaves the ink inside', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { scalarOnly: true });
    fluid.setVelocity(() => [0.5, 0, 0]);
    fluid.setDensity(gaussian(0.7, 0.5, 0.5, 0.06));
    const before = await readInk(device, fluid);
    await submit(device, (encoder) => fluid.advance(encoder, 60));
    const after = await readInk(device, fluid);
    expect(after.total / before.total).toBeLessThan(1.05);
    expect(after.total).toBeGreaterThan(0);
    expect(after.centre[0]!).toBeGreaterThan(0.8);
    expect(after.centre[0]!).toBeLessThan(1);
    fluid.destroy();
  });
});

describe('open top and divergence source (new in the port)', () => {
  it('an open top lets a rising plume leave the box; a closed one keeps it', async () => {
    const device = await getTestDevice();
    const run = async (openTop: boolean) => {
      const fluid = create(device, { buoyancy: -12, openTop }, 16, 16);
      fluid.setDensity(gaussian(0.5, 0.7, 0.5, 0.1, 1));
      const before = await readInk(device, fluid);
      await submit(device, (encoder) => fluid.advance(encoder, 60));
      const after = await readInk(device, fluid);
      const v = await readVelocity(device, fluid);
      let top = 0;
      for (let k = 0; k < v.nz; k++)
        for (let i = 0; i < v.nx; i++) top = Math.max(top, v.v(i, v.ny, k));
      fluid.destroy();
      return { kept: after.total / before.total, top };
    };
    const open = await run(true);
    const closed = await run(false);
    expect(closed.top).toBeLessThan(1e-6);
    expect(open.top).toBeGreaterThan(0.05); // gas leaves through the lid
    expect(closed.kept).toBeGreaterThan(0.8);
    expect(open.kept).toBeLessThan(closed.kept - 0.1);
  });

  it('an open top alone changes nothing about a divergence-free solve inside', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { warmStart: false, openTop: true }, 16);
    fluid.setVelocity(outward(0.12, 6));
    const before = divergence(await readVelocity(device, fluid)).l2;
    await submit(device, (encoder) => fluid.project(encoder, 3));
    expect(divergence(await readVelocity(device, fluid)).l2).toBeLessThan(before * 0.05);
    fluid.destroy();
  });

  it('a divergence source makes the projected field expand by the requested rate', async () => {
    const device = await getTestDevice();
    const rate = 2; // 1 / s per unit of the source channel
    const fluid = create(
      device,
      { warmStart: false, openTop: true, divergenceWeights: [0, 0, 0, rate] },
      16,
      16,
    );
    // A unit of source in the middle of the box, nothing elsewhere.
    fluid.setDensity((x, y, z) => {
      const inside = Math.abs(x - 0.5) < 0.2 && Math.abs(y - 0.4) < 0.2 && Math.abs(z - 0.5) < 0.2;
      return [0, 0, 0, inside ? 1 : 0];
    });
    await submit(device, (encoder) => fluid.project(encoder, 4));
    const v = await readVelocity(device, fluid);
    const h = fluid.grid.cellSize;
    // Cells well inside the source expand at `rate`; cells well outside do not.
    const centre = Math.floor(v.nx / 2);
    const inside = cellDivergence(v, centre, Math.floor(0.4 * v.ny), centre) / h;
    const outside = cellDivergence(v, 2, v.ny - 3, 2) / h;
    expect(inside).toBeGreaterThan(rate * 0.8);
    expect(inside).toBeLessThan(rate * 1.2);
    expect(Math.abs(outside)).toBeLessThan(rate * 0.1);
    // The expansion leaves through the lid.
    let flux = 0;
    for (let k = 0; k < v.nz; k++) for (let i = 0; i < v.nx; i++) flux += v.v(i, v.ny, k);
    expect(flux).toBeGreaterThan(0);
    // With all-zero weights the result is the plain projection: no source anywhere.
    fluid.params.divergenceWeights = [0, 0, 0, 0];
    fluid.setVelocity(() => [0, 0, 0]);
    await submit(device, (encoder) => fluid.project(encoder, 4));
    expect(divergence(await readVelocity(device, fluid)).max).toBeLessThan(1e-5);
    fluid.destroy();
  });
});

describe('reaction hook (new in the port)', () => {
  it('runs once per step after the advection, and its output becomes the scalar', async () => {
    const device = await getTestDevice();
    const calls: number[] = [];
    let last: GPUTexture | undefined;
    const fluid = create(device, { scalarOnly: true }, 16, 16);
    // This hook only counts its calls; tests/fire3d.test.ts checks one that writes (the combustion).
    fluid.reaction = {
      encode(_pass, src, dst, step) {
        expect(src.texture).not.toBe(dst.texture);
        calls.push(step);
        last = dst.texture;
      },
    };
    await submit(device, (encoder) => fluid.advance(encoder, 3));
    expect(calls).toEqual([0, 1, 2]);
    // The hook's last output is the scalar now.
    expect(fluid.density.texture).toBe(last);
    fluid.reaction = undefined;
    await submit(device, (encoder) => fluid.advance(encoder, 1));
    expect(calls).toHaveLength(3);
    fluid.destroy();
  });
});

describe('energy and obstacles', () => {
  it('does not gain kinetic energy without forcing (confinement off)', async () => {
    const device = await getTestDevice();
    const fluid = create(device, { pressureIterations: 2 }, 16, 24);
    fluid.setVelocity(outward(0.15, 4));
    await submit(device, (encoder) => fluid.project(encoder, 3));
    let previous = energy(await readVelocity(device, fluid));
    expect(previous).toBeGreaterThan(0);
    for (let round = 0; round < 4; round++) {
      await submit(device, (encoder) => fluid.advance(encoder, 8));
      const now = energy(await readVelocity(device, fluid));
      expect(now).toBeLessThan(previous * 1.02);
      previous = now;
    }
    fluid.destroy();
  });

  it('flows round a solid sphere: no ink inside it, no velocity through it', async () => {
    const device = await getTestDevice();
    const fluid = create(device, {
      pressureSolver: 'jacobi',
      pressureIterations: 20,
      obstacle: { center: [0.5, 0.5, 0.5], radius: 0.2 },
    });
    fluid.setDensity(gaussian(0.5, 0.5, 0.5, 0.2, 1));
    fluid.addImpulse([0.2, 0.5, 0.5], [0.3, 0.5, 0.5], 0.1, [2, 0, 0]);
    await submit(device, (encoder) => fluid.advance(encoder, 20));
    const ink = await readInk(device, fluid);
    const [sx, sy, sz] = fluid.grid.scalarSize;
    let inside = 0;
    for (let k = 0; k < sz; k++) {
      for (let j = 0; j < sy; j++) {
        for (let i = 0; i < sx; i++) {
          const d = Math.hypot((i + 0.5) / sx - 0.5, (j + 0.5) / sy - 0.5, (k + 0.5) / sz - 0.5);
          if (d < 0.18) inside += Math.abs(ink.data[((k * sy + j) * sx + i) * 4 + 3]!);
        }
      }
    }
    expect(inside).toBeLessThan(1e-6);
    const v = await readVelocity(device, fluid);
    const mid = fluid.grid.width / 2;
    expect(Math.abs(v.u(mid, fluid.grid.height / 2, fluid.grid.depth / 2))).toBeLessThan(1e-6);
    expect(energy(v)).toBeGreaterThan(0);
    fluid.destroy();
  });
});

describe('robustness', () => {
  it('never produces NaN or Inf from extreme impulses and many sub-steps', async () => {
    const device = await getTestDevice();
    const fluid = create(
      device,
      {
        vorticity: 30,
        buoyancy: 20,
        velocityScheme: 'maccormack',
        openTop: true,
        divergenceWeights: [0, 0, 1, 0],
      },
      16,
      16,
    );
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 128; i++) {
      const p: [number, number, number] = [random(), random(), random()];
      fluid.addImpulse(p, [p[0], p[1], 1 - p[2]], 0.1, [3e38, -3e38, 1e30]);
      fluid.addDensity(p, p, 0.1, [3e38, 5, -5, 1e30]);
    }
    expect(fluid.addImpulse([Number.NaN, 0, 0], [0, 0, 0], 0.1, [1, 0, 0])).toBe(false);
    expect(fluid.addDensity([0, 0, 0], [0, 0, 0], Number.POSITIVE_INFINITY, [1, 1, 1, 1])).toBe(
      false,
    );
    await submit(device, (encoder) => fluid.advance(encoder, 40));
    const v = await read3d(device, fluid.velocity.texture, 'half4');
    const ink = await read3d(device, fluid.density.texture, 'half4');
    expect(allFinite(v)).toBe(true);
    expect(allFinite(ink)).toBe(true);
    const bound = (6 * fluid.grid.cellSize) / fluid.stepSeconds;
    let fastest = 0;
    for (let i = 0; i < v.length; i++) fastest = Math.max(fastest, Math.abs(v[i]!));
    expect(fastest).toBeLessThanOrEqual(bound * 1.001);
    fluid.destroy();
  });

  it('refuses splats beyond its queue instead of overflowing', async () => {
    const device = await getTestDevice();
    const fluid = create(device);
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      if (fluid.addImpulse([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.1, [1, 0, 0])) accepted++;
    }
    expect(accepted).toBeLessThan(400);
    expect(fluid.pendingSplats[0]).toBe(accepted);
    fluid.destroy();
  });

  it('looks the same at 60 and 120 Hz', async () => {
    const device = await getTestDevice();
    const run = async (frames: number, delta: number) => {
      const fluid = create(device, { buoyancy: 6 }, 16, 16);
      fluid.setDensity(gaussian(0.5, 0.6, 0.5, 0.1, 1));
      for (let i = 0; i < frames; i++)
        await submit(device, (encoder) => fluid.update(encoder, delta));
      const ink = await readInk(device, fluid);
      fluid.destroy();
      return ink.centre[1]!;
    };
    const at60 = await run(20, 1 / 60);
    const at120 = await run(40, 1 / 120);
    expect(at120).toBeCloseTo(at60, 2);
  });

  it('rebuilds cleanly when the resolution, the box or the workgroup changes, and on reset', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const fluid = create(device, { vorticity: 2 }, 16, 32);
      fluid.addDensity([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.1, [1, 1, 1, 1]);
      await submit(device, (encoder) => fluid.advance(encoder, 2));
      const g0 = fluid.generation;
      expect(fluid.setResolution(16, 32)).toBe(false);
      expect(fluid.generation).toBe(g0);
      expect(fluid.setResolution(24, 40)).toBe(true);
      expect(fluid.generation).toBe(g0 + 1);
      expect(fluid.grid.width).toBe(24);
      expect(fluid.grid.scalarSize[0]).toBe(40);
      expect((await readInk(device, fluid)).total).toBe(0);
      expect(fluid.setSize([1, 1.5, 1])).toBe(true);
      expect(fluid.grid.height).toBeGreaterThan(fluid.grid.width);
      fluid.addDensity([0.3, 0.3, 0.3], [0.3, 0.3, 0.3], 0.1, [1, 1, 1, 1]);
      await submit(device, (encoder) => fluid.advance(encoder, 2));
      expect((await readInk(device, fluid)).total).toBeGreaterThan(0);
      for (const wg of [
        [8, 4, 4],
        [8, 8, 4],
        [4, 4, 4],
      ] as const) {
        fluid.setWorkgroup(wg);
        await submit(device, (encoder) => fluid.advance(encoder, 1));
      }
      expect(() => fluid.setWorkgroup([16, 16, 2])).toThrow(RangeError);
      const g1 = fluid.generation;
      fluid.reset();
      expect(fluid.generation).toBe(g1 + 1);
      expect((await readInk(device, fluid)).total).toBe(0);
      await submit(device, (encoder) => fluid.advance(encoder, 2));
      fluid.destroy();
    });
  });

  it('gives the same answer in every workgroup shape', async () => {
    const device = await getTestDevice();
    const results: Float32Array[] = [];
    for (const wg of [
      [4, 4, 4],
      [8, 4, 4],
      [8, 8, 4],
    ] as const) {
      const fluid = createFluid3d({
        device,
        resolution: 16,
        scalarResolution: 16,
        workgroup: wg,
        params: { buoyancy: 6, vorticity: 3 },
      });
      fluid.setDensity(gaussian(0.5, 0.6, 0.5, 0.12, 1));
      fluid.addImpulse([0.5, 0.5, 0.5], [0.6, 0.5, 0.5], 0.1, [1, 0, 0]);
      await submit(device, (encoder) => fluid.advance(encoder, 6));
      results.push((await readInk(device, fluid)).data);
      fluid.destroy();
    }
    // Same arithmetic per texel whatever the grouping; compared to 1e-5, never by the sign of zero.
    expect(maxDifference(results[1]!, results[0]!)).toBeLessThan(1e-5);
    expect(maxDifference(results[2]!, results[0]!)).toBeLessThan(1e-5);
  });
});

describe('resolve', () => {
  it('writes the cell-centred velocity the debug views read', async () => {
    const device = await getTestDevice();
    const fluid = create(device);
    fluid.setVelocity((x, y) => [0.3, 0.1 * x, y * 0]);
    await submit(device, (encoder) => fluid.resolve(encoder));
    const data = await read3d(device, fluid.fields, 'half4');
    const { width, height } = fluid.grid;
    const at = (i: number, j: number, k: number, c: number) =>
      data[((k * height + j) * width + i) * 4 + c]!;
    expect(at(8, 8, 8, 0)).toBeCloseTo(0.3, 2);
    expect(at(8, 8, 8, 1)).toBeCloseTo(0.1 * (8.5 / width), 2);
    expect(at(8, 8, 8, 2)).toBeCloseTo(0, 3);
    fluid.destroy();
  });
});

describe('one command buffer', () => {
  it('still injects the queued splats when resolve and project are encoded after the update', async () => {
    // queue.writeBuffer lands before the whole command buffer: a second parameter upload in the same
    // encoder must not zero the splat counts the injection pass reads.
    const device = await getTestDevice();
    const fluid = create(device, { buoyancy: 4 });
    fluid.addDensity([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.1, [1, 1, 1, 1]);
    fluid.addImpulse([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 0.1, [0, 1, 0]);
    await submit(device, (encoder) => {
      fluid.advance(encoder, 1);
      fluid.resolve(encoder);
      fluid.project(encoder, 1);
    });
    expect((await readInk(device, fluid)).total).toBeGreaterThan(0.1);
    expect(energy(await readVelocity(device, fluid))).toBeGreaterThan(1e-4);
    fluid.destroy();
  });
});

describe('geometry helpers', () => {
  it('rayBox finds entry and exit, clamps to the origin, and reports a miss', () => {
    expect(rayBox([-1, 0.5, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1])).toEqual({ near: 1, far: 2 });
    expect(rayBox([0.5, 0.5, 0.5], [0, 0, 1], [0, 0, 0], [1, 1, 1])).toEqual({ near: 0, far: 0.5 });
    expect(rayBox([-1, 2, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(rayBox([2, 0.5, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1])).toBeNull();
    const diagonal = rayBox([-1, -1, -1], [1, 1, 1], [0, 0, 0], [1, 1, 1])!;
    expect(diagonal.near).toBeCloseTo(1, 9);
    expect(diagonal.far).toBeCloseTo(2, 9);
  });

  it('pointOnRay picks a point between the entry and the exit', () => {
    expect(pointOnRay([-1, 0.5, 0.5], [1, 0, 0], [1, 1, 1], 0)).toEqual([0, 0.5, 0.5]);
    expect(pointOnRay([-1, 0.5, 0.5], [1, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(pointOnRay([-1, 2, 0.5], [1, 0, 0], [1, 1, 1])).toBeNull();
  });
});

// --- Study -----------------------------------------------------------------------------------------
//
// Residual divergence against pressure work at the grid sizes fire-3d uses. Skipped unless
// FLUID3D_STUDY=1:  FLUID3D_STUDY=1 npx vitest run tests/fluid3d.test.ts -t study

const study = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  .FLUID3D_STUDY;

describe.skipIf(!study)('study', () => {
  it('residual divergence after one projection from zero', async () => {
    const device = await getTestDevice();
    const lines: string[] = [];
    for (const size of [32, 48, 64]) {
      for (const [name, params, counts] of [
        ['multigrid V(2,2)', { pressureSolver: 'multigrid' }, [1, 2, 3]],
        ['jacobi', { pressureSolver: 'jacobi' }, [8, 32, 128]],
      ] as [string, Partial<Fluid3dParams>, number[]][]) {
        const row: string[] = [];
        for (const n of counts) {
          const fluid = create(device, { warmStart: false, openTop: true, ...params }, size);
          fluid.setVelocity(outward(0.12, 6));
          const before = divergence(await readVelocity(device, fluid)).l2;
          await submit(device, (e) => fluid.project(e, n));
          row.push(
            `${n}:${(divergence(await readVelocity(device, fluid)).l2 / before).toFixed(4)}`,
          );
          fluid.destroy();
        }
        lines.push(`${size}^3 ${name.padEnd(17)} ${row.join('  ')}`);
      }
    }
    console.log(lines.join('\n'));
  }, 600_000);
});
