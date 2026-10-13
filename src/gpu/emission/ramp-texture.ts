import { createTextureFromData } from '../texture.ts';
import { BLACKBODY_GAMMA, blackbodyRadiance, luminance, type Rgb } from './blackbody-lut.ts';
import { toHalfArray } from './half-float.ts';

// Colour ramps for script and for baking: the JavaScript twins of the polynomial ramps in
// src/wgsl/ramp.wgsl, ramps authored as colour stops, and the texture `ramp_lookup` samples.
// A ramp maps heat in 0..1 to linear HDR radiance (1.0 = paper white).

export type { Rgb };
export type RampFn = (heat: number) => Rgb;

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** The shared brightness curve (`_ramp_body`). */
const body = (h: number) => h * h * (0.4 + 0.6 * h);

/** Emitter tints, the same numbers as the `RAMP_TINT_*` constants in ramp.wgsl. */
export const RAMP_TINTS = {
  copper: [0.02, 1.0, 0.22],
  sodium: [1.0, 0.42, 0.0],
  potassium: [0.55, 0.12, 1.0],
  lithium: [1.0, 0.0, 0.07],
} as const satisfies Record<string, Readonly<Rgb>>;

/** `ramp_tinted`: one emitter of constant hue. */
export function rampTinted(tint: Readonly<Rgb>): RampFn {
  return (heat) => {
    const h = clamp01(heat);
    const k = 8 * body(h);
    const core = 0.5 * h ** 6;
    return [k * tint[0] + core, k * tint[1] + core, k * tint[2] + core];
  };
}

/** The named ramps of ramp.wgsl, in `ramp_select` order. */
export const RAMPS = {
  fire: (heat) => {
    const h = clamp01(heat);
    return [16 * body(h), 12 * h ** 6, 6 * h ** 12];
  },
  gas: (heat) => {
    const h = clamp01(heat);
    return [0.8 * h * h * (1 - 0.6 * h), 1.6 * h ** 4, 8 * body(h)];
  },
  copper: rampTinted(RAMP_TINTS.copper),
  sodium: rampTinted(RAMP_TINTS.sodium),
  potassium: rampTinted(RAMP_TINTS.potassium),
  lithium: rampTinted(RAMP_TINTS.lithium),
} as const satisfies Record<string, RampFn>;

export type RampName = keyof typeof RAMPS;
export const RAMP_NAMES = Object.keys(RAMPS) as RampName[];

export const RAMP_BLACKBODY_PEAK = 12;

/** `ramp_blackbody`: heat mapped to a temperature between `tCold` and `tHot` kelvin. */
export function rampBlackbody(tCold: number, tHot: number): RampFn {
  return (heat) => {
    const h = clamp01(heat);
    const fade = Math.min(h / 0.15, 1);
    const k = RAMP_BLACKBODY_PEAK * fade * fade * (3 - 2 * fade);
    const c = blackbodyRadiance(tCold + (tHot - tCold) * h, tHot, BLACKBODY_GAMMA);
    return [c[0] * k, c[1] * k, c[2] * k];
  };
}

/** `ramp_whiten`: bright colours pulled toward grey of the same luminance. */
export function rampWhiten(color: Readonly<Rgb>, knee: number): Rgb {
  const l = luminance(color);
  const w = l / (l + Math.max(knee, 1e-6));
  const k = w * w;
  return [
    color[0] + (l - color[0]) * k,
    color[1] + (l - color[1]) * k,
    color[2] + (l - color[2]) * k,
  ];
}

/** One colour stop: linear HDR radiance `color` at heat `at`. */
export interface RampStop {
  at: number;
  color: Readonly<Rgb>;
}

/**
 * A ramp authored as stops, interpolated linearly in linear light. Stops are sorted by `at`; heat
 * below the first or above the last stop gets that stop's colour. Two stops at the same `at` make
 * a hard step (bake it wide, or the bilinear fetch softens it).
 */
export function rampFromStops(stops: readonly RampStop[]): RampFn {
  if (stops.length === 0) throw new RangeError('rampFromStops: at least one stop is needed');
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  return (heat) => {
    const h = clamp01(heat);
    const first = sorted[0]!;
    if (h <= first.at) return [...first.color];
    for (let i = 1; i < sorted.length; i++) {
      const lo = sorted[i - 1]!;
      const hi = sorted[i]!;
      if (h <= hi.at) {
        const span = hi.at - lo.at;
        const w = span > 0 ? (h - lo.at) / span : 1;
        return [
          lo.color[0] + (hi.color[0] - lo.color[0]) * w,
          lo.color[1] + (hi.color[1] - lo.color[1]) * w,
          lo.color[2] + (hi.color[2] - lo.color[2]) * w,
        ];
      }
    }
    return [...sorted[sorted.length - 1]!.color];
  };
}

/** Default width of a ramp texture. */
export const RAMP_TEXTURE_WIDTH = 64;

/**
 * Samples each ramp at `width` evenly spaced heats (texel 0 is heat 0, the last texel heat 1) and
 * returns the texels row after row as RGBA floats, alpha 1.
 */
export function bakeRamps(
  ramps: readonly RampFn[],
  width: number = RAMP_TEXTURE_WIDTH,
): Float32Array {
  if (!Number.isInteger(width) || width < 2) {
    throw new RangeError(`bakeRamps: width must be an integer >= 2, got ${width}`);
  }
  if (ramps.length === 0) throw new RangeError('bakeRamps: at least one ramp is needed');
  const data = new Float32Array(width * ramps.length * 4);
  ramps.forEach((ramp, row) => {
    for (let i = 0; i < width; i++) {
      const [r, g, b] = ramp(i / (width - 1));
      data.set([r, g, b, 1], (row * width + i) * 4);
    }
  });
  return data;
}

export interface RampTextureOptions {
  /** Texels along the heat axis. Default 64. */
  width?: number;
  label?: string;
}

/**
 * A `width` x `ramps.length` `rgba16float` texture for `ramp_lookup`, one ramp per row. Sample it
 * with a linear, clamp-to-edge sampler. Radiance above 65504 does not fit a half float.
 */
export function createRampTexture(
  device: GPUDevice,
  ramps: RampFn | readonly RampFn[],
  options: RampTextureOptions = {},
): GPUTexture {
  const list = typeof ramps === 'function' ? [ramps] : ramps;
  const width = options.width ?? RAMP_TEXTURE_WIDTH;
  return createTextureFromData(device, {
    label: options.label ?? 'ramp texture',
    width,
    height: list.length,
    data: toHalfArray(bakeRamps(list, width)),
    format: 'rgba16float',
  });
}
