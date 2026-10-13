import { describe, expect, it, vi } from 'vitest';
import { createFullscreenPipeline, renderFullscreen } from '../src/gpu/fullscreen.ts';
import { linearizeDepth } from '../src/gpu/scene/camera.ts';
import { createShader } from '../src/gpu/shader.ts';
import {
  createBlueNoiseTexture,
  createReducedVolume,
  defaultBlueNoise,
  generateBlueNoise,
  reducedSize,
  type ReducedVolume,
  type UpsampleFilter,
  type VolumeDivisor,
} from '../src/gpu/volume/index.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { LIBRARY_CHUNKS } from './library.ts';
import { gpuF32, lane, rowsOf, scalars } from './wgsl-eval.ts';

// The ray-march kernel (story 3.12): src/wgsl/volume.wgsl proven against closed forms with numbers
// computed on the GPU, the blue-noise generator, and the reduced-resolution passes of
// src/gpu/volume/ run on real textures.

vi.setConfig({ testTimeout: 60_000 });

const INCLUDE = '#include "volume.wgsl"';

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

/** Source * (1 - exp(-sigma d)) / sigma: what a uniform emitting, absorbing slab sends out. */
const slabRadiance = (source: number, sigma: number, thickness: number) =>
  sigma > 0 ? (source * (1 - Math.exp(-sigma * thickness))) / sigma : source * thickness;

// --- Emission and absorption ---------------------------------------------------------------------

describe('volume.wgsl: emission-absorption integration', () => {
  const EMISSION = [3, 1.5, 0.4] as const;
  const SIGMA = [0.8, 1.2, 2] as const;
  const THICKNESS = 2.5;

  it('a uniform emissive-absorbing slab matches the closed form at any step count', async () => {
    const stepCounts = [1, 2, 4, 16, 64, 256];
    const jitters = [0, 0.37, 0.93];
    const rows = stepCounts.flatMap((steps) => jitters.map((jitter) => [steps, jitter]));
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let medium = volume_emitter(vec3f(${EMISSION.join(', ')}), vec3f(${SIGMA.join(', ')}));
         let m = volume_march_steps(vec2f(1.5, 1.5 + ${THICKNESS}), i32(x.x), x.y);
         var acc = volume_start();
         for (var i = 0; i < m.steps; i++) {
           acc = volume_accumulate_medium(acc, medium, m.ds);
         }
         return vec4f(acc.radiance, acc.transmittance.y);
       }`,
      rowsOf(rows),
    );
    rows.forEach(([steps], row) => {
      for (let c = 0; c < 3; c++) {
        const expected = slabRadiance(EMISSION[c]!, SIGMA[c]!, THICKNESS);
        expect(out[row * 4 + c], `${steps} steps, channel ${c}`).toBeCloseTo(expected, 4);
      }
      expect(out[row * 4 + 3]).toBeCloseTo(Math.exp(-SIGMA[1] * THICKNESS), 5);
    });
  });

  it('volume_slab_radiance is that closed form, including sigma = 0', async () => {
    const [absorbing, clear, opaque] = await scalars(INCLUDE, [
      'volume_slab_radiance(vec3f(3.0), vec3f(0.8), 2.5).x',
      'volume_slab_radiance(vec3f(3.0), vec3f(0.0), 2.5).x',
      'volume_slab_radiance(vec3f(3.0), vec3f(40.0), 2.5).x',
    ]);
    expect(absorbing).toBeCloseTo(slabRadiance(3, 0.8, 2.5), 5);
    expect(clear).toBeCloseTo(7.5, 5);
    expect(opaque).toBeCloseTo(3 / 40, 6);
  });

  it('a thermal emitter never exceeds its radiance and converges for any density profile', async () => {
    // Density rises as a bump across the slab. For source = sigma * L the exact answer is
    // L * (1 - exp(-tau)) whatever the profile, with tau the optical depth of the whole ray.
    const peak = 6;
    const length = 2;
    const steps = [4, 16, 64, 256];
    const out = await gpuF32(
      `${INCLUDE}
       fn density(t: f32) -> f32 { let u = t / ${length}.0; return ${peak}.0 * 4.0 * u * (1.0 - u); }
       fn f(x: vec4f) -> vec4f {
         let m = volume_march_steps(vec2f(0.0, ${length}.0), i32(x.x), 0.5);
         var acc = volume_start();
         for (var i = 0; i < m.steps; i++) {
           let sigma = vec3f(density(volume_march_t(m, i)));
           acc = volume_accumulate_medium(acc, volume_emitter_thermal(vec3f(12.0), sigma), m.ds);
         }
         return vec4f(acc.radiance.x, acc.transmittance.x, 0.0, 0.0);
       }`,
      rowsOf(steps.map((s) => [s])),
    );
    // Integral of 4 * peak * u * (1 - u) over the slab is peak * length * 2 / 3.
    const tau = (peak * length * 2) / 3;
    const exact = 12 * (1 - Math.exp(-tau));
    const errors = lane(out, 0).map((value) => Math.abs(value - exact));
    for (const value of lane(out, 0)) expect(value).toBeLessThanOrEqual(12);
    for (let i = 1; i < errors.length; i++) expect(errors[i]!).toBeLessThanOrEqual(errors[i - 1]!);
    expect(errors[1]! / exact).toBeLessThan(0.01);
    expect(errors[3]! / exact).toBeLessThan(1e-4);
    expect(lane(out, 1)[3]).toBeCloseTo(Math.exp(-tau), 4);
  });

  it('integrates fire behind smoke, and fire inside smoke, in one march', async () => {
    const [behind, inside, emptyHit] = await scalars(
      `${INCLUDE}
       const FIRE = vec3f(9.0);
       const FIRE_SIGMA = vec3f(0.7);
       const SMOKE_SIGMA = vec3f(1.9);
       const SMOKE_ALBEDO = vec3f(0.4);
       const LIGHT = vec3f(0.6);
       fn smoke() -> VolumeMedium { return volume_scatterer(SMOKE_SIGMA, SMOKE_ALBEDO, LIGHT); }
       fn fire() -> VolumeMedium { return volume_emitter(FIRE, FIRE_SIGMA); }
       // Smoke fills 0..1, fire 1..2; with an even step count the steps line up with the boundary.
       fn layered(steps: i32) -> f32 {
         let m = volume_march_steps(vec2f(0.0, 2.0), steps, 0.3);
         var acc = volume_start();
         for (var i = 0; i < m.steps; i++) {
           if (volume_march_t(m, i) < 1.0) {
             acc = volume_accumulate_medium(acc, smoke(), m.ds);
           } else {
             acc = volume_accumulate_medium(acc, fire(), m.ds);
           }
         }
         return acc.radiance.x;
       }
       fn mixed(steps: i32) -> f32 {
         let m = volume_march_steps(vec2f(0.0, 1.0), steps, 0.3);
         var acc = volume_start();
         for (var i = 0; i < m.steps; i++) {
           acc = volume_accumulate_medium(acc, volume_combine(smoke(), fire()), m.ds);
         }
         return acc.radiance.x;
       }`,
      [
        'layered(8)',
        'mixed(8)',
        'volume_accumulate_medium(volume_start(), volume_vacuum(), 3.0).radiance.x',
      ],
    );
    const smokeOut = slabRadiance(1.9 * 0.4 * 0.6, 1.9, 1);
    const fireOut = slabRadiance(9, 0.7, 1);
    expect(behind).toBeCloseTo(smokeOut + Math.exp(-1.9) * fireOut, 4);
    expect(inside).toBeCloseTo(slabRadiance(9 + 1.9 * 0.4 * 0.6, 0.7 + 1.9, 1), 4);
    expect(emptyHit).toBe(0);
  });

  it('early termination changes the result by no more than its threshold allows', async () => {
    const thresholds = [0.001, 0.01, 0.05, 0.2];
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let medium = volume_emitter(vec3f(8.0, 5.0, 2.0), vec3f(3.0, 3.5, 4.0));
         let m = volume_march_steps(vec2f(0.0, 4.0), 64, 0.5);
         var full = volume_start();
         var early = volume_start();
         var taken = 0;
         var stopped = false;
         for (var i = 0; i < m.steps; i++) {
           full = volume_accumulate_medium(full, medium, m.ds);
           if (!stopped) {
             early = volume_accumulate_medium(early, medium, m.ds);
             taken++;
             stopped = volume_opaque(early, x.x);
           }
         }
         let lost = full.radiance - early.radiance;
         return vec4f(max(lost.x, max(lost.y, lost.z)), f32(taken), volume_resolve(early, x.x).a,
                      volume_resolve(full, 0.0).a);
       }`,
      rowsOf(thresholds.map((t) => [t])),
    );
    thresholds.forEach((threshold, row) => {
      const lost = out[row * 4]!;
      // What is left behind a transmittance T is at most T * source / sigma in every channel.
      expect(lost).toBeGreaterThanOrEqual(0);
      expect(lost).toBeLessThanOrEqual(threshold * (8 / 3) + 1e-6);
      expect(out[row * 4 + 1]).toBeLessThan(64);
      // An early exit resolves to fully opaque rather than leaving `threshold` of the background.
      expect(out[row * 4 + 2]).toBe(0);
    });
    // A lower threshold marches further.
    const taken = lane(out, 1);
    for (let i = 1; i < taken.length; i++) expect(taken[i]!).toBeLessThanOrEqual(taken[i - 1]!);
    expect(out[3]).toBeGreaterThanOrEqual(0);
  });

  it('volume_resolve remaps the threshold to 0 and leaves a clear ray clear', async () => {
    const values = await scalars(INCLUDE, [
      'volume_resolve(volume_start(), 0.05).a',
      'volume_resolve(VolumeAccum(vec3f(1.0), vec3f(0.05)), 0.05).a',
      'volume_resolve(VolumeAccum(vec3f(1.0), vec3f(0.525)), 0.05).a',
      'volume_resolve(VolumeAccum(vec3f(1.0), vec3f(0.3, 0.6, 0.9)), 0.0).a',
      'volume_resolve(VolumeAccum(vec3f(2.0, 3.0, 4.0), vec3f(0.5)), 0.05).g',
    ]);
    expect(values[0]).toBe(1);
    expect(values[1]).toBeCloseTo(0, 6);
    expect(values[2]).toBeCloseTo(0.5, 6);
    expect(values[3]).toBeCloseTo(0.6, 6);
    expect(values[4]).toBe(3);
  });

  it('transmittance stays in 0..1 and radiance finite for any input', async () => {
    const random = makeRandom(7);
    const rows: number[][] = [];
    for (let i = 0; i < 2048; i++) {
      // Includes negative extinction and step lengths, zero, and far too dense media.
      rows.push([
        random() * 60 - 2,
        random() < 0.1 ? 0 : random() * 6 - 0.5,
        random() * 40,
        Math.floor(random() * 40) + 1,
      ]);
    }
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         var acc = volume_start();
         for (var i = 0; i < i32(x.w); i++) {
           let sigma = vec3f(x.x, x.x * 0.5, x.x * 2.0);
           acc = volume_accumulate(acc, sigma, vec3f(x.z, 1.0, 0.0), x.y);
         }
         let t = acc.transmittance;
         return vec4f(min(t.x, min(t.y, t.z)), max(t.x, max(t.y, t.z)), acc.radiance.x,
                      volume_resolve(acc, 0.01).a);
       }`,
      rowsOf(rows),
    );
    const problems: string[] = [];
    rows.forEach((input, row) => {
      const [low, high, radiance, alpha] = out.subarray(row * 4, row * 4 + 4);
      const ok =
        low! >= 0 &&
        high! <= 1 &&
        Number.isFinite(radiance!) &&
        radiance! >= 0 &&
        alpha! >= 0 &&
        alpha! <= 1;
      if (!ok) problems.push(`${input.join(', ')} -> ${low}, ${high}, ${radiance}, ${alpha}`);
    });
    expect(problems.slice(0, 5)).toEqual([]);
  });
});

// --- Stepping ------------------------------------------------------------------------------------

describe('volume.wgsl: step control and clipping', () => {
  const march = (call: string) =>
    gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let m = ${call};
         return vec4f(m.t, m.ds, f32(m.steps), volume_march_t(m, m.steps - 1));
       }`,
      rowsOf([[0]]),
    );

  it('volume_march_steps covers the span with exactly the steps asked for', async () => {
    const [t, ds, steps, last] = await march('volume_march_steps(vec2f(2.0, 5.0), 12, 0.25)');
    expect(steps).toBe(12);
    expect(ds).toBeCloseTo(0.25, 6);
    expect(t).toBeCloseTo(2 + 0.25 * 0.25, 6);
    expect(last).toBeCloseTo(5 - 0.25 + 0.0625, 5);
    const clamped = await march('volume_march_steps(vec2f(2.0, 5.0), 100000, 0.0)');
    expect(clamped[2]).toBe(256);
    expect((await march('volume_march_steps(vec2f(2.0, 5.0), 0, 0.0)'))[2]).toBe(1);
  });

  it('volume_march_length takes fewer steps on a shorter span and stretches at the cap', async () => {
    const long = await march('volume_march_length(vec2f(1.0, 4.0), 0.1, 64, 0.5)');
    expect(long[2]).toBe(30);
    expect(long[1]).toBeCloseTo(0.1, 5);
    const short = await march('volume_march_length(vec2f(1.0, 1.25), 0.1, 64, 0.5)');
    expect(short[2]).toBe(3);
    expect(short[1]! * short[2]!).toBeCloseTo(0.25, 6);
    // 3 units at 0.01 would be 300 steps; capped at 20, the step grows so the span is still covered.
    const capped = await march('volume_march_length(vec2f(1.0, 4.0), 0.01, 20, 0.5)');
    expect(capped[2]).toBe(20);
    expect(capped[1]! * capped[2]!).toBeCloseTo(3, 5);
    // Every sample is inside the span.
    expect(capped[0]).toBeGreaterThan(1);
    expect(capped[3]).toBeLessThan(4);
    const empty = await march('volume_march_length(vec2f(3.0, 2.0), 0.1, 64, 0.5)');
    expect(empty[2]).toBe(1);
    expect(empty[1]).toBe(0);
  });

  it('clips the span at scene geometry and converts view depth to ray distance', async () => {
    const values = await scalars(INCLUDE, [
      'volume_clip_span(vec2f(2.0, 6.0), 4.5).y',
      'volume_clip_span(vec2f(2.0, 6.0), 9.0).y',
      'f32(volume_hit(volume_clip_span(vec2f(2.0, 6.0), 1.5)))',
      'volume_clip_span(vec2f(2.0, 6.0), 1.5).x',
      // A ray 60 degrees off the view axis travels twice the view depth.
      'volume_depth_to_distance(5.0, vec3f(0.8660254, 0.0, -0.5), vec3f(0.0, 0.0, -1.0))',
      'volume_depth_to_distance(5.0, vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, -1.0))',
    ]);
    expect(values[0]).toBe(4.5);
    expect(values[1]).toBe(6);
    expect(values[2]).toBe(0);
    expect(values[3]).toBe(2);
    expect(values[4]).toBeCloseTo(10, 4);
    expect(values[5]).toBeCloseTo(5, 6);
  });

  it('jitter stays in [0, 1) and animating it keeps it there', async () => {
    const rows: number[][] = [];
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) rows.push([x + 0.5, y + 0.5, y]);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let still = volume_jitter(x.xy, 0u);
         return vec4f(still, volume_jitter(x.xy, u32(x.z)), volume_jitter_animate(still, u32(x.z)),
                      volume_jitter_animate(still, 0u));
       }`,
      rowsOf(rows),
    );
    for (let laneIndex = 0; laneIndex < 3; laneIndex++) {
      const values = lane(out, laneIndex);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...values)).toBeLessThan(1);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      expect(mean).toBeGreaterThan(0.45);
      expect(mean).toBeLessThan(0.55);
    }
    // Frame 0 leaves a jitter as it is.
    expect(lane(out, 3)).toEqual(lane(out, 0));
  });
});

// --- Blue noise ----------------------------------------------------------------------------------

/** Variance of the mean of every `block` x `block` window (wrapping), a measure of low-frequency energy. */
function windowVariance(tile: ArrayLike<number>, size: number, block: number): number {
  let sum = 0;
  let squares = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let total = 0;
      for (let by = 0; by < block; by++) {
        for (let bx = 0; bx < block; bx++) {
          total += tile[((y + by) % size) * size + ((x + bx) % size)]! / 255;
        }
      }
      const mean = total / (block * block);
      sum += mean;
      squares += mean * mean;
    }
  }
  const count = size * size;
  return squares / count - (sum / count) ** 2;
}

describe('blue noise', () => {
  it('holds every value equally often', () => {
    const tile = generateBlueNoise({ size: 32 });
    expect(tile.length).toBe(1024);
    const histogram = new Array<number>(256).fill(0);
    for (const value of tile) histogram[value]!++;
    expect(new Set(histogram)).toEqual(new Set([4]));
  });

  it('is deterministic per seed and different across seeds', () => {
    const a = generateBlueNoise({ size: 16, seed: 3 });
    expect(generateBlueNoise({ size: 16, seed: 3 })).toEqual(a);
    expect(generateBlueNoise({ size: 16, seed: 4 })).not.toEqual(a);
    expect(defaultBlueNoise()).toBe(defaultBlueNoise());
    expect(defaultBlueNoise().length).toBe(64 * 64);
  });

  it('has far less low-frequency energy than white noise, across the wrap too', () => {
    const size = 64;
    const blue = defaultBlueNoise();
    const random = makeRandom(11);
    const white = Uint8Array.from({ length: size * size }, () => Math.floor(random() * 256));
    // Per-texel variance is the same (a flat histogram): about 1/12.
    expect(windowVariance(blue, size, 1)).toBeCloseTo(1 / 12, 2);
    // Averaged over a window, white noise keeps 1/n of it; blue noise keeps a fraction of that,
    // and a smaller one the wider the window (measured: 0.30, 0.19, 0.17, 0.07).
    const limits = { 2: 0.4, 3: 0.3, 4: 0.25, 8: 0.12 };
    for (const [block, limit] of Object.entries(limits)) {
      const ratio =
        windowVariance(blue, size, Number(block)) / windowVariance(white, size, Number(block));
      expect(ratio, `${block}x${block} window`).toBeLessThan(limit);
    }
  });

  it('volume_jitter_blue reads the tile, wraps it and stays inside (0, 1)', async () => {
    const device = await getTestDevice();
    const tile = defaultBlueNoise();
    const texture = createBlueNoiseTexture(device);
    const width = 80;
    const height = 70;
    const target = device.createTexture({
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    await expectValid(device, () => {
      const pipeline = createFullscreenPipeline(device, {
        label: 'test blue jitter',
        fragment: {
          label: 'test-blue-jitter.wgsl',
          code: `#include "fullscreen.wgsl"
                 #include "volume.wgsl"
                 @group(0) @binding(0) var noise: texture_2d<f32>;
                 @fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
                   return vec4f(volume_jitter_blue(noise, in.position.xy, 0u), 0.0, 0.0, 1.0);
                 }`,
          chunks: LIBRARY_CHUNKS,
        },
        format: 'r32float',
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
      });
      const encoder = device.createCommandEncoder();
      renderFullscreen(encoder, target.createView(), pipeline, [group]);
      device.queue.submit([encoder.finish()]);
    });
    const pixels = new Float32Array((await readTexture(device, target, 4)).buffer);
    let worst = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const expected = (tile[(y % 64) * 64 + (x % 64)]! + 0.5) / 256;
        worst = Math.max(worst, Math.abs(pixels[y * width + x]! - expected));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(Math.min(...pixels)).toBeGreaterThan(0);
    expect(Math.max(...pixels)).toBeLessThan(1);
    texture.destroy();
    target.destroy();
  });
});

// --- Upsample weights ----------------------------------------------------------------------------

describe('volume.wgsl: depth-aware upsample weights', () => {
  const weights = (rows: number[][], depths: string, depth: string, tolerance = 0.02) =>
    gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let bilinear = volume_bilinear_weights(x.xy);
         return volume_upsample_weights(bilinear, ${depths}, ${depth}, ${tolerance});
       }`,
      rowsOf(rows),
    );
  const fractions = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.125, 0.875],
    [0.5, 0.5],
    [0, 0],
    [0.999, 0.001],
  ];

  it('bilinear weights sum to 1 and follow the texel order', async () => {
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f { return volume_bilinear_weights(x.xy); }`,
      rowsOf([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0.25, 0.75],
      ]),
    );
    expect([...out.subarray(0, 16)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect([...out.subarray(16, 20)]).toEqual([0.1875, 0.0625, 0.5625, 0.1875]);
  });

  it('equal depths give the bilinear weights', async () => {
    const out = await weights(fractions, 'vec4f(7.5)', '7.5');
    fractions.forEach(([fx, fy], row) => {
      const expected = [(1 - fx!) * (1 - fy!), fx! * (1 - fy!), (1 - fx!) * fy!, fx! * fy!];
      for (let i = 0; i < 4; i++) expect(out[row * 4 + i]).toBeCloseTo(expected[i]!, 3);
      expect(out[row * 4]! + out[row * 4 + 1]! + out[row * 4 + 2]! + out[row * 4 + 3]!).toBeCloseTo(
        1,
        6,
      );
    });
  });

  it('texels on the far side of a silhouette drop out', async () => {
    // Texels 0 and 2 were marched to the near surface at 2, texels 1 and 3 to the wall at 20.
    const near = await weights(fractions, 'vec4f(2.0, 20.0, 2.0, 20.0)', '2.0');
    const far = await weights(fractions, 'vec4f(2.0, 20.0, 2.0, 20.0)', '20.0');
    fractions.forEach((_, row) => {
      expect(near[row * 4 + 1]! + near[row * 4 + 3]!).toBeLessThan(2e-3);
      expect(near[row * 4]! + near[row * 4 + 2]!).toBeGreaterThan(0.998);
      expect(far[row * 4]! + far[row * 4 + 2]!).toBeLessThan(2e-3);
    });
  });

  it('with no matching texel the closest in depth dominates, and the weights stay finite', async () => {
    // The fractions a half- or quarter-resolution upsample actually produces.
    const real = [0.125, 0.375, 0.625, 0.875, 0.25, 0.75].flatMap((fx) => [
      [fx, 0.125],
      [fx, 0.75],
    ]);
    const out = await weights(real, 'vec4f(2.0, 4.0, 20.0, 90.0)', '5.0');
    real.forEach((_, row) => {
      const w = [...out.subarray(row * 4, row * 4 + 4)];
      expect(w.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(w.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
      expect(w[1]).toBeGreaterThan(0.5);
    });
    // Hopelessly far from every texel (and a tiny tolerance): still a valid set of weights.
    const extreme = await weights(fractions, 'vec4f(900.0, 950.0, 990.0, 1000.0)', '0.05', 1e-7);
    for (const value of extreme) expect(Number.isFinite(value)).toBe(true);
    expect(extreme[0]! + extreme[1]! + extreme[2]! + extreme[3]!).toBeCloseTo(1, 5);
  });
});

// --- Reduced-resolution passes -------------------------------------------------------------------

const NEAR = 0.1;
const FAR = 100;
/** Depth-buffer value of a view-space depth, the inverse of `linearizeDepth`. */
const depthOf = (z: number) => (FAR * (z - NEAR)) / (z * (FAR - NEAR));

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

async function readHalf(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const bytes = await readTexture(device, texture, 8);
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return Float32Array.from(words, halfToFloat);
}

interface Rig {
  device: GPUDevice;
  width: number;
  height: number;
  volume: ReducedVolume;
  sceneDepth: GPUTexture;
  color: GPUTexture;
  /** Fills the scene depth: `expression` is WGSL for a view-space depth, with `p` the pixel (vec2f). */
  drawDepth(expression: string): void;
  /** Runs the three passes; `marchBody` is WGSL returning vec4f(radiance, transmittance), with `z` the texel's view depth. */
  run(
    marchBody: string,
    filter: UpsampleFilter,
    background: number,
    depthLimit?: number,
  ): Promise<Float32Array>;
  destroy(): void;
}

let rigCounter = 0;

async function createRig(width: number, height: number, divisor: VolumeDivisor): Promise<Rig> {
  const device = await getTestDevice();
  const volume = createReducedVolume(device, { label: 'test volume', divisor, readback: true });
  volume.resize(width, height, divisor);
  const sceneDepth = device.createTexture({
    size: [width, height],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const color = device.createTexture({
    size: [width, height],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depthView = sceneDepth.createView();
  const colorView = color.createView();

  return {
    device,
    width,
    height,
    volume,
    sceneDepth,
    color,
    drawDepth(expression) {
      const module = createShader(device, {
        label: `test-depth-${rigCounter++}.wgsl`,
        code: `#include "fullscreen.wgsl"
               @fragment fn fs(in: FullscreenVarying) -> @builtin(frag_depth) f32 {
                 let p = floor(in.position.xy);
                 let z = ${expression};
                 return ${FAR} * (z - ${NEAR}) / (z * (${FAR} - ${NEAR}));
               }`,
        chunks: LIBRARY_CHUNKS,
      });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'fullscreen_vs' },
        fragment: { module, entryPoint: 'fs', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    async run(marchBody, filter, background, depthLimit) {
      const layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'unfilterable-float' },
          },
        ],
      });
      const marchPipeline = createFullscreenPipeline(device, {
        label: 'test march',
        fragment: {
          label: `test-march-${rigCounter++}.wgsl`,
          code: `#include "fullscreen.wgsl"
                 @group(0) @binding(0) var march_depth: texture_2d<f32>;
                 @fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
                   let z = textureLoad(march_depth, vec2i(in.position.xy), 0).r;
                   ${marchBody}
                 }`,
          chunks: LIBRARY_CHUNKS,
        },
        format: volume.target.format,
        layout: [layout],
      });
      const group = device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: volume.depth.view }],
      });
      const encoder = device.createCommandEncoder();
      // The scene: a flat colour.
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: colorView,
              clearValue: { r: background, g: background, b: background, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        .end();
      volume.encodeDepth(encoder, {
        sceneDepth: depthView,
        near: NEAR,
        far: FAR,
        filter,
        depthLimit,
      });
      renderFullscreen(encoder, volume.target.view, marchPipeline, [group]);
      volume.composite(encoder, {
        color: { view: colorView, format: 'rgba16float' },
        sceneDepth: depthView,
        filter,
      });
      device.queue.submit([encoder.finish()]);
      return readHalf(device, color);
    },
    destroy() {
      volume.destroy();
      sceneDepth.destroy();
      color.destroy();
    },
  };
}

describe('reduced-resolution march', () => {
  it('sizes the march target so every scene pixel is covered', async () => {
    expect(reducedSize(960, 2)).toBe(480);
    expect(reducedSize(37, 2)).toBe(19);
    expect(reducedSize(37, 4)).toBe(10);
    expect(reducedSize(1, 4)).toBe(1);
    const device = await getTestDevice();
    const volume = createReducedVolume(device, { label: 'test sizes' });
    expect(volume.resize(37, 22, 4)).toBe(true);
    expect([volume.target.width, volume.target.height]).toEqual([10, 6]);
    expect([volume.depth.width, volume.depth.height]).toEqual([10, 6]);
    expect(volume.uvScale[0]).toBeCloseTo(40 / 37, 10);
    expect(volume.uvScale[1]).toBeCloseTo(24 / 22, 10);
    const generation = volume.generation;
    expect(volume.resize(37, 22, 4)).toBe(false);
    expect(volume.generation).toBe(generation);
    expect(volume.resize(40, 24, 2)).toBe(true);
    expect(volume.uvScale).toEqual([1, 1]);
    expect(volume.generation).toBe(generation + 1);
    volume.destroy();
  });

  it.each([
    [2, 'depth-aware'],
    [4, 'depth-aware'],
    [2, 'bilinear'],
    [4, 'bilinear'],
  ] as const)(
    'reduces depth by 1/%i for %s: view-space depth, nearest/farthest on a checkerboard or farthest',
    async (divisor, filter) => {
      const rig = await createRig(16, 12, divisor);
      // Depth grows to the right and down, so the nearest of a block is its top-left pixel.
      await expectValid(rig.device, async () => {
        rig.drawDepth('2.0 + p.x * 0.5 + p.y * 3.0');
        await rig.run('return vec4f(0.0, 0.0, 0.0, 1.0);', filter, 0);
      });
      const low = new Float32Array(
        (await readTexture(rig.device, rig.volume.depth.texture, 4)).buffer,
      );
      const lowWidth = 16 / divisor;
      const problems: string[] = [];
      for (let y = 0; y < 12 / divisor; y++) {
        for (let x = 0; x < lowWidth; x++) {
          const nearest = filter === 'depth-aware' && (x + y) % 2 === 0;
          const corner = nearest ? 0 : divisor - 1;
          const z = 2 + (x * divisor + corner) * 0.5 + (y * divisor + corner) * 3;
          // Through the depth buffer and back: f32 depth near the far plane costs a few digits.
          const expected = linearizeDepth(NEAR, FAR, Math.fround(depthOf(z)));
          const got = low[y * lowWidth + x]!;
          if (Math.abs(got - expected) > 1e-3 * z) problems.push(`${x},${y}: ${got} vs ${z}`);
        }
      }
      expect(problems.slice(0, 5)).toEqual([]);
      rig.destroy();
    },
  );

  it('treats every depth beyond the depth limit as the limit', async () => {
    // A background full of depth steps, all of them behind the medium (limit 10): the reduced
    // depth is flat, and the depth-aware filter gives the same result as plain bilinear.
    const rig = await createRig(32, 16, 4);
    const results: Float32Array[] = [];
    await expectValid(rig.device, async () => {
      rig.drawDepth('15.0 + 60.0 * fract(p.x * 0.37 + p.y * 0.61)');
      const body = 'return vec4f(vec3f(f32(i32(in.position.x) % 3) * 0.5), 0.5);';
      results.push(await rig.run(body, 'depth-aware', 0.25, 10));
      results.push(await rig.run(body, 'bilinear', 0.25, 10));
    });
    const low = new Float32Array(
      (await readTexture(rig.device, rig.volume.depth.texture, 4)).buffer,
    );
    expect(new Set(low)).toEqual(new Set([10]));
    let worst = 0;
    for (let i = 0; i < results[0]!.length; i++) {
      worst = Math.max(worst, Math.abs(results[0]![i]! - results[1]![i]!));
    }
    expect(worst).toBeLessThan(2e-3);
    rig.destroy();
  });

  it.each([
    [1, 'bilinear'],
    [2, 'bilinear'],
    [4, 'bilinear'],
    [1, 'depth-aware'],
    [2, 'depth-aware'],
    [4, 'depth-aware'],
  ] as const)('1/%i %s reproduces a constant field exactly', async (divisor, filter) => {
    // An awkward size (not a multiple of the divisor) and a depth buffer full of edges.
    const rig = await createRig(37, 22, divisor);
    const pixels = await expectValid(rig.device, async () => {
      rig.drawDepth('select(3.0, 40.0, (i32(p.x) / 5 + i32(p.y) / 3) % 2 == 0) + p.x * 0.05');
      return rig.run('return vec4f(0.5, 0.25, 2.0, 0.25);', filter, 0.5);
    });
    // scene * transmittance + radiance; every value is exact in a half float.
    const expected = [0.5 * 0.25 + 0.5, 0.5 * 0.25 + 0.25, 0.5 * 0.25 + 2, 0.75 + 0.25];
    const wrong = new Set<string>();
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 4; c++) {
        if (pixels[i + c] !== expected[c]) wrong.add(`${c}: ${pixels[i + c]}`);
      }
    }
    expect([...wrong].slice(0, 5)).toEqual([]);
    rig.destroy();
  });

  it.each([2, 4] as const)(
    '1/%i depth-aware upsampling does not leak across a depth discontinuity',
    async (divisor) => {
      // A near object fills the left of the frame up to a column that does not line up with the
      // low-resolution grid; behind it a far wall. The "march" puts fog only in front of the wall,
      // as a real one would: nothing in front of the near object.
      const edge = 13;
      const width = 40;
      const height = 24;
      const rig = await createRig(width, height, divisor);
      const results = {} as Record<UpsampleFilter, Float32Array>;
      await expectValid(rig.device, async () => {
        rig.drawDepth(`select(20.0, 2.0, p.x < ${edge}.0)`);
        const body = 'return vec4f(select(vec3f(0.0), vec3f(1.0), z > 10.0), 1.0);';
        results['depth-aware'] = await rig.run(body, 'depth-aware', 0);
        results.bilinear = await rig.run(body, 'bilinear', 0);
      });

      const worst = (pixels: Float32Array) => {
        let nearLeak = 0;
        let farLoss = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const value = pixels[(y * width + x) * 4]!;
            if (x < edge) nearLeak = Math.max(nearLeak, value);
            else farLoss = Math.max(farLoss, 1 - value);
          }
        }
        return { nearLeak, farLoss };
      };
      const aware = worst(results['depth-aware']);
      expect(aware.nearLeak).toBeLessThan(0.005);
      expect(aware.farLoss).toBeLessThan(0.005);
      // The same data through plain bilinear does leak, so the check above is not vacuous.
      const plain = worst(results.bilinear);
      expect(plain.nearLeak).toBeGreaterThan(0.2);
      rig.destroy();
    },
  );

  it('composites as scene * transmittance + radiance and keeps coverage in alpha', async () => {
    const rig = await createRig(16, 8, 1);
    const pixels = await expectValid(rig.device, async () => {
      rig.drawDepth('5.0');
      return rig.run('return vec4f(1.5, 0.25, 0.0, 0.5);', 'depth-aware', 0.5);
    });
    expect([...pixels.subarray(0, 4)]).toEqual([1.75, 0.5, 0.25, 1]);
    rig.destroy();
  });
});
