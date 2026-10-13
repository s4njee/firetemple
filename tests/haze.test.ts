import { describe, expect, it, vi } from 'vitest';
import { createFullscreenPipeline, renderFullscreen } from '../src/gpu/fullscreen.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless } from './headless.ts';
import { LIBRARY_CHUNKS } from './library.ts';
import { gpuF32, lane, rowsOf } from './wgsl-eval.ts';

vi.setConfig({ testTimeout: 30_000 });

// --- Helpers -------------------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32) so failures reproduce. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` positions spread over a few picture heights, as rows (x, y, a, b) with a, b in [0, 1). */
function randomRows(count: number, seed: number): Float32Array {
  const random = makeRandom(seed);
  const rows = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    rows.set([random() * 4 - 2, random() * 4 - 2, random(), random()], i * 4);
  }
  return rows;
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const meanAbs = (values: number[]) => mean(values.map(Math.abs));

function correlation(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] ?? 0) - ma;
    const db = (b[i] ?? 0) - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return ab / Math.sqrt(aa * bb);
}

const INCLUDE = '#include "haze.wgsl"\n';
const SCALE = 40;
const STRENGTH = 0.004;
const COUNT = 4096;

/** Runs a WGSL body that returns a vec4f from the input row `x`. */
const run = (body: string, rows: Float32Array) =>
  gpuF32(`${INCLUDE} fn f(x: vec4f) -> vec4f { ${body} }`, rows);

// --- The offset field ----------------------------------------------------------------------------

describe('haze_offset', () => {
  it('is exactly zero where there is no heat', async () => {
    const rows = randomRows(COUNT, 1);
    const out = await run(
      `let cold = haze_offset(x.xy, x.z * 7.0, x.w * 9.0, 0.0, ${STRENGTH}, ${SCALE}.0);
       let below = haze_offset(x.xy, x.z * 7.0, x.w * 9.0, -x.w, ${STRENGTH}, ${SCALE}.0);
       return vec4f(cold, below);`,
      rows,
    );
    // Bit-exact zeros, not merely small: an unheated pixel must read the backdrop untouched.
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('never exceeds strength, however hot', async () => {
    const rows = randomRows(COUNT, 2);
    const out = await run(
      `let hot = haze_offset(x.xy, x.z * 5.0, x.w * 5.0, 1.0, ${STRENGTH}, ${SCALE}.0);
       let hotter = haze_offset(x.xy, x.z * 5.0, x.w * 5.0, 50.0, ${STRENGTH}, ${SCALE}.0);
       return vec4f(length(hot), length(hotter), length(haze_direction(x.xy, x.z * 5.0, x.w * 5.0, ${SCALE}.0)), 0.0);`,
      rows,
    );
    const hot = lane(out, 0);
    const hotter = lane(out, 1);
    const direction = lane(out, 2);
    expect(Math.max(...hot)).toBeLessThan(STRENGTH);
    // Heat is clamped to 1, so more heat than that changes nothing.
    expect(hotter).toEqual(hot);
    expect(Math.max(...direction)).toBeLessThan(1);
    // ...and the field actually uses the range it is allowed: not a field of near-zeros.
    expect(mean(direction)).toBeGreaterThan(0.3);
    expect(mean(direction)).toBeLessThan(0.55);
    expect(Math.max(...direction)).toBeGreaterThan(0.8);
  });

  it('scales linearly with heat and with strength', async () => {
    const rows = randomRows(1024, 3);
    const out = await run(
      `let full = haze_offset(x.xy, 0.5, 0.25, 1.0, 0.008, ${SCALE}.0);
       let half_heat = haze_offset(x.xy, 0.5, 0.25, 0.5, 0.008, ${SCALE}.0);
       let half_strength = haze_offset(x.xy, 0.5, 0.25, 1.0, 0.004, ${SCALE}.0);
       return vec4f(full.x, half_heat.x, half_strength.x, full.y - 2.0 * half_heat.y);`,
      rows,
    );
    const full = lane(out, 0);
    lane(out, 1).forEach((v, i) => expect(v).toBeCloseTo((full[i] ?? 0) / 2, 7));
    lane(out, 2).forEach((v, i) => expect(v).toBeCloseTo((full[i] ?? 0) / 2, 7));
    expect(Math.max(...lane(out, 3).map(Math.abs))).toBeLessThan(1e-7);
  });

  it('is mostly sideways, with no net drift', async () => {
    const out = await run(
      `return vec4f(haze_direction(x.xy, x.z, x.w, ${SCALE}.0), 0.0, 0.0);`,
      randomRows(COUNT, 4),
    );
    const dx = lane(out, 0);
    const dy = lane(out, 1);
    expect(meanAbs(dx)).toBeGreaterThan(2 * meanAbs(dy));
    expect(Math.abs(mean(dx))).toBeLessThan(0.05);
    expect(Math.abs(mean(dy))).toBeLessThan(0.05);
  });

  it('forms vertical streaks: it stays alike further along y than along x', async () => {
    // Step by a third of a streak width: across the streak that is a different part of it,
    // along the streak it is still nearly the same place.
    const step = 1 / SCALE / 3;
    const out = await run(
      `let here = haze_direction(x.xy, 0.0, 0.0, ${SCALE}.0).x;
       let aside = haze_direction(x.xy + vec2f(${step}, 0.0), 0.0, 0.0, ${SCALE}.0).x;
       let above = haze_direction(x.xy - vec2f(0.0, ${step}), 0.0, 0.0, ${SCALE}.0).x;
       return vec4f(here, aside, above, 0.0);`,
      randomRows(COUNT, 5),
    );
    const along = correlation(lane(out, 0), lane(out, 2));
    const across = correlation(lane(out, 0), lane(out, 1));
    expect(along).toBeGreaterThan(0.8);
    expect(along).toBeGreaterThan(across + 0.15);
  });

  it('changes with time: both the rise and the boil move it', async () => {
    const out = await run(
      `let now = haze_direction(x.xy, 1.0, 2.0, ${SCALE}.0).x;
       let risen = haze_direction(x.xy, 1.0 + 0.5 / ${SCALE}.0, 2.0, ${SCALE}.0).x;
       let boiled = haze_direction(x.xy, 1.0, 2.5, ${SCALE}.0).x;
       let later = haze_direction(x.xy, 9.0, 11.0, ${SCALE}.0).x;
       return vec4f(now, risen, boiled, later);`,
      randomRows(COUNT, 6),
    );
    const now = lane(out, 0);
    for (const index of [1, 2, 3]) {
      const then = lane(out, index);
      expect(meanAbs(then.map((v, i) => v - (now[i] ?? 0)))).toBeGreaterThan(0.03);
    }
    // A short time later it is still recognisably the same pattern; much later it is unrelated.
    expect(correlation(now, lane(out, 1))).toBeGreaterThan(0.5);
    expect(Math.abs(correlation(now, lane(out, 3)))).toBeLessThan(0.1);
  });

  it('rises: what is at a pixel now was that far below it a moment ago', async () => {
    // Dyadic numbers, so p.y + rise is the same float on both sides of the comparison.
    const random = makeRandom(7);
    const tuples: number[][] = [];
    for (let i = 0; i < 1024; i++) {
      const x = Math.round(random() * 4096) / 1024 - 2;
      const y = Math.round(random() * 4096) / 1024 - 2;
      const rise = Math.round(random() * 2048) / 1024;
      tuples.push([x, y, rise, 0]);
    }
    const travelled = 0.125;
    const out = await run(
      `let later = haze_offset(x.xy, x.z + ${travelled}, 0.75, 1.0, 1.0, ${SCALE}.0);
       let lower = haze_offset(x.xy + vec2f(0.0, ${travelled}), x.z, 0.75, 1.0, 1.0, ${SCALE}.0);
       let same_place = haze_offset(x.xy, x.z, 0.75, 1.0, 1.0, ${SCALE}.0);
       return vec4f(later - lower, later - same_place);`,
      rowsOf(tuples),
    );
    // +y is down the picture, so "lower" is the pixel beneath: the pattern has moved up.
    expect(Math.max(...lane(out, 0).map(Math.abs))).toBeLessThan(1e-5);
    expect(Math.max(...lane(out, 1).map(Math.abs))).toBeLessThan(1e-5);
    // ...and it is not simply standing still.
    expect(meanAbs(lane(out, 2))).toBeGreaterThan(0.1);
  });

  it('gets finer as scale grows', async () => {
    const step = 0.004;
    const out = await run(
      `let coarse = haze_direction(x.xy, 0.0, 0.0, 10.0).x - haze_direction(x.xy + vec2f(${step}, 0.0), 0.0, 0.0, 10.0).x;
       let fine = haze_direction(x.xy, 0.0, 0.0, 80.0).x - haze_direction(x.xy + vec2f(${step}, 0.0), 0.0, 0.0, 80.0).x;
       return vec4f(coarse, fine, 0.0, 0.0);`,
      randomRows(COUNT, 8),
    );
    expect(meanAbs(lane(out, 1))).toBeGreaterThan(3 * meanAbs(lane(out, 0)));
  });
});

// --- Sampling the backdrop -----------------------------------------------------------------------

const SIZE = 32;

/** A backdrop of random colours whose mip level 1 is flat blue, so reading it is unmistakable. */
async function createBackdrop(device: GPUDevice): Promise<GPUTexture> {
  const texture = device.createTexture({
    label: 'haze test backdrop',
    size: [SIZE, SIZE],
    format: 'rgba8unorm',
    mipLevelCount: 2,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const random = makeRandom(99);
  const base = new Uint8Array(SIZE * SIZE * 4).map(() => Math.floor(random() * 256));
  device.queue.writeTexture({ texture }, base, { bytesPerRow: SIZE * 4 }, [SIZE, SIZE]);
  const half = SIZE / 2;
  const blue = new Uint8Array(half * half * 4);
  for (let i = 0; i < half * half; i++) blue.set([0, 0, 255, 255], i * 4);
  device.queue.writeTexture({ texture, mipLevel: 1 }, blue, { bytesPerRow: half * 4 }, [
    half,
    half,
  ]);
  return texture;
}

let shaderCounter = 0;

/**
 * Draws `expression` (a vec4f; `uv`, `offset` and `heat` are in scope, `backdrop` and `samp` bound)
 * over a SIZE x SIZE target and returns its bytes. The offset is a real haze offset, large enough
 * to cross several texels.
 */
async function renderSampled(expression: string, heat: string): Promise<Uint8Array> {
  const device = await getTestDevice();
  return expectValid(device, async () => {
    const backdrop = await createBackdrop(device);
    const target = device.createTexture({
      size: [SIZE, SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: {
        label: `haze-sample-${shaderCounter++}.wgsl`,
        code: `#include "fullscreen.wgsl"
#include "haze.wgsl"
@group(0) @binding(0) var backdrop: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv;
  let heat = ${heat};
  let offset = haze_offset(uv, 0.25, 0.5, heat, 0.2, 9.0);
  return ${expression};
}`,
        chunks: LIBRARY_CHUNKS,
      },
      format: 'rgba8unorm',
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: backdrop.createView() },
        {
          binding: 1,
          resource: device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
          }),
        },
      ],
    });
    const encoder = device.createCommandEncoder();
    renderFullscreen(encoder, target.createView(), pipeline, [bindGroup]);
    device.queue.submit([encoder.finish()]);
    const pixels = await readTexture(device, target);
    backdrop.destroy();
    target.destroy();
    return pixels;
  });
}

/** Channel `channel` (0..3) of every pixel. */
const channelOf = (pixels: Uint8Array, channel: number) =>
  Array.from(pixels.filter((_, i) => i % 4 === channel));

const differing = (a: number[], b: number[]) => a.filter((v, i) => v !== b[i]).length;

describe('haze samplers', () => {
  it('haze_sample with no offset is the backdrop itself', async () => {
    const plain = await renderSampled('textureSampleLevel(backdrop, samp, uv, 0.0)', '1.0');
    const cold = await renderSampled('haze_sample(backdrop, samp, uv, offset)', '0.0');
    const coldSoft = await renderSampled(
      'haze_sample_soft(backdrop, samp, uv, offset, heat, 0.4, 2.0)',
      '0.0',
    );
    expect(Array.from(cold)).toEqual(Array.from(plain));
    // No heat: no offset, no fringe and no blur, whatever the other settings say.
    expect(Array.from(coldSoft)).toEqual(Array.from(plain));
  });

  it('haze_sample displaces the picture where it is hot', async () => {
    const plain = await renderSampled('textureSampleLevel(backdrop, samp, uv, 0.0)', '1.0');
    const hot = await renderSampled('haze_sample(backdrop, samp, uv, offset)', '1.0');
    expect(differing(Array.from(hot), Array.from(plain))).toBeGreaterThan(SIZE * SIZE);
  });

  it('haze_sample_chroma equals haze_sample when the split is zero', async () => {
    const plain = await renderSampled('haze_sample(backdrop, samp, uv, offset)', '1.0');
    const chroma = await renderSampled(
      'haze_sample_chroma(backdrop, samp, uv, offset, 0.0)',
      '1.0',
    );
    expect(Array.from(chroma)).toEqual(Array.from(plain));
  });

  it('haze_sample_chroma moves red and blue apart and leaves green and alpha alone', async () => {
    const plain = await renderSampled('haze_sample(backdrop, samp, uv, offset)', '1.0');
    const chroma = await renderSampled(
      'haze_sample_chroma(backdrop, samp, uv, offset, 0.5)',
      '1.0',
    );
    const count = SIZE * SIZE;
    expect(differing(channelOf(chroma, 0), channelOf(plain, 0))).toBeGreaterThan(count / 2);
    expect(differing(channelOf(chroma, 2), channelOf(plain, 2))).toBeGreaterThan(count / 2);
    expect(channelOf(chroma, 1)).toEqual(channelOf(plain, 1));
    expect(channelOf(chroma, 3)).toEqual(channelOf(plain, 3));
  });

  it('haze_sample_soft equals haze_sample_chroma when the blur is zero', async () => {
    const chroma = await renderSampled(
      'haze_sample_chroma(backdrop, samp, uv, offset, 0.3)',
      '1.0',
    );
    const soft = await renderSampled(
      'haze_sample_soft(backdrop, samp, uv, offset, heat, 0.3, 0.0)',
      '1.0',
    );
    expect(Array.from(soft)).toEqual(Array.from(chroma));
  });

  it('haze_sample_soft reads mip level blur * heat', async () => {
    // Level 1 of the test backdrop is flat blue.
    const full = await renderSampled(
      'haze_sample_soft(backdrop, samp, uv, offset, heat, 0.0, 1.0)',
      '1.0',
    );
    for (let i = 0; i < full.length; i += 4) {
      expect([full[i], full[i + 1], full[i + 2], full[i + 3]]).toEqual([0, 0, 255, 255]);
    }
    // Half the heat is half way between level 0 and level 1: blue pulled half way up, and the
    // red of level 0 (uniform random, mean about half) half gone.
    const half = await renderSampled(
      'haze_sample_soft(backdrop, samp, uv, offset, heat, 0.0, 1.0)',
      '0.5',
    );
    expect(Math.min(...channelOf(half, 2))).toBeGreaterThanOrEqual(127);
    expect(Math.max(...channelOf(half, 0))).toBeLessThanOrEqual(128);
    expect(mean(channelOf(half, 0))).toBeGreaterThan(40);
  });
});

// --- The heat-haze effect ------------------------------------------------------------------------

describe('heat-haze effect', () => {
  const WIDTH = 160;
  const HEIGHT = 120;
  // Bloom spreads light across the frame; without it a pixel depends only on its own scene texel.
  const noBloom = { bloom: 0 };

  async function frame(preset: string | undefined, params: Record<string, unknown>) {
    const mounted = await mountHeadless('heat-haze', {
      width: WIDTH,
      height: HEIGHT,
      preset,
      params: { ...noBloom, ...params },
    });
    await mounted.runTo(0.5);
    const pixels = await mounted.read();
    mounted.destroy();
    return pixels;
  }

  const rowsDiffering = (a: Uint8Array, b: Uint8Array) => {
    const rows: number[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      const from = y * WIDTH * 4;
      const to = from + WIDTH * 4;
      if (a.subarray(from, to).some((v, i) => v !== b[from + i])) rows.push(y);
    }
    return rows;
  };

  it('leaves the backdrop untouched above the heat, and distorts it below', async () => {
    const height = 0.5;
    const on = await frame('furnace', { height });
    const off = await frame('furnace', { height, strength: 0, chroma: 0, blur: 0 });
    const rows = rowsDiffering(on, off);
    // The ember bed is the bottom 7%; the heat ends `height` above it.
    const top = Math.floor((1 - 0.07 - height) * HEIGHT);
    expect(rows.length).toBeGreaterThan(HEIGHT / 4);
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(top);
  });

  it('moves: two moments differ in the heated air, and freeze when the rise speed is zero', async () => {
    const mounted = await mountHeadless('heat-haze', {
      width: WIDTH,
      height: HEIGHT,
      params: { ...noBloom, fire: 0, strength: 1 },
    });
    await mounted.runTo(0.5);
    const before = await mounted.read();
    await mounted.runTo(0.7);
    const after = await mounted.read();
    expect(rowsDiffering(before, after).length).toBeGreaterThan(HEIGHT / 8);

    mounted.params.rise = 0;
    await mounted.runTo(0.9);
    const held = await mounted.read();
    await mounted.runTo(1.1);
    const still = await mounted.read();
    // The tail dithers with a per-frame pattern, so compare loosely: nothing moved by a visible step.
    let largest = 0;
    for (let i = 0; i < held.length; i++) {
      largest = Math.max(largest, Math.abs((held[i] ?? 0) - (still[i] ?? 0)));
    }
    expect(largest).toBeLessThanOrEqual(2);
    mounted.destroy();
  });

  it('redraws its backdrop on a resize and on a change of style without a validation error', async () => {
    const device = await getTestDevice();
    await expectValid(device, async () => {
      const mounted = await mountHeadless('heat-haze', { width: WIDTH, height: HEIGHT });
      mounted.step(2);
      const dark = await mounted.read();
      mounted.params.backdrop = 'light page';
      mounted.step(2);
      const light = await mounted.read();
      mounted.instance.resize(WIDTH * 2, HEIGHT, 1);
      mounted.step(2);
      mounted.instance.resize(WIDTH, HEIGHT, 1);
      mounted.params.view = 'heat mask';
      mounted.step(2);
      await device.queue.onSubmittedWorkDone();
      mounted.destroy();
      // The page went from dark to paper: the top-left pixel, far from the fire, says which.
      expect(dark[0]).toBeLessThan(60);
      expect(light[0]).toBeGreaterThan(180);
    });
  });
});
