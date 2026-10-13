// Flicker signals for fire: the TypeScript twin of src/wgsl/flicker.wgsl.
//
// Same construction, same constants, same numbers (to about 1e-6; tests/emission-motion.test.ts
// compares the two on the GPU), so a CSS glow, a canvas light and a WGSL flame can be driven by
// one signal and stay in step. Pure functions: no DOM, no GPU, no state.
//
// The construction and the argument for the photosensitivity guarantee are written out in the
// header of flicker.wgsl. In short: the slow part is a quadratic B-spline through hashed values
// with at most FLICKER_SAFE_MAX_RATE knots a second, so its direction can reverse at most once per
// knot; the fast part ("shimmer") is capped at FLICKER_SAFE_MAX_SHIMMER peak to peak, which is too
// small to be a flash or to add a reversal. `flickerIntensity` therefore cannot produce more than
// three WCAG 2.3.1 flashes in any second, whatever the settings and the seed. `countFlashes`
// measures that on a sampled signal.

/** The signal repeats exactly with this period, in seconds. Wrap long-running time to it. */
export const FLICKER_PERIOD = 1024;

/** Safe cap on `rate`: knots (new random targets) per second. Two full swings a second at most. */
export const FLICKER_SAFE_MAX_RATE = 4;
/** Safe cap on `depth`. The slow swing may use the whole range because its rate is capped. */
export const FLICKER_SAFE_MAX_DEPTH = 1;
/** Safe cap on `shimmer`: peak-to-peak size of the fast part, as a fraction of full white. */
export const FLICKER_SAFE_MAX_SHIMMER = 0.04;
/** Safe cap on `shimmerRate`, knots per second. A band limit, so 60 Hz displays do not alias it. */
export const FLICKER_SAFE_MAX_SHIMMER_RATE = 24;
/** Numeric limit on both rates in the unsafe path. Not a safety cap. */
export const FLICKER_RATE_LIMIT = 512;
/** Share of the slow swing given to the quarter-rate drift octave. */
export const FLICKER_DRIFT_SHARE = 0.4;

/** WCAG 2.3.1 general flash: a change counts from this fraction of the maximum luminance... */
export const FLICKER_FLASH_DELTA = 0.1;
/** ...when the darker of the two states is below this relative luminance... */
export const FLICKER_FLASH_DARK = 0.8;
/** ...and no more than this many flashes (pairs of opposing changes) may fall in any second. */
export const FLICKER_FLASH_LIMIT = 3;

export interface FlickerSettings {
  /** Knots per second of the slow swing. The fastest full swing is rate / 2 Hz. */
  rate: number;
  /** Largest slow swing, as a fraction of full scale (0..1). */
  depth: number;
  /** Peak-to-peak size of the fast part, as a fraction of full scale. */
  shimmer: number;
  /** Knots per second of the fast part. */
  shimmerRate: number;
}

/** The recommended starting point: a calm candle or torch. Inside the safe range. */
export const FLICKER_DEFAULT: Readonly<FlickerSettings> = {
  rate: 3,
  depth: 0.3,
  shimmer: 0.03,
  shimmerRate: 13,
};

/** Clamps like WGSL `clamp`, and maps NaN to `lo` so a bad URL parameter cannot poison a light. */
function clampTo(value: number, lo: number, hi: number): number {
  return value > lo ? (value < hi ? value : hi) : lo;
}

/**
 * The nearest settings inside the safe range: `rate` in [0, 4], `shimmer` in [0, 0.04],
 * `shimmerRate` in [0, 24], and `depth` in [0, 1 - shimmer] so the output never clips.
 * `flickerIntensity` and `flickerOffset` apply this themselves. Idempotent.
 */
export function flickerClamp(settings: Readonly<FlickerSettings>): FlickerSettings {
  const shimmer = clampTo(settings.shimmer, 0, FLICKER_SAFE_MAX_SHIMMER);
  return {
    rate: clampTo(settings.rate, 0, FLICKER_SAFE_MAX_RATE),
    depth: clampTo(settings.depth, 0, FLICKER_SAFE_MAX_DEPTH - shimmer),
    shimmer,
    shimmerRate: clampTo(settings.shimmerRate, 0, FLICKER_SAFE_MAX_SHIMMER_RATE),
  };
}

/** True when `flickerClamp` would leave the settings as they are. */
export function flickerIsSafe(settings: Readonly<FlickerSettings>): boolean {
  const safe = flickerClamp(settings);
  return (
    safe.rate === settings.rate &&
    safe.depth === settings.depth &&
    safe.shimmer === settings.shimmer &&
    safe.shimmerRate === settings.shimmerRate
  );
}

// --- The lattice ---------------------------------------------------------------------------------

const f32 = Math.fround;
const LCG_MUL = 1664525;
const LCG_ADD = 1013904223;
const UNORM = 1 / 16777216;

// Lanes keep the parts of one seed's signal independent of each other. Must match flicker.wgsl.
const LANE_MAIN = 0;
const LANE_DRIFT = 1;
const LANE_SHIMMER = 2;
const LANE_OFFSET_MAIN = 3;
const LANE_OFFSET_DRIFT = 4;

/** One knot's two values in [0, 1): `to_unorm_2d(pcg_2d(vec2u(index, lane)))` from hash.wgsl. */
function knot(index: number, lane: number, out: Float64Array): void {
  let x = (Math.imul(index, LCG_MUL) + LCG_ADD) >>> 0;
  let y = (Math.imul(lane, LCG_MUL) + LCG_ADD) >>> 0;
  x = (x + Math.imul(y, LCG_MUL)) >>> 0;
  y = (y + Math.imul(x, LCG_MUL)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, LCG_MUL)) >>> 0;
  y = (y + Math.imul(x, LCG_MUL)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  out[0] = (x >>> 8) * UNORM;
  out[1] = (y >>> 8) * UNORM;
}

/**
 * Weights of the three control values around a point `f` (0..1) of the way through a knot
 * interval of a uniform quadratic B-spline. Non-negative, and they sum to 1.
 */
export function flickerBasis(f: number): [number, number, number] {
  const g = 1 - f;
  return [0.5 * g * g, 0.5 * (1 + 2 * f * g), 0.5 * f * f];
}

const knotA = new Float64Array(2);
const knotB = new Float64Array(2);
const knotC = new Float64Array(2);

/** Quadratic B-spline through the hashed knots of `lane`, one knot per unit of `p`, repeating every `period` knots. */
function spline(p: number, period: number, lane: number, out: Float64Array): void {
  const cell = Math.floor(p);
  const f = p - cell;
  const n = Math.max(period, 1);
  const i = cell % n;
  knot((i + n - 1) % n, lane, knotA);
  knot(i, lane, knotB);
  knot((i + 1) % n, lane, knotC);
  const g = 1 - f;
  const wa = g * g;
  const wb = 1 + 2 * f * g;
  const wc = f * f;
  out[0] = 0.5 * (knotA[0]! * wa + knotB[0]! * wb + knotC[0]! * wc);
  out[1] = 0.5 * (knotA[1]! * wa + knotB[1]! * wb + knotC[1]! * wc);
}

/** Time wrapped to [0, FLICKER_PERIOD], rounded to f32 as the shader sees it. */
function wrapTime(t: number): number {
  return f32(t - FLICKER_PERIOD * Math.floor(t / FLICKER_PERIOD));
}

const mainOut = new Float64Array(2);
const driftOut = new Float64Array(2);
const slowOut = new Float64Array(2);
const fastOut = new Float64Array(2);

/** The slow swing: a main octave plus a drift octave at a quarter of the rate, both in [0, 1]. */
function slow(tw: number, rate: number, laneMain: number, laneDrift: number): void {
  // A whole number of knots per period, in fours so the drift octave also closes the loop.
  const knots =
    4 * Math.floor(clampTo(f32(rate), 0, FLICKER_RATE_LIMIT) * (FLICKER_PERIOD / 4) + 0.5);
  const p = f32(tw * (knots / FLICKER_PERIOD));
  spline(p, knots, laneMain, mainOut);
  spline(0.25 * p, knots / 4, laneDrift, driftOut);
  slowOut[0] = mainOut[0]! + (driftOut[0]! - mainOut[0]!) * FLICKER_DRIFT_SHARE;
  slowOut[1] = mainOut[1]! + (driftOut[1]! - mainOut[1]!) * FLICKER_DRIFT_SHARE;
}

/** The lane base of a seed: `seed * 8u` in WGSL. Seeds are unsigned integers; the low 29 bits count. */
function lanes(seed: number): number {
  return Math.imul(seed >>> 0, 8) >>> 0;
}

// --- The signals ---------------------------------------------------------------------------------

/**
 * UNSAFE: the intensity signal with no caps on rate or size. At high settings it flashes faster
 * than WCAG 2.3.1 allows. Use only where the result cannot reach a large part of anyone's view
 * (a small spark, an offline render) or behind an explicit opt-in.
 */
export function flickerIntensityUnsafe(
  t: number,
  seed: number,
  settings: Readonly<FlickerSettings>,
): number {
  const tw = wrapTime(t);
  const lane = lanes(seed);
  slow(tw, settings.rate, lane + LANE_MAIN, lane + LANE_DRIFT);
  const knots = Math.floor(
    clampTo(f32(settings.shimmerRate), 0, FLICKER_RATE_LIMIT) * FLICKER_PERIOD + 0.5,
  );
  spline(f32(tw * (knots / FLICKER_PERIOD)), knots, lane + LANE_SHIMMER, fastOut);
  const depth = Math.max(f32(settings.depth), 0);
  const shimmer = Math.max(f32(settings.shimmer), 0);
  return clampTo(1 - depth * (1 - slowOut[0]!) - shimmer * (1 - fastOut[0]!), 0, 1);
}

/**
 * Intensity multiplier for a flickering light at time `t` (seconds), in
 * [1 - depth - shimmer, 1] with mean 1 - (depth + shimmer) / 2, after the settings are clamped to
 * the safe range. Different integer seeds give independent signals. Cannot produce more than three
 * WCAG 2.3.1 flashes in any second.
 */
export function flickerIntensity(
  t: number,
  seed: number,
  settings: Readonly<FlickerSettings> = FLICKER_DEFAULT,
): number {
  return flickerIntensityUnsafe(t, seed, flickerClamp(settings));
}

/** UNSAFE: the position signal with no cap on `rate`. See `flickerIntensityUnsafe`. */
export function flickerOffsetUnsafe(
  t: number,
  seed: number,
  settings: Readonly<FlickerSettings>,
): [number, number] {
  const lane = lanes(seed);
  slow(wrapTime(t), settings.rate, lane + LANE_OFFSET_MAIN, lane + LANE_OFFSET_DRIFT);
  return [2 * slowOut[0]! - 1, 2 * slowOut[1]! - 1];
}

/**
 * A wandering 2D offset in [-1, 1] per axis with mean 0, independent of the intensity of the same
 * seed. Only `rate` is used (clamped to the safe range); there is no fast part. Scale it by a
 * length that is small against the light's radius.
 */
export function flickerOffset(
  t: number,
  seed: number,
  settings: Readonly<FlickerSettings> = FLICKER_DEFAULT,
): [number, number] {
  return flickerOffsetUnsafe(t, seed, flickerClamp(settings));
}

// --- Measuring flashes ---------------------------------------------------------------------------

export interface FlashCount {
  /**
   * Sample index of every qualifying change, at the sample where it first amounted to
   * FLICKER_FLASH_DELTA. Directions alternate except across changes that did not qualify.
   */
  transitions: number[];
  /** The most qualifying changes found in any closed window of one second. */
  maxTransitions: number;
  /**
   * `floor(maxTransitions / 2)`: the most flashes in any one-second period. WCAG 2.3.1 allows
   * FLICKER_FLASH_LIMIT.
   */
  maxFlashes: number;
}

/**
 * Counts WCAG 2.3.1 general flashes in a sampled relative-luminance signal (0..1, 1 = full white)
 * that is taken to cover a large area.
 *
 * Local extremes are tracked with hysteresis: a change is recorded when the luminance has moved
 * FLICKER_FLASH_DELTA or more away from the last extreme, in the opposite direction to the change
 * that led to it. It qualifies when the darker of its two ends is below FLICKER_FLASH_DARK. A flash
 * is a pair of opposing changes, so a window holding `n` qualifying changes holds `floor(n / 2)`
 * flashes. Each change is placed at the instant it first qualifies in size, which counts at least
 * as many per window as requiring the whole change to lie inside it.
 */
export function countFlashes(luminance: ArrayLike<number>, sampleRate: number): FlashCount {
  // 0.6 - 0.5 is a hair under 0.1 in floating point; "10% or more" must still catch it.
  const delta = FLICKER_FLASH_DELTA - 1e-9;
  const transitions: number[] = [];
  const first = luminance[0] ?? 0;
  let direction = 0;
  let hi = first;
  let lo = first;
  // Where the fall in progress was detected. Whether it qualifies depends on how far it goes.
  let pendingAt = -1;

  const closeFall = () => {
    if (pendingAt >= 0 && lo < FLICKER_FLASH_DARK) transitions.push(pendingAt);
    pendingAt = -1;
  };

  for (let i = 1; i < luminance.length; i++) {
    const v = luminance[i] ?? 0;
    if (direction >= 0 && v > hi) hi = v;
    if (direction <= 0 && v < lo) lo = v;
    if (direction >= 0 && v <= hi - delta) {
      // A fall of 10% from the last high. Its darker end is not known until it turns.
      direction = -1;
      lo = v;
      pendingAt = i;
    } else if (direction <= 0 && v >= lo + delta) {
      // A rise of 10% from the last low, which is its darker end.
      closeFall();
      if (lo < FLICKER_FLASH_DARK) transitions.push(i);
      direction = 1;
      hi = v;
    }
  }
  closeFall();

  // Already in time order: a fall is always listed before the rise that ends it.
  const window = Math.round(sampleRate);
  let maxTransitions = 0;
  let start = 0;
  for (let end = 0; end < transitions.length; end++) {
    while (transitions[end]! - transitions[start]! > window) start++;
    maxTransitions = Math.max(maxTransitions, end - start + 1);
  }
  return { transitions, maxTransitions, maxFlashes: Math.floor(maxTransitions / 2) };
}
