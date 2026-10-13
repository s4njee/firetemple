import { describe, expect, it, vi } from 'vitest';
import {
  bakeBlackbodyLut,
  BLACKBODY_GAMMA,
  BLACKBODY_LUT_WIDTH,
  BLACKBODY_T_MAX,
  BLACKBODY_T_MIN,
  blackbodyFit,
  blackbodyIntensity,
  blackbodyLogLuminance,
  blackbodyLutCoord,
  blackbodyLutTemperature,
  blackbodyLuminance,
  blackbodyPlanck,
  blackbodyRadiance,
  blackbodyTint,
  blackbodyXyz,
  createBlackbodyLut,
  luminance,
  type Rgb,
} from '../src/gpu/emission/blackbody-lut.ts';
import { fromHalf, toHalf, toHalfArray } from '../src/gpu/emission/half-float.ts';
import {
  bakeRamps,
  createRampTexture,
  RAMP_NAMES,
  RAMP_TINTS,
  rampBlackbody,
  rampFromStops,
  RAMPS,
  rampTinted,
  rampWhiten,
  type RampFn,
} from '../src/gpu/emission/ramp-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../src/gpu/fullscreen.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { LIBRARY_CHUNKS } from './library.ts';
import { gpuF32, rowsOf, scalars } from './wgsl-eval.ts';

// Stories 3.1 and 3.2: blackbody colour and flame colour ramps. Every number quoted in the chunk
// headers and in the two effects' notes is asserted (or printed with `report`) here.

vi.setConfig({ testTimeout: 60_000 });

/** Findings worth copying into notes.md: shown with `npx vitest run --silent=false`. */
const report = (line: string) => console.info(`[emission-colour] ${line}`);

const fixed = (x: number, digits = 4) => x.toFixed(digits);

// --- Colour helpers --------------------------------------------------------------------------------

/** CIE 1976 u'v' chromaticity of linear Rec.709 RGB. */
function upvp(rgb: Readonly<Rgb>): [number, number] {
  const [r, g, b] = rgb;
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const d = x + 15 * y + 3 * z;
  return [(4 * x) / d, (9 * y) / d];
}

/** CIE 1931 xy of the Planckian locus: Krystek's (1985) rational fit, good to ~1e-4 in uv, 1000-15000 K. */
function krystekXy(t: number): [number, number] {
  const u =
    (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) /
    (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v =
    (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) /
    (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

interface ColourError {
  /** Largest channel difference with both colours scaled to max channel 1. */
  maxTint: number;
  meanTint: number;
  /** Chromaticity distance in CIE u'v'. */
  maxUv: number;
  meanUv: number;
  /** Temperature of the largest tint error. */
  worstAt: number;
}

function colourError(
  temperatures: readonly number[],
  reference: (t: number) => Rgb,
  candidate: (t: number, index: number) => Rgb,
): ColourError {
  const e: ColourError = { maxTint: 0, meanTint: 0, maxUv: 0, meanUv: 0, worstAt: 0 };
  temperatures.forEach((t, index) => {
    const a = reference(t);
    const b = candidate(t, index);
    const ta = blackbodyTint(a);
    const tb = blackbodyTint(b);
    const tint = Math.max(...ta.map((v, i) => Math.abs(v - (tb[i] ?? 0))));
    const ua = upvp(a);
    const ub = upvp(b);
    const uv = Math.hypot(ua[0] - ub[0], ua[1] - ub[1]);
    if (tint > e.maxTint) {
      e.maxTint = tint;
      e.worstAt = t;
    }
    e.maxUv = Math.max(e.maxUv, uv);
    e.meanTint += tint / temperatures.length;
    e.meanUv += uv / temperatures.length;
  });
  return e;
}

const describeError = (e: ColourError) =>
  `tint max ${fixed(e.maxTint)} (${fixed(e.maxTint * 255, 2)}/255 at ${e.worstAt} K) mean ${fixed(e.meanTint)}; ` +
  `u'v' max ${fixed(e.maxUv, 5)} mean ${fixed(e.meanUv, 5)}`;

/** 800, 810, ... 12000 K. */
const SWEEP: number[] = [];
for (let t = BLACKBODY_T_MIN; t <= BLACKBODY_T_MAX; t += 10) SWEEP.push(t);

/** Evaluates a WGSL `vec3f` expression of `t` (kelvin, or heat) for every entry of `inputs`. */
async function gpuRgb(include: string, expression: string, inputs: readonly number[]) {
  const out = await gpuF32(
    `#include "${include}"
     fn f(x: vec4f) -> vec4f {
       let t = x.x;
       return vec4f(${expression}, 0.0);
     }`,
    rowsOf(inputs.map((t) => [t])),
  );
  return inputs.map((_, i): Rgb => [out[i * 4] ?? 0, out[i * 4 + 1] ?? 0, out[i * 4 + 2] ?? 0]);
}

/** What a linear, clamp-to-edge fetch returns from one row of baked RGBA texels at `u` in 0..1. */
function sampleRow(data: Float32Array, width: number, row: number, u: number): Rgb {
  const position = Math.min(Math.max(u, 0), 1) * (width - 1);
  const i0 = Math.min(Math.floor(position), width - 2);
  const w = position - i0;
  const at = (i: number, c: number) => data[(row * width + i) * 4 + c] ?? 0;
  return [0, 1, 2].map((c) => at(i0, c) * (1 - w) + at(i0 + 1, c) * w) as Rgb;
}

/** The values a `rgba16float` texture actually holds. */
const throughHalf = (data: Float32Array) => Float32Array.from(toHalfArray(data), fromHalf);

/** ACES (Narkowicz) then sRGB: what the tail shows for a linear radiance, in 0..1. */
function onScreen(x: number): number {
  const mapped = Math.min(Math.max((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0), 1);
  return mapped <= 0.0031308 ? 12.92 * mapped : 1.055 * mapped ** (1 / 2.4) - 0.055;
}

/** Renders `fs` (which may sample `tex` through `smp`) into a `width` x 1 float target and reads it. */
async function renderRow(fragment: string, texture: GPUTexture, width: number) {
  const device = await getTestDevice();
  return expectValid(device, async () => {
    const target = device.createTexture({
      size: [width, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: {
        label: 'emission-colour-row.wgsl',
        code: `#include "fullscreen.wgsl"
#include "ramp.wgsl"
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
${fragment}`,
        chunks: LIBRARY_CHUNKS,
      },
      format: 'rgba16float',
    });
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: sampler },
      ],
    });
    const encoder = device.createCommandEncoder();
    renderFullscreen(encoder, target.createView(), pipeline, [bindGroup]);
    device.queue.submit([encoder.finish()]);
    const bytes = await readTexture(device, target, 8);
    target.destroy();
    return Float32Array.from(new Uint16Array(bytes.buffer, bytes.byteOffset, width * 4), fromHalf);
  });
}

// --- Half floats -----------------------------------------------------------------------------------

describe('half floats', () => {
  it('encodes known values exactly', () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e9)).toBe(0x7c00);
    expect(toHalf(-Infinity)).toBe(0xfc00);
    expect(toHalf(2 ** -24)).toBe(1); // the smallest subnormal
    expect(toHalf(2 ** -14)).toBe(0x0400); // the smallest normal
    expect(toHalf(1e-10)).toBe(0);
    expect(Number.isNaN(fromHalf(toHalf(Number.NaN)))).toBe(true);
  });

  it('rounds to nearest, ties to even', () => {
    const ulp = 2 ** -10; // spacing of half floats in [1, 2)
    expect(toHalf(1 + ulp * 0.49)).toBe(0x3c00);
    expect(toHalf(1 + ulp * 0.51)).toBe(0x3c01);
    expect(toHalf(1 + ulp * 0.5)).toBe(0x3c00);
    expect(toHalf(1 + ulp * 1.5)).toBe(0x3c02);
    expect(toHalf(2 - ulp * 0.25)).toBe(0x4000); // carries into the exponent
  });

  it('round-trips within half a unit in the last place', () => {
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const value = 10 ** (-4 + (i / 4000) * 8.5) * (i % 2 ? -1 : 1);
      worst = Math.max(worst, Math.abs(fromHalf(toHalf(value)) / value - 1));
    }
    expect(worst).toBeLessThanOrEqual(2 ** -11);
    for (let bits = 0; bits < 0x7c00; bits += 7) expect(toHalf(fromHalf(bits))).toBe(bits);
  });
});

// --- Blackbody -------------------------------------------------------------------------------------

describe('blackbody: the reference', () => {
  it('follows the Planckian locus (Krystek 1985) from 1000 K to 12000 K', () => {
    let worst = 0;
    let worstAt = 0;
    for (let t = 1000; t <= 12000; t += 50) {
      const [x, y, z] = blackbodyXyz(t, 1600);
      const sum = x + y + z;
      const [kx, ky] = krystekXy(t);
      const distance = Math.hypot(x / sum - kx, y / sum - ky);
      if (distance > worst) {
        worst = distance;
        worstAt = t;
      }
    }
    report(
      `reference vs Krystek locus, 1000-12000 K: max xy distance ${fixed(worst, 5)} at ${worstAt} K`,
    );
    expect(worst).toBeLessThan(0.0012);
  });

  it('has converged at 80 wavelength samples', () => {
    const coarse = colourError(
      SWEEP.filter((_, i) => i % 5 === 0),
      (t) => blackbodyPlanck(t, 1600),
      (t) => blackbodyPlanck(t),
    );
    report(`80 samples vs 1600: ${describeError(coarse)}`);
    expect(coarse.maxTint).toBeLessThan(3e-4);
  });

  it('is the same in WGSL (f32) and TypeScript (f64)', async () => {
    const gpu = await gpuRgb('blackbody.wgsl', 'blackbody_planck(t)', SWEEP);
    const e = colourError(SWEEP, blackbodyPlanck, (_t, i) => gpu[i] ?? [0, 0, 0]);
    report(`WGSL reference vs TS reference: ${describeError(e)}`);
    expect(e.maxTint).toBeLessThan(2e-4);
    // Luminance 1, nothing negative.
    for (const c of gpu) {
      expect(Math.abs(luminance(c) - 1)).toBeLessThan(1e-4);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(0);
    }

    const temperatures = [400, 800, 1500, 2000, 6500, 12000, 20000];
    const xyz = await gpuRgb('blackbody.wgsl', 'blackbody_xyz(t)', temperatures);
    temperatures.forEach((t, i) => {
      const expected = blackbodyXyz(t);
      for (let c = 0; c < 3; c++) expect((xyz[i]?.[c] ?? 0) / (expected[c] ?? 1)).toBeCloseTo(1, 3);
    });
    expect(blackbodyXyz(2000)[1]).toBeCloseTo(5.7e-3, 4);
  });

  it('clips to the Rec.709 gamut the way the header says', () => {
    // Pure red while green is out of gamut, no blue until about 1900 K.
    expect(blackbodyPlanck(800)).toEqual([expect.closeTo(1 / 0.2126, 3), 0, 0]);
    expect(blackbodyPlanck(900)[1]).toBe(0);
    expect(blackbodyPlanck(1000)[1]).toBeGreaterThan(0);
    expect(blackbodyPlanck(1850)[2]).toBe(0);
    expect(blackbodyPlanck(1950)[2]).toBeGreaterThan(0);
    // Out-of-range temperatures clamp.
    expect(blackbodyPlanck(300)).toEqual(blackbodyPlanck(800));
    expect(blackbodyPlanck(40000)).toEqual(blackbodyPlanck(12000));
    // Red hot, then white, then blue: the largest channel moves from red to blue near 6600 K.
    expect(blackbodyTint(blackbodyPlanck(5000))[0]).toBe(1);
    expect(blackbodyTint(blackbodyPlanck(8000))[2]).toBe(1);
  });
});

describe('blackbody: fit and lookup against the reference', () => {
  it('the polynomial fit stays within 2/255', async () => {
    const [reference, fit, tint] = await Promise.all([
      gpuRgb('blackbody.wgsl', 'blackbody_planck(t)', SWEEP),
      gpuRgb('blackbody.wgsl', 'blackbody_fit(t)', SWEEP),
      gpuRgb('blackbody.wgsl', 'blackbody_tint(t)', SWEEP),
    ]);
    const e = colourError(
      SWEEP,
      (t) => reference[SWEEP.indexOf(t)] ?? [0, 0, 0],
      (_t, i) => fit[i] ?? [0, 0, 0],
    );
    report(`fit vs reference (both on the GPU), 800-12000 K: ${describeError(e)}`);
    expect(e.maxTint).toBeLessThan(0.0075);
    expect(e.meanTint).toBeLessThan(0.0035);
    expect(e.maxUv).toBeLessThan(0.0006);

    SWEEP.forEach((t, i) => {
      const c = fit[i] ?? [0, 0, 0];
      expect(Math.abs(luminance(c) - 1)).toBeLessThan(1e-4);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(0);
      // The TypeScript twin and the max-channel-1 form.
      const twin = blackbodyFit(t);
      const expectedTint = blackbodyTint(twin);
      for (let ch = 0; ch < 3; ch++) {
        expect(Math.abs((c[ch] ?? 0) - (twin[ch] ?? 0))).toBeLessThan(2e-4);
        expect(Math.abs((tint[i]?.[ch] ?? 0) - (expectedTint[ch] ?? 0))).toBeLessThan(2e-4);
      }
    });
  });

  it('the lookup error falls with width, and a 1/t axis beats a linear one', () => {
    const errorOf = (width: number, axis: 'reciprocal' | 'linear') => {
      const data = throughHalf(bakeBlackbodyLut({ width, axis }));
      return colourError(SWEEP, blackbodyPlanck, (t) =>
        sampleRow(
          data,
          width,
          0,
          axis === 'linear'
            ? (t - BLACKBODY_T_MIN) / (BLACKBODY_T_MAX - BLACKBODY_T_MIN)
            : blackbodyLutCoord(t),
        ),
      );
    };
    const widths = [8, 16, 32, 64, 128, 256];
    const reciprocal = widths.map((width) => errorOf(width, 'reciprocal'));
    const linear = widths.map((width) => errorOf(width, 'linear'));
    widths.forEach((width, i) => {
      report(`lut ${width} texels, 1/t axis: ${describeError(reciprocal[i]!)}`);
      report(`lut ${width} texels, linear axis: tint max ${fixed(linear[i]!.maxTint)}`);
    });
    // Halving the texel size cuts the error until, past 128 texels, what is left is the half-float
    // rounding of the stored values (about 0.0005).
    for (let i = 1; i < widths.indexOf(128) + 1; i++)
      expect(reciprocal[i]!.maxTint).toBeLessThan(reciprocal[i - 1]!.maxTint);
    expect(reciprocal[widths.indexOf(256)]!.maxTint).toBeLessThan(0.001);
    // From 16 texels up the 1/t axis wins. At 8 it starves the hot end: everything above 5000 K
    // falls between two texels.
    widths.forEach((width, i) => {
      if (width >= 16) expect(reciprocal[i]!.maxTint).toBeLessThan(linear[i]!.maxTint);
    });
    expect(reciprocal[0]!.maxTint).toBeGreaterThan(linear[0]!.maxTint);

    const chosen = reciprocal[widths.indexOf(BLACKBODY_LUT_WIDTH)]!;
    expect(chosen.maxTint).toBeLessThan(0.002);
    expect(reciprocal[1]!.maxTint).toBeLessThan(0.02);
    // The default lookup beats the fit by a wide margin.
    expect(chosen.maxTint).toBeLessThan(0.0067 / 3);
  });

  it('bakes the ends of the range into the end texels', () => {
    const data = bakeBlackbodyLut({ width: 16 });
    expect([...data.slice(0, 3)]).toEqual([...blackbodyPlanck(800)].map(Math.fround));
    expect([...data.slice(60, 63)]).toEqual([...blackbodyPlanck(12000)].map(Math.fround));
    expect(blackbodyLutCoord(800)).toBe(0);
    expect(blackbodyLutCoord(12000)).toBeCloseTo(1, 12);
    expect(blackbodyLutTemperature(blackbodyLutCoord(2345))).toBeCloseTo(2345, 6);
    expect(() => bakeBlackbodyLut({ width: 1 })).toThrow(RangeError);

    const radiance = bakeBlackbodyLut({ width: 16, withIntensity: { tRef: 2000 } });
    const t = blackbodyLutTemperature(5 / 15);
    const expected = blackbodyPlanck(t).map((c) => c * blackbodyIntensity(t, 2000));
    expect([...radiance.slice(20, 23)]).toEqual(expected.map(Math.fround));
  });

  it('blackbody_lookup on the GPU returns what the baked table holds', async () => {
    const device = await getTestDevice();
    const lut = createBlackbodyLut(device);
    const width = 256;
    const out = await renderRow(
      `@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
         let t = mix(800.0, 12000.0, in.uv.x);
         return vec4f(blackbody_lookup(tex, smp, t), blackbody_lut_coord(t));
       }`,
      lut,
      width,
    );
    lut.destroy();
    const data = throughHalf(bakeBlackbodyLut());
    let worst = 0;
    let worstReference = 0;
    for (let i = 0; i < width; i++) {
      const t = 800 + (11200 * (i + 0.5)) / width;
      const expected = sampleRow(data, BLACKBODY_LUT_WIDTH, 0, blackbodyLutCoord(t));
      const reference = blackbodyPlanck(t);
      for (let c = 0; c < 3; c++) {
        // Hardware filtering has 8 fractional bits and the target is a half float.
        worst = Math.max(worst, Math.abs((out[i * 4 + c] ?? 0) - (expected[c] ?? 0)));
        worstReference = Math.max(
          worstReference,
          Math.abs((out[i * 4 + c] ?? 0) - (reference[c] ?? 0)),
        );
      }
      expect(out[i * 4 + 3]).toBeCloseTo(blackbodyLutCoord(t), 3);
    }
    report(
      `GPU lookup (64 texels): max difference from the emulated fetch ${fixed(worst, 5)}, from the reference ${fixed(worstReference, 5)} (luminance-1 units)`,
    );
    expect(worst).toBeLessThan(0.006);
    expect(worstReference).toBeLessThan(0.01);
  });
});

describe('blackbody: brightness', () => {
  it('the luminance fit is within 0.3% of the integral', async () => {
    const reference = blackbodyXyz(2000, 1600)[1];
    let worst = 0;
    for (const t of SWEEP) {
      const exact = Math.log(blackbodyXyz(t, 400)[1] / reference);
      const fit = blackbodyLogLuminance(t) - blackbodyLogLuminance(2000);
      worst = Math.max(worst, Math.abs(fit - exact));
    }
    report(`log-luminance fit vs integral, 800-12000 K: max |ln ratio| ${fixed(worst, 5)}`);
    expect(worst).toBeLessThan(0.003);

    const temperatures = [1, 200, 500, 800, 1200, 2000, 5000, 12000, 50000];
    const gpu = await gpuF32(
      `#include "blackbody.wgsl"
       fn f(x: vec4f) -> vec4f {
         return vec4f(blackbody_log_luminance(x.x), blackbody_luminance(x.x, 2000.0),
                      blackbody_intensity(x.x, 2000.0, 0.25), blackbody_stefan(x.x, 2000.0));
       }`,
      rowsOf(temperatures.map((t) => [t])),
    );
    temperatures.forEach((t, i) => {
      const log = gpu[i * 4] ?? Number.NaN;
      expect(Number.isFinite(log)).toBe(true);
      expect(Math.abs(log - blackbodyLogLuminance(t))).toBeLessThan(
        2e-4 * Math.max(1, Math.abs(log)),
      );
      expect(gpu[i * 4 + 2]).toBeCloseTo(blackbodyIntensity(t, 2000, 0.25), 3);
      expect((gpu[i * 4 + 3] ?? 0) / (t / 2000) ** 4).toBeCloseTo(1, 4);
      if (t >= 500 && t <= 5000)
        expect((gpu[i * 4 + 1] ?? 0) / blackbodyLuminance(t, 2000)).toBeCloseTo(1, 2);
    });
    // Cold is black, and nothing overflows on the way there.
    expect(gpu[2]).toBe(0);
    expect(gpu[4 + 2]).toBeLessThan(1e-6);
  });

  it('matches the table in the chunk header', () => {
    const table: [number, number, number][] = [
      // t, physical luminance, tamed (gamma 0.4); both relative to 2000 K
      [800, 1.7e-8, 0.0008],
      [1000, 5.8e-6, 0.008],
      [1200, 3.0e-4, 0.039],
      [1500, 0.017, 0.19],
      [2000, 1, 1],
      [3000, 65, 5.3],
      [6500, 6600, 34],
      [12000, 46000, 73],
    ];
    for (const [t, physical, tamed] of table) {
      expect(blackbodyLuminance(t, 2000) / physical).toBeCloseTo(1, 1);
      expect(blackbodyIntensity(t, 2000, BLACKBODY_GAMMA) / tamed).toBeCloseTo(1, 1);
    }
    // A flame between 1000 K and 2200 K spans about 200:1 once tamed, against 5e5:1 physically.
    const tamedRange = blackbodyIntensity(2200, 2000) / blackbodyIntensity(1000, 2000);
    const physicalRange = blackbodyLuminance(2200, 2000) / blackbodyLuminance(1000, 2000);
    report(
      `1000 K to 2200 K: physical ${physicalRange.toExponential(2)}:1, tamed ${fixed(tamedRange, 1)}:1`,
    );
    expect(BLACKBODY_GAMMA).toBe(0.4);
    expect(tamedRange).toBeGreaterThan(150);
    expect(tamedRange).toBeLessThan(250);
    expect(physicalRange ** 0.25).toBeCloseTo(27, 0);
    expect(physicalRange).toBeGreaterThan(1e5);
  });

  it('is monotonic, 1 at the reference, and sets the luminance of blackbody_radiance', async () => {
    let previous = -Infinity;
    for (let t = 50; t <= 30000; t += 50) {
      const value = blackbodyLogLuminance(t);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    expect(blackbodyIntensity(1700, 1700, 0.4)).toBe(1);

    const temperatures = [600, 800, 1000, 1400, 1900, 2600, 6000, 12000];
    const gpu = await gpuRgb('blackbody.wgsl', 'blackbody_radiance(t, 1900.0, 0.25)', temperatures);
    temperatures.forEach((t, i) => {
      const c = gpu[i] ?? [0, 0, 0];
      const expected = blackbodyRadiance(t, 1900, 0.25);
      expect(luminance(c) / blackbodyIntensity(t, 1900, 0.25)).toBeCloseTo(1, 3);
      for (let ch = 0; ch < 3; ch++)
        expect(Math.abs((c[ch] ?? 0) - (expected[ch] ?? 0))).toBeLessThan(2e-3);
    });
  });
});

// --- Ramps -----------------------------------------------------------------------------------------

/** Heat 0, 1/200, ... 1. */
const HEATS = Array.from({ length: 201 }, (_, i) => i / 200);

describe('flame ramps', () => {
  const cases: [string, string, RampFn][] = [
    ...RAMP_NAMES.map((name): [string, string, RampFn] => [name, `ramp_${name}(t)`, RAMPS[name]]),
    ['tinted', 'ramp_tinted(t, vec3f(0.2, 0.9, 1.0))', rampTinted([0.2, 0.9, 1.0])],
    ['blackbody', 'ramp_blackbody(t, 800.0, 2000.0)', rampBlackbody(800, 2000)],
  ];

  it.each(cases)('%s: WGSL and TypeScript agree', async (_name, expression, twin) => {
    const gpu = await gpuRgb('ramp.wgsl', expression, HEATS);
    let worst = 0;
    HEATS.forEach((heat, i) => {
      const expected = twin(heat);
      for (let c = 0; c < 3; c++)
        worst = Math.max(worst, Math.abs((gpu[i]?.[c] ?? 0) - (expected[c] ?? 0)));
    });
    expect(worst).toBeLessThan(2e-3);
  });

  it.each(cases)('%s: black at zero, never decreasing, clamped outside 0..1', (_name, _e, twin) => {
    expect(twin(0)).toEqual([0, 0, 0]);
    expect(twin(-3)).toEqual([0, 0, 0]);
    expect(twin(7)).toEqual(twin(1));
    for (let i = 1; i < HEATS.length; i++) {
      const lo = twin(HEATS[i - 1] ?? 0);
      const hi = twin(HEATS[i] ?? 0);
      // Blackbody green and blue are clipped to the gamut, so only luminance must rise there.
      for (let c = 0; c < 3; c++) expect((hi[c] ?? 0) + 1e-12).toBeGreaterThanOrEqual(lo[c] ?? 0);
    }
  });

  it('peaks where the header says', () => {
    expect(RAMPS.fire(1)).toEqual([16, 12, 6]);
    expect(RAMPS.gas(1).map((c) => +c.toFixed(9))).toEqual([0.32, 1.6, 8]);
    expect(RAMPS.copper(1)).toEqual(RAMP_TINTS.copper.map((c) => 8 * c + 0.5));
    expect(luminance(rampBlackbody(800, 2000)(1))).toBeCloseTo(12, 6);
    // Bodies are well above paper white (so they bloom) and below the core: the brightest
    // channel is 2-5 at heat 0.6 and under 10 at heat 0.8.
    for (const name of RAMP_NAMES) {
      expect(Math.max(...RAMPS[name](0.6))).toBeGreaterThan(2);
      expect(Math.max(...RAMPS[name](0.6))).toBeLessThan(5);
      expect(Math.max(...RAMPS[name](0.8))).toBeLessThan(10);
    }
    // The fire ramp is red by 0.25, orange at 0.5, yellow at 0.75 and pale only near 1.
    const [r25, g25] = RAMPS.fire(0.25);
    expect(g25 / r25).toBeLessThan(0.01);
    const [r50, g50, b50] = RAMPS.fire(0.5);
    expect(g50 / r50).toBeGreaterThan(0.04);
    expect(g50 / r50).toBeLessThan(0.15);
    expect(b50).toBeLessThan(0.01);
    const [, g75, b75] = RAMPS.fire(0.75);
    expect(g75).toBeGreaterThan(1.5);
    expect(b75).toBeLessThan(0.25);
  });

  it('ramp_select picks the named ramps and falls back to fire', async () => {
    const kinds = [0, 1, 2, 3, 4, 5, 9, -1];
    const out = await gpuF32(
      `#include "ramp.wgsl"
       fn f(x: vec4f) -> vec4f { return vec4f(ramp_select(i32(x.x), x.y), 0.0); }`,
      rowsOf(kinds.map((kind) => [kind, 0.7])),
    );
    kinds.forEach((kind, i) => {
      const name = RAMP_NAMES[kind] ?? 'fire';
      const expected = RAMPS[name](0.7);
      for (let c = 0; c < 3; c++) expect(out[i * 4 + c]).toBeCloseTo(expected[c] ?? 0, 3);
    });
    const ids = await scalars('#include "ramp.wgsl"', [
      'f32(RAMP_FIRE)',
      'f32(RAMP_GAS)',
      'f32(RAMP_COPPER)',
      'f32(RAMP_SODIUM)',
      'f32(RAMP_POTASSIUM)',
      'f32(RAMP_LITHIUM)',
    ]);
    expect(ids).toEqual(RAMP_NAMES.map((_, i) => i));
  });

  it('ramp_whiten keeps luminance and only desaturates bright colours', async () => {
    const colours: Rgb[] = [
      [0, 0, 0],
      [0.3, 0.05, 0],
      [3.2, 0.4, 0],
      [30, 7.8, 0.2],
      [0, 0, 40],
      [5, 5, 5],
    ];
    const out = await gpuF32(
      `#include "ramp.wgsl"
       fn f(x: vec4f) -> vec4f { return vec4f(ramp_whiten(x.xyz, x.w), 0.0); }`,
      rowsOf(colours.map((c) => [...c, 6])),
    );
    colours.forEach((c, i) => {
      const gpu: Rgb = [out[i * 4] ?? 0, out[i * 4 + 1] ?? 0, out[i * 4 + 2] ?? 0];
      const twin = rampWhiten(c, 6);
      for (let ch = 0; ch < 3; ch++)
        expect(Math.abs((gpu[ch] ?? 0) - (twin[ch] ?? 0))).toBeLessThan(1e-4);
      expect(luminance(twin)).toBeCloseTo(luminance(c), 9);
      // Every channel moves toward the luminance, never past it.
      const l = luminance(c);
      for (let ch = 0; ch < 3; ch++) {
        expect(Math.abs((twin[ch] ?? 0) - l)).toBeLessThanOrEqual(Math.abs((c[ch] ?? 0) - l));
      }
    });
    // A quarter of the way to grey when the luminance equals the knee; untouched when dim.
    expect(rampWhiten([4, 4, 40], luminance([4, 4, 40]))[2]).toBeCloseTo(
      40 - 0.25 * (40 - luminance([4, 4, 40])),
      9,
    );
    expect(rampWhiten([0.3, 0.05, 0], 6)[2]).toBeLessThan(1e-4);
    expect(rampWhiten([30, 7.8, 0.2], 6)[2]).toBeGreaterThan(2);
    expect(rampWhiten([3, 1, 0], 1e9)).toEqual([
      expect.closeTo(3, 6),
      expect.closeTo(1, 6),
      expect.closeTo(0, 6),
    ]);
  });

  it('ramps from stops interpolate, clamp and step', () => {
    const ramp = rampFromStops([
      { at: 0.75, color: [8, 4, 0] },
      { at: 0.25, color: [0, 0, 0] },
      { at: 0.75, color: [0, 0, 9] },
      { at: 1, color: [0, 0, 20] },
    ]);
    expect(ramp(0)).toEqual([0, 0, 0]);
    expect(ramp(0.25)).toEqual([0, 0, 0]);
    expect(ramp(0.5)).toEqual([4, 2, 0]);
    expect(ramp(0.75)).toEqual([8, 4, 0]); // the first of two stops at the same heat
    expect(ramp(0.7500001)[2]).toBeCloseTo(9, 4);
    expect(ramp(0.875)).toEqual([0, 0, 14.5]);
    expect(ramp(2)).toEqual([0, 0, 20]);
    expect(() => rampFromStops([])).toThrow(RangeError);
    expect(rampFromStops([{ at: 0.3, color: [1, 2, 3] }])(0.9)).toEqual([1, 2, 3]);
  });

  it('polynomial versus texture: the baking error by width', () => {
    const dense = Array.from({ length: 4001 }, (_, i) => i / 4000);
    const errorOf = (ramp: RampFn, width: number) => {
      const data = throughHalf(bakeRamps([ramp], width));
      let radiance = 0;
      let screen = 0;
      for (const heat of dense) {
        const exact = ramp(heat);
        const baked = sampleRow(data, width, 0, heat);
        for (let c = 0; c < 3; c++) {
          radiance = Math.max(radiance, Math.abs((baked[c] ?? 0) - (exact[c] ?? 0)));
          screen = Math.max(screen, Math.abs(onScreen(baked[c] ?? 0) - onScreen(exact[c] ?? 0)));
        }
      }
      return { radiance, screen };
    };
    const widths = [8, 16, 32, 64, 128, 256];
    const fire = widths.map((width) => errorOf(RAMPS.fire, width));
    widths.forEach((width, i) =>
      report(
        `ramp_fire baked into ${width} texels: max radiance error ${fixed(fire[i]!.radiance)}, ` +
          `on screen (ACES + sRGB) ${fixed(fire[i]!.screen * 255, 2)}/255`,
      ),
    );
    for (let i = 1; i < widths.length; i++)
      expect(fire[i]!.radiance).toBeLessThan(fire[i - 1]!.radiance);
    expect(fire[widths.indexOf(64)]!.radiance).toBeLessThan(0.03);
    expect(fire[widths.indexOf(64)]!.screen * 255).toBeLessThan(1);
    expect(fire[widths.indexOf(16)]!.radiance).toBeLessThan(0.5);

    // Every named ramp is below one 8-bit step on screen at the default width.
    for (const name of RAMP_NAMES) expect(errorOf(RAMPS[name], 64).screen * 255).toBeLessThan(1);
    // The blackbody ramp is steep where it leaves black, which is where the display curve is
    // steepest too: it needs four times the texels of the polynomial ramps.
    const blackbody = widths.map((width) => errorOf(rampBlackbody(800, 2000), width));
    widths.forEach((width, i) =>
      report(
        `ramp_blackbody(800, 2000) baked into ${width} texels: on screen ${fixed(blackbody[i]!.screen * 255, 2)}/255`,
      ),
    );
    expect(blackbody[widths.indexOf(64)]!.screen * 255).toBeGreaterThan(4);
    expect(blackbody[widths.indexOf(256)]!.screen * 255).toBeLessThan(2.5);
  });

  it('bakes one ramp per row and ramp_lookup reads the right row on the GPU', async () => {
    const ramps = [
      RAMPS.fire,
      RAMPS.copper,
      rampFromStops([
        { at: 0, color: [0, 0, 0] },
        { at: 1, color: [2, 4, 8] },
      ]),
    ];
    const width = 32;
    const data = bakeRamps(ramps, width);
    expect(data.length).toBe(width * ramps.length * 4);
    expect([...data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    expect([...data.slice((width - 1) * 4, width * 4)]).toEqual([16, 12, 6, 1]);
    expect([...data.slice((3 * width - 1) * 4, 3 * width * 4)]).toEqual([2, 4, 8, 1]);
    expect(() => bakeRamps([], 8)).toThrow(RangeError);
    expect(() => bakeRamps(ramps, 1)).toThrow(RangeError);

    const device = await getTestDevice();
    const texture = createRampTexture(device, ramps, { width });
    expect([texture.width, texture.height, texture.format]).toEqual([width, 3, 'rgba16float']);
    const stored = throughHalf(data);
    const samples = 128;
    for (let row = 0; row < ramps.length; row++) {
      const out = await renderRow(
        `@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
           return vec4f(ramp_lookup(tex, smp, in.uv.x, ${row}), 1.0);
         }`,
        texture,
        samples,
      );
      for (let i = 0; i < samples; i++) {
        const expected = sampleRow(stored, width, row, (i + 0.5) / samples);
        // 8 fractional bits of filtering on a texel step of up to 2.5, then a half-float target.
        for (let c = 0; c < 3; c++)
          expect(Math.abs((out[i * 4 + c] ?? 0) - (expected[c] ?? 0))).toBeLessThan(0.02);
      }
    }
    texture.destroy();
  });
});
