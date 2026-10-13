import { createTextureFromData } from '../texture.ts';
import { toHalfArray } from './half-float.ts';

// The JavaScript twin of src/wgsl/blackbody.wgsl: the same reference and the same fit, in double
// precision, plus the baked lookup texture `blackbody_lookup` samples. Lights and CSS driven from
// script use these so they agree with what the shaders draw. tests/emission-colour.test.ts holds
// the two implementations to each other.

export type Rgb = [number, number, number];

export const BLACKBODY_T_MIN = 800;
export const BLACKBODY_T_MAX = 12000;
export const BLACKBODY_PLANCK_STEPS = 80;
export const BLACKBODY_GAMMA = 0.4;
/** Default width of the lookup texture: max error 0.3/255 against the reference. */
export const BLACKBODY_LUT_WIDTH = 64;

/** Second radiation constant hc/k in micrometre kelvin. */
const C2 = 14387.77;
const M_COLD = 1000 / BLACKBODY_T_MIN;
const M_HOT = 1000 / BLACKBODY_T_MAX;

const clampT = (t: number) => Math.min(Math.max(t, BLACKBODY_T_MIN), BLACKBODY_T_MAX);

function lobe(x: number, centre: number, sLo: number, sHi: number): number {
  const d = (x - centre) / (x < centre ? sLo : sHi);
  return Math.exp(-0.5 * d * d);
}

/**
 * CIE 1931 2-degree colour-matching functions at a wavelength in nanometres: the multi-lobe fit of
 * Wyman, Sloan and Shirley (2013) plus two far-red lobes (see the header of blackbody.wgsl).
 */
export function blackbodyCmf(nm: number): Rgb {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31.0) +
      0.362 * lobe(nm, 442.0, 16.0, 26.7) -
      0.065 * lobe(nm, 501.1, 20.4, 26.2) +
      0.0068 * lobe(nm, 681.8, 8.0, 26.7),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) +
      0.286 * lobe(nm, 530.9, 16.3, 31.1) -
      0.0039 * lobe(nm, 671.4, 8.0, 11.7),
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8),
  ];
}

/**
 * Unnormalised CIE XYZ of the Planck spectrum at `t` kelvin, on the same scale as `blackbody_xyz`.
 * `steps` midpoint samples over 380-780 nm; the default matches the shader.
 */
export function blackbodyXyz(t: number, steps = BLACKBODY_PLANCK_STEPS): Rgb {
  const kelvin = Math.max(t, 400);
  const stepNm = 400 / steps;
  const sum: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const nm = 380 + (i + 0.5) * stepNm;
    const um = nm * 0.001;
    const planck = 1 / (um ** 5 * Math.expm1(C2 / (um * kelvin)));
    const cmf = blackbodyCmf(nm);
    sum[0] += planck * cmf[0];
    sum[1] += planck * cmf[1];
    sum[2] += planck * cmf[2];
  }
  return [sum[0] * stepNm, sum[1] * stepNm, sum[2] * stepNm];
}

/** Relative luminance of linear Rec.709 RGB, with the weights color.wgsl uses. */
export function luminance(rgb: Readonly<Rgb>): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** CIE XYZ to linear Rec.709, clipped at 0 and scaled to luminance 1. */
export function blackbodyFromXyz(xyz: Readonly<Rgb>): Rgb {
  const [x, y, z] = xyz;
  const rgb: Rgb = [
    Math.max(3.2404542 * x - 1.5371385 * y - 0.4985314 * z, 0),
    Math.max(-0.969266 * x + 1.8760108 * y + 0.041556 * z, 0),
    Math.max(0.0556434 * x - 0.2040259 * y + 1.0572252 * z, 0),
  ];
  const scale = 1 / luminance(rgb);
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/** The reference colour at luminance 1 (`blackbody_planck`). `t` is clamped to 800-12000 K. */
export function blackbodyPlanck(t: number, steps = BLACKBODY_PLANCK_STEPS): Rgb {
  return blackbodyFromXyz(blackbodyXyz(clampT(t), steps));
}

/** The polynomial fit at luminance 1 (`blackbody_fit`). */
export function blackbodyFit(t: number): Rgb {
  const m = 1000 / clampT(t);
  const r =
    0.6434261 + m * (1.67628 + m * (7.788649 + m * (-9.540567 + m * (5.157015 - m * 1.133003))));
  const b =
    2.477916 + m * (-12.89438 + m * (26.70504 + m * (-28.27291 + m * (15.14288 - m * 3.250489))));
  const g = (1 - 0.2126 * r - 0.0722 * b) / 0.7152;
  const rgb: Rgb = [Math.max(r, 0), Math.max(g, 0), Math.max(b, 0)];
  const scale = 1 / luminance(rgb);
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/** A luminance-1 colour rescaled so its largest channel is 1 (`blackbody_tint` for the fit). */
export function blackbodyTint(rgb: Readonly<Rgb>): Rgb {
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  return [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
}

/** Natural log of the photometric luminance: the fit `blackbody_log_luminance` uses. */
export function blackbodyLogLuminance(t: number): number {
  const m = 1000 / Math.max(t, 1);
  const x = 25.5 * m;
  const logExpm1 = x + Math.log(Math.max(1 - Math.exp(-x), 1e-30));
  return 7.64362 + m * (-1.00193 + m * (1.89476 - m * 0.264759)) - logExpm1;
}

/** Physical luminance relative to the body at `tRef`. */
export function blackbodyLuminance(t: number, tRef: number): number {
  return Math.exp(blackbodyLogLuminance(t) - blackbodyLogLuminance(tRef));
}

/** The tamed brightness mapping: physical relative luminance raised to `gamma`. */
export function blackbodyIntensity(t: number, tRef: number, gamma = BLACKBODY_GAMMA): number {
  return Math.exp(gamma * (blackbodyLogLuminance(t) - blackbodyLogLuminance(tRef)));
}

/** `blackbody_radiance`: the fitted colour times the tamed intensity. */
export function blackbodyRadiance(t: number, tRef: number, gamma = BLACKBODY_GAMMA): Rgb {
  const c = blackbodyFit(t);
  const k = blackbodyIntensity(t, tRef, gamma);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** The lookup axis: 0 at 800 K, 1 at 12000 K, linear in 1/t (`blackbody_lut_coord`). */
export function blackbodyLutCoord(t: number): number {
  return (M_COLD - 1000 / clampT(t)) / (M_COLD - M_HOT);
}

/** The temperature stored at lookup coordinate `u` in 0..1. */
export function blackbodyLutTemperature(u: number): number {
  return 1000 / (M_COLD - u * (M_COLD - M_HOT));
}

export interface BlackbodyLutOptions {
  /** Texels along the temperature axis. Default 64. */
  width?: number;
  /**
   * Bake radiance instead of colour alone: each texel is multiplied by
   * `blackbodyIntensity(t, tRef, gamma)`, so one fetch returns what `blackbody_radiance` computes.
   */
  withIntensity?: { tRef: number; gamma?: number };
  /**
   * `'reciprocal'` (default) spaces the texels evenly in 1/t, which is what `blackbody_lookup`
   * expects. `'linear'` spaces them evenly in t; it exists to measure how much worse that is.
   */
  axis?: 'reciprocal' | 'linear';
}

/**
 * The lookup table as floats: `width` RGBA texels, the reference colour at luminance 1 (times the
 * intensity when asked for), alpha 1. Texel 0 is 800 K and the last texel is 12000 K exactly.
 */
export function bakeBlackbodyLut(options: BlackbodyLutOptions = {}): Float32Array {
  const { width = BLACKBODY_LUT_WIDTH, withIntensity, axis = 'reciprocal' } = options;
  if (!Number.isInteger(width) || width < 2) {
    throw new RangeError(`bakeBlackbodyLut: width must be an integer >= 2, got ${width}`);
  }
  const data = new Float32Array(width * 4);
  for (let i = 0; i < width; i++) {
    const u = i / (width - 1);
    const t =
      axis === 'linear'
        ? BLACKBODY_T_MIN + u * (BLACKBODY_T_MAX - BLACKBODY_T_MIN)
        : blackbodyLutTemperature(u);
    const rgb = blackbodyPlanck(t);
    const k = withIntensity
      ? blackbodyIntensity(t, withIntensity.tRef, withIntensity.gamma ?? BLACKBODY_GAMMA)
      : 1;
    data.set([rgb[0] * k, rgb[1] * k, rgb[2] * k, 1], i * 4);
  }
  return data;
}

/**
 * A `width` x 1 `rgba16float` texture for `blackbody_lookup`. Sample it with a linear,
 * clamp-to-edge sampler. 64 texels are 512 bytes.
 */
export function createBlackbodyLut(
  device: GPUDevice,
  options: BlackbodyLutOptions & { label?: string } = {},
): GPUTexture {
  const data = bakeBlackbodyLut(options);
  return createTextureFromData(device, {
    label: options.label ?? 'blackbody lut',
    width: data.length / 4,
    height: 1,
    data: toHalfArray(data),
    format: 'rgba16float',
  });
}
