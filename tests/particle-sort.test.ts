import { describe, expect, it } from 'vitest';
import { createOit, OIT_CHUNKS } from '../src/gpu/particles/oit.ts';
import {
  createDepthSort,
  sortDispatches,
  type DepthSortSettings,
  type SortMethod,
} from '../src/gpu/particles/sort.ts';
import {
  CameraUniform,
  computeCamera,
  setCameraUniform,
  type CameraMatrices,
} from '../src/gpu/scene/camera.ts';
import { createShader } from '../src/gpu/shader.ts';
import { createUniformBuffer } from '../src/gpu/uniforms.ts';
import { createBenchDevice } from './bench.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';

// Story 7.9: the GPU depth sort (src/gpu/particles/sort.ts) and weighted blended OIT
// (src/gpu/particles/oit.ts). GPU floats are compared to at most 5 decimal places and never by the
// sign of zero, because CI runs on Mesa's software rasteriser.

/** Deterministic random numbers in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function makeCamera(device: GPUDevice) {
  const matrices = computeCamera({
    position: [1.5, 3, 11],
    target: [0, 1.5, 0],
    fovY: 0.8,
    aspect: 1,
    near: 0.1,
    far: 90,
  });
  const uniform = createUniformBuffer(device, CameraUniform, 'test camera');
  setCameraUniform(uniform, matrices, 64, 64);
  uniform.upload();
  return { matrices, uniform };
}

/** View depth as the keys pass computes it: -(view * p).z. */
function viewDepth(camera: CameraMatrices, x: number, y: number, z: number): number {
  const m = camera.view;
  return -(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
}

function randomPositions(count: number, seed: number): Float32Array {
  const random = lcg(seed);
  const data = new Float32Array(Math.max(1, count) * 4);
  for (let i = 0; i < count; i++) {
    // A box around the target, deep enough that some particles are behind the eye (z = 11).
    data[i * 4] = (random() - 0.5) * 10;
    data[i * 4 + 1] = random() * 6;
    data[i * 4 + 2] = (random() - 0.5) * 26;
    data[i * 4 + 3] = 1;
  }
  return data;
}

async function readU32(device: GPUDevice, source: GPUBuffer, count: number): Promise<Uint32Array> {
  const size = Math.max(4, count * 4);
  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(staging.getMappedRange().slice(0, count * 4));
  staging.unmap();
  staging.destroy();
  return result;
}

function uploadPositions(device: GPUDevice, data: Float32Array): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

interface Check {
  isPermutation: boolean;
  /** Places where a nearer particle comes before a farther one by more than the tolerance. */
  descents: number;
}

function checkOrder(
  camera: CameraMatrices,
  positions: Float32Array,
  order: Uint32Array,
  tolerance: number,
  clampToRange = false,
): Check {
  const count = order.length;
  const seen = new Uint8Array(count);
  let isPermutation = true;
  for (const index of order) {
    if (index >= count || seen[index]) isPermutation = false;
    else seen[index] = 1;
  }
  let descents = 0;
  const depth = (i: number) => {
    const z = viewDepth(camera, positions[i * 4]!, positions[i * 4 + 1]!, positions[i * 4 + 2]!);
    // 16-bit keys only resolve depth between the near and far planes.
    return clampToRange ? Math.min(camera.far, Math.max(camera.near, z)) : z;
  };
  for (let k = 0; k + 1 < count; k++) {
    if (
      order[k]! < count &&
      order[k + 1]! < count &&
      depth(order[k]!) < depth(order[k + 1]!) - tolerance
    )
      descents++;
  }
  return { isPermutation, descents };
}

const SIZES = [1, 2, 7, 1000, 1023, 1025, 4099, 70001];
const VARIANTS: { name: string; settings: Partial<DepthSortSettings> }[] = [
  { name: 'radix 32-bit', settings: { method: 'radix', keyBits: 32 } },
  { name: 'radix 16-bit', settings: { method: 'radix', keyBits: 16 } },
  { name: 'bitonic', settings: { method: 'bitonic' } },
];

describe('depth sort', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: a permutation, farthest first, for ${SIZES.join(', ')} particles`, async () => {
      const device = await getTestDevice();
      const { matrices, uniform } = makeCamera(device);
      const sort = createDepthSort(device, {
        capacity: Math.max(...SIZES),
        camera: uniform.buffer,
        settings: variant.settings,
      });
      // 16-bit keys are depth quantised over [near, far]; equal keys may come in either order.
      const tolerance = variant.settings.keyBits === 16 ? (90 - 0.1) / 65535 + 1e-4 : 1e-4;
      for (const count of SIZES) {
        const data = randomPositions(count, count * 7 + 1);
        const positions = uploadPositions(device, data);
        await expectValid(device, () => {
          const encoder = device.createCommandEncoder();
          sort.encode(encoder, { positions, count });
          device.queue.submit([encoder.finish()]);
        });
        const order = await readU32(device, sort.indices, count);
        const result = checkOrder(
          matrices,
          data,
          order,
          tolerance,
          variant.settings.keyBits === 16,
        );
        expect(result.isPermutation, `${count}: permutation`).toBe(true);
        expect(result.descents, `${count}: out of order`).toBe(0);
        positions.destroy();
      }
      sort.destroy();
      uniform.destroy();
    });
  }

  it('temporal: keeps a permutation and repairs a slightly changed order', async () => {
    const device = await getTestDevice();
    const { matrices, uniform } = makeCamera(device);
    const count = 20000;
    const sort = createDepthSort(device, {
      capacity: count,
      camera: uniform.buffer,
      settings: { method: 'temporal', temporalPasses: 2 },
    });
    const data = randomPositions(count, 99);
    const positions = uploadPositions(device, data);
    const run = () => {
      const encoder = device.createCommandEncoder();
      sort.encode(encoder, { positions, count });
      device.queue.submit([encoder.finish()]);
    };
    // First frame: a full sort.
    run();
    const first = await readU32(device, sort.indices, count);
    expect(checkOrder(matrices, data, first, 1e-4)).toEqual({ isPermutation: true, descents: 0 });

    // Every particle moves a little, as in one frame of motion.
    const random = lcg(5);
    for (let i = 0; i < count; i++) data[i * 4 + 2] = data[i * 4 + 2]! + (random() - 0.5) * 0.02;
    device.queue.writeBuffer(positions, 0, data);
    const stale = checkOrder(matrices, data, first, 1e-4);
    expect(stale.descents).toBeGreaterThan(100);
    run();
    const repaired = checkOrder(matrices, data, await readU32(device, sort.indices, count), 1e-4);
    expect(repaired.isPermutation).toBe(true);
    expect(repaired.descents).toBe(0);
    positions.destroy();
    sort.destroy();
    uniform.destroy();
  });

  it('counts its dispatches', () => {
    expect(sortDispatches('radix', 1)).toBe(0);
    // 16k: 16 tiles, 256 histogram entries, one scan dispatch: 1 + 8 * 3.
    expect(sortDispatches('radix', 16384)).toBe(25);
    expect(sortDispatches('radix', 16384, 16)).toBe(13);
    // 2^20: 1 + 1 + sum over k = 2^10 .. 2^20 of (log2 k - 9) + 11 merges.
    expect(sortDispatches('bitonic', 1 << 20)).toBe(1 + 1 + 66 + 11);
    expect(sortDispatches('temporal', 5000)).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Weighted blended OIT

const SIZE = 4;

const LAYER_SHADER = `
#include "oit.wgsl"

struct Layer {
  // Premultiplied colour and alpha.
  color: vec4f,
  // Emission (rgb) and view depth.
  emission_z: vec4f,
}

@group(0) @binding(0) var<storage, read> layers: array<Layer>;

struct Varying {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) layer: u32,
}

@vertex fn vs(@builtin(vertex_index) index: u32, @builtin(instance_index) layer: u32) -> Varying {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: Varying;
  out.position = vec4f(corner * 2.0 - 1.0, 0.5, 1.0);
  out.layer = layer;
  return out;
}

@fragment fn fs(in: Varying) -> OitAccumEmissive {
  let layer = layers[in.layer];
  let w = oit_weight(layer.color.a, layer.emission_z.w, 0.5, OIT_WEIGHT_EQ7);
  return oit_accumulate_emissive(layer.color.rgb, layer.color.a, w, layer.emission_z.rgb);
}
`;

interface TestLayer {
  color: readonly [number, number, number];
  alpha: number;
  z: number;
  emission?: readonly [number, number, number];
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Draws `layers` (premultiplied by the helper) through OIT onto a scene of colour `scene`. */
async function compositeLayers(
  layers: readonly TestLayer[],
  scene: readonly [number, number, number, number],
  occlusion = 0.5,
): Promise<number[]> {
  const device = await getTestDevice();
  const oit = createOit(device, { label: 'test oit' });
  oit.resize(SIZE, SIZE);
  const module = createShader(device, {
    label: 'test-oit-layers.wgsl',
    code: LAYER_SHADER,
    chunks: OIT_CHUNKS,
  });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [...oit.targets] },
  });
  const data = new Float32Array(Math.max(1, layers.length) * 8);
  layers.forEach((layer, i) => {
    const [r, g, b] = layer.color;
    data.set([r * layer.alpha, g * layer.alpha, b * layer.alpha, layer.alpha], i * 8);
    data.set([...(layer.emission ?? [0, 0, 0]), layer.z], i * 8 + 4);
  });
  const layerBuffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(layerBuffer, 0, data);
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: layerBuffer } }],
  });
  const target = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  await expectValid(device, () => {
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [...scene] },
        ],
      })
      .end();
    const pass = oit.begin(encoder);
    if (layers.length > 0) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3, layers.length);
    }
    pass.end();
    oit.composite(encoder, target.createView(), { occlusion });
    device.queue.submit([encoder.finish()]);
  });
  const bytes = await readTexture(device, target, 8);
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, 4);
  const pixel = Array.from(halves, halfToFloat);
  oit.destroy();
  layerBuffer.destroy();
  target.destroy();
  return pixel;
}

const expectPixel = (actual: number[], expected: readonly number[], tolerance: number) => {
  expected.forEach((value, channel) =>
    expect(
      Math.abs(actual[channel]! - value),
      `channel ${channel}: ${actual[channel]} vs ${value}`,
    ).toBeLessThan(tolerance),
  );
};

describe('weighted blended OIT', () => {
  const SCENE = [0.2, 0.5, 0.9, 1] as const;

  it('composites one layer exactly as alpha over', async () => {
    const alpha = 0.4;
    const color = [0.8, 0.3, 0.1] as const;
    const pixel = await compositeLayers([{ color, alpha, z: 6 }], SCENE);
    const over = [0, 1, 2].map((c) => color[c]! * alpha + SCENE[c]! * (1 - alpha));
    // Half-float accumulation: about three significant digits.
    expectPixel(pixel, [...over, 1], 4e-3);
  });

  it('lets a fully opaque front layer hide the back and the scene', async () => {
    const front: TestLayer = { color: [1, 0, 0], alpha: 1, z: 1 };
    const back: TestLayer = { color: [0, 1, 0], alpha: 0.6, z: 40 };
    const pixel = await compositeLayers([back, front], SCENE);
    // Nothing of the scene: the revealage is exactly 0.
    const overWhite = await compositeLayers([back, front], [1, 1, 1, 1]);
    expectPixel(pixel, overWhite, 1e-5);
    // Equation 7 weighs z = 1 about 4000 times z = 40, so the back layer all but vanishes.
    expectPixel(pixel, [1, 0, 0, 1], 4e-3);
  });

  it('averages layers at the same depth by alpha: the documented colour bias', async () => {
    const front: TestLayer = { color: [1, 0, 0], alpha: 1, z: 5 };
    const back: TestLayer = { color: [0, 1, 0], alpha: 0.6, z: 5 };
    const pixel = await compositeLayers([back, front], SCENE);
    // Sorted "over" would give pure red. The weight is alpha times the depth term and the colour is
    // premultiplied, so at equal depth the layers mix by alpha squared: 1 : 0.36.
    expectPixel(pixel, [1 / 1.36, 0.36 / 1.36, 0, 1], 4e-3);
  });

  it('leaves the scene unchanged when nothing is drawn', async () => {
    const pixel = await compositeLayers([], SCENE);
    // The clear colour itself is rounded to half floats (0.2 reads 0.19995).
    expectPixel(pixel, SCENE, 1e-4);
  });

  it('adds emission unweighted, dimmed by the smoke at the pixel as `occlusion` asks', async () => {
    const flame: TestLayer = { color: [0, 0, 0], alpha: 0, z: 4, emission: [3, 1.2, 0.2] };
    expectPixel(await compositeLayers([flame], SCENE), [3.2, 1.7, 1.1, 1], 4e-3);
    const smoke: TestLayer = { color: [0.1, 0.1, 0.1], alpha: 0.5, z: 3 };
    const dimmed = await compositeLayers([flame, smoke], [0, 0, 0, 0], 1);
    const clear = await compositeLayers([flame, smoke], [0, 0, 0, 0], 0);
    // Smoke colour 0.1 at coverage 0.5, plus the flame times the revealage (0.5) or not at all.
    expectPixel(dimmed, [0.05 + 1.5, 0.05 + 0.6, 0.05 + 0.1, 0.5], 4e-3);
    expectPixel(clear, [0.05 + 3, 0.05 + 1.2, 0.05 + 0.2, 0.5], 4e-3);
  });
});

// ---------------------------------------------------------------------------------------------
// Cost: PSORT_BENCH=1 npx vitest run tests/particle-sort.test.ts (needs a real GPU; minutes)

describe.runIf(process.env.PSORT_BENCH)('depth sort cost', () => {
  it('measures every method at 16k, 64k, 256k and 1M', { timeout: 600_000 }, async () => {
    const bench = await createBenchDevice();
    const { device } = bench;
    const { uniform } = makeCamera(device);
    const counts = [16384, 65536, 262144, 1048576];
    const max = counts[counts.length - 1]!;
    const data = randomPositions(max, 3);
    const positions = uploadPositions(device, data);
    const variants: { name: string; method: SortMethod; keyBits?: 16 | 32; passes?: number }[] = [
      { name: 'radix 32-bit', method: 'radix', keyBits: 32 },
      { name: 'radix 16-bit', method: 'radix', keyBits: 16 },
      { name: 'bitonic', method: 'bitonic' },
      { name: 'temporal (2 passes)', method: 'temporal', passes: 2 },
    ];
    const rows: string[] = [];
    for (const variant of variants) {
      const cells: string[] = [];
      for (const count of counts) {
        const sort = createDepthSort(device, {
          capacity: count,
          camera: uniform.buffer,
          settings: {
            method: variant.method,
            keyBits: variant.keyBits ?? 32,
            temporalPasses: variant.passes ?? 2,
          },
        });
        // Prime the temporal order so later frames take the cheap path.
        const prime = device.createCommandEncoder();
        sort.encode(prime, { positions, count });
        device.queue.submit([prime.finish()]);
        const result = await bench.measure((encoder) =>
          sort.encode(encoder, { positions, count, timestampWrites: bench.profiler.pass('sort') }),
        );
        cells.push(`${result.slopeMs.toFixed(3)} (span ${result.spanMs.toFixed(3)})`);
        sort.destroy();
      }
      rows.push(`${variant.name.padEnd(22)} ${cells.join('  ')}`);
    }
    console.log(
      `depth sort ms per sort (slope; span), counts ${counts.join(', ')}:\n${rows.join('\n')}`,
    );
    positions.destroy();
    bench.destroy();
  });
});

// ---------------------------------------------------------------------------------------------
// The look, in numbers: PSORT_STUDY=1 npx vitest run tests/particle-sort.test.ts -t "blending study"
// Each mode of particle-blending against "sorted" (exact for camera-facing quads, so the reference)
// at the same moments, and how much each changes from one frame to the next (popping).

describe.runIf(process.env.PSORT_STUDY)('blending study', () => {
  it('compares the modes', { timeout: 600_000 }, async () => {
    const { mountHeadless, compositeOver, BACKDROPS } = await import('./headless.ts');
    const modes = ['additive', 'unsorted', 'sorted', 'oit'] as const;
    const extra = process.env.PSORT_STUDY_PARAMS ? JSON.parse(process.env.PSORT_STUDY_PARAMS) : {};
    const mounted = await Promise.all(
      modes.map((mode) =>
        mountHeadless('particle-blending', { width: 640, height: 360, params: { ...extra, mode } }),
      ),
    );
    const page = BACKDROPS.dark!;
    const stats = new Map<string, { err: number[]; big: number[]; pop: number[] }>();
    for (const mode of modes) stats.set(mode, { err: [], big: [], pop: [] });
    for (const seconds of [4, 8, 12, 16, 20]) {
      const frames: Uint8Array[] = [];
      const next: Uint8Array[] = [];
      const after: Uint8Array[] = [];
      for (const m of mounted) {
        await m.runTo(seconds);
        frames.push(compositeOver(await m.read(), page));
        m.step();
        next.push(compositeOver(await m.read(), page));
        m.step();
        after.push(compositeOver(await m.read(), page));
      }
      const reference = frames[modes.indexOf('sorted')]!;
      const pixels = reference.length / 3;
      // The plume: where the reference is not the page.
      const inPlume = (i: number) =>
        [0, 1, 2].some((c) => Math.abs(reference[i * 3 + c]! - page[c]!) > 4);
      modes.forEach((mode, k) => {
        const s = stats.get(mode)!;
        let sum = 0;
        let big = 0;
        let popped = 0;
        let plume = 0;
        for (let i = 0; i < pixels; i++) {
          if (!inPlume(i)) continue;
          plume++;
          let d = 0;
          let f = 0;
          for (let c = 0; c < 3; c++) {
            d = Math.max(d, Math.abs(frames[k]![i * 3 + c]! - reference[i * 3 + c]!));
            // Second difference: steady motion cancels, a jump (a pop) does not.
            const o = i * 3 + c;
            f = Math.max(f, Math.abs(after[k]![o]! - 2 * next[k]![o]! + frames[k]![o]!));
          }
          sum += d;
          if (d > 16) big++;
          if (f > 12) popped++;
        }
        s.err.push(sum / plume);
        s.big.push(big / plume);
        s.pop.push(popped / plume);
      });
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const lines = modes.map((mode) => {
      const s = stats.get(mode)!;
      return `${mode.padEnd(9)} error vs sorted ${mean(s.err).toFixed(2)} levels, ${(mean(s.big) * 100).toFixed(2)}% > 16; pops (second difference > 12 levels): ${(mean(s.pop) * 100).toFixed(3)}% of plume pixels`;
    });
    console.log(`particle-blending study ${JSON.stringify(extra)}:\n${lines.join('\n')}`);
    for (const m of mounted) m.destroy();
  });
});

// The whole effect's frame cost per mode and sort method on Dawn (slope method of tests/bench.ts):
// PSORT_FRAME=1 npx vitest run tests/particle-sort.test.ts -t "frame cost"
describe.runIf(process.env.PSORT_FRAME)('frame cost', () => {
  it('measures particle-blending per mode', { timeout: 600_000 }, async () => {
    const { mountHeadless } = await import('./headless.ts');
    const bench = await createBenchDevice();
    const rows: string[] = [];
    let timing = false;
    const cases: Record<string, Record<string, unknown>> = {
      additive: { mode: 'additive' },
      unsorted: { mode: 'unsorted' },
      'sorted radix': { mode: 'sorted' },
      'sorted bitonic': { mode: 'sorted', sort: 'bitonic' },
      oit: { mode: 'oit' },
    };
    for (const preset of [undefined, 'dense']) {
      for (const [name, params] of Object.entries(cases)) {
        const mounted = await mountHeadless('particle-blending', {
          width: 1920,
          height: 1080,
          preset,
          params,
          device: bench.device,
          // Timed only while measuring: the warm-up would use up the query set.
          profiler: { pass: (label: string) => (timing ? bench.profiler.pass(label) : undefined) },
          format: 'rgba8unorm',
        });
        timing = false;
        await mounted.runTo(5);
        timing = true;
        const result = await bench.measure((encoder) => mounted.encode(encoder));
        rows.push(
          `${(preset ?? 'default').padEnd(8)} ${name.padEnd(15)} ${result.slopeMs.toFixed(2)} ms (span ${result.spanMs.toFixed(2)})`,
        );
        mounted.destroy();
      }
    }
    console.log(`particle-blending frame cost at 1920x1080 on Dawn:\n${rows.join('\n')}`);
    bench.destroy();
  });
});
