// flicker.wgsl -- band-limited flicker signals for fire: one for INTENSITY, one for POSITION, with
// caps that keep a light driven by them under the WCAG 2.3.1 flash threshold BY CONSTRUCTION.
// TypeScript twin with the same numbers: src/gpu/emission/flicker.ts.
//
// Settings
//   struct FlickerSettings { rate, depth, shimmer, shimmer_rate }       all f32
//     rate          knots per second of the slow swing: how often it picks a new random target.
//                   The fastest possible full swing (down and back up) is rate / 2 Hz.
//     depth         largest slow swing, as a fraction of full scale (0..1).
//     shimmer       peak-to-peak size of the fast part, as a fraction of full scale.
//     shimmer_rate  knots per second of the fast part.
//   flicker_settings(rate, depth, shimmer, shimmer_rate) -> FlickerSettings     plain constructor
//   flicker_default() -> FlickerSettings        (3, 0.3, 0.03, 13): a calm candle or torch
//   flicker_clamp(s) -> FlickerSettings         the nearest settings inside the safe range:
//                   rate in [0, FLICKER_SAFE_MAX_RATE], shimmer in [0, FLICKER_SAFE_MAX_SHIMMER],
//                   shimmer_rate in [0, FLICKER_SAFE_MAX_SHIMMER_RATE], and
//                   depth in [0, FLICKER_SAFE_MAX_DEPTH - shimmer] so the output never clips.
//
// Signals (t = time in seconds; seed = any u32, of which the low 29 bits count: different seeds
// give independent signals with their knots at the same instants)
//   flicker_intensity(t, seed, s) -> f32
//       Multiplier for a light's radiance, in [1 - depth - shimmer, 1], mean
//       1 - (depth + shimmer) / 2. SAFE: the settings pass through flicker_clamp first.
//   flicker_offset(t, seed, s) -> vec2f
//       A wandering offset in [-1, 1] per axis, mean 0, rms about 0.31 per axis, independent of the
//       intensity of the same seed. Uses only `rate` (clamped); it has no fast part. Multiply by a
//       length that is small against the light's radius.
//   flicker_intensity_unsafe(t, seed, s) -> f32      NO CAPS. Result clamped to [0, 1].
//   flicker_offset_unsafe(t, seed, s) -> vec2f       NO CAPS.
//       The opt-out. At high settings these flash faster than WCAG allows. Use them only where the
//       result cannot fill a large part of anyone's view, or behind an explicit opt-in. Rates are
//       still limited to FLICKER_RATE_LIMIT (512), which is arithmetic hygiene, not a safety cap;
//       negative depth and shimmer count as 0.
//
// Construction
//   slow(t)    = mix(B(rate * t), B'(rate * t / 4), FLICKER_DRIFT_SHARE)      in [0, 1]
//   fast(t)    = B''(shimmer_rate * t)                                         in [0, 1]
//   intensity  = 1 - depth * (1 - slow) - shimmer * (1 - fast)
//   offset     = 2 * slow2(t) - 1         (slow2: the same shape with two values per knot)
//   B(p) is a uniform quadratic B-spline whose control values are hashes of the knot index and the
//   seed, uniform in [0, 1). It is C1, stays inside the range of its control values, and is a
//   low-pass filter: control values that alternate 0, 1, 0, 1 come out as a swing of only 0.5.
//   Typical swings are therefore well inside `depth`: the standard deviation of the intensity is
//   about 0.15 * depth, and 90% of the time it is within about +-0.25 * depth of its mean.
//
// Why it is safe
//   WCAG 2.3.1 (general flash): no more than three flashes in any one-second period, a flash being
//   a pair of opposing changes in relative luminance of 10% or more of the maximum (1.0 = white)
//   where the darker state is below 0.80.
//   1. The derivative of a quadratic B-spline is piecewise LINEAR between knots, so the spline can
//      reverse direction at most once per knot interval. The drift octave has its knots on every
//      fourth knot of the main one, so the sum is again such a spline at `rate` knots per second.
//   2. A run of n alternating changes that all fit in one second needs n - 2 reversals strictly
//      inside it, hence more than n - 4 knot intervals: n < rate + 4. With rate <= 4 that is at
//      most 7 changes, i.e. 3 flashes, even when every change is as large as the whole range.
//      FLICKER_SAFE_MAX_RATE = 4 is the largest rate for which this argument holds. It is a bound
//      over ALL control values; the worst found, for hashed and for adversarial ones, is 5 changes,
//      i.e. 2 flashes (tests/emission-motion.test.ts).
//   3. The fast part cannot make a flash alone (its whole range is 4%, under 10%) and cannot add
//      one: a 10% change of the sum still needs the slow part to move 6% the same way.
//   The argument survives any monotone display curve whose slope times the shimmer stays under
//   10%, so FLICKER_SAFE_MAX_SHIMMER = 0.04 leaves a gain of 2.5 (exposure, tonemapping) in hand.
//   It also survives MIXING lights: B is linear in its control values and every seed has its knots
//   at the same instants, so any weighted sum of signals that share one `rate` is again a spline of
//   that rate. Lights that overlap on screen should share `rate` and differ in seed and depth.
//   What it does not cover: lights with different rates summed over one area, time that is scaled
//   or stepped by the caller (`t` must be real seconds: a speed factor multiplies both rates), and
//   whatever else the effect animates.
//   Position: each axis of the offset obeys the same reversal bound, but a light sliding across a
//   pixel changes that pixel's luminance in ways the bound does not reach. Keep the offset's scale
//   under about a tenth of the light's radius and motion alone stays far below 10% of white.
//
// Other properties (all measured in tests/emission-motion.test.ts)
//   * Slope: |d intensity / dt| <= 0.7 * depth * rate + shimmer * shimmer_rate per second; at the
//     safe caps that is 3.65 /s, or 0.016 per 1/240 s.
//   * Period: every signal repeats EXACTLY every FLICKER_PERIOD = 1024 s. To make that so, rates
//     are rounded to a whole number of knots per period: `rate` to a multiple of 1/256 Hz,
//     `shimmer_rate` to a multiple of 1/1024 Hz. A rate of 0 freezes the part at a constant.
//   * Time precision: t is wrapped to [0, 1024) internally, but an f32 cannot resolve a frame once
//     t is large (steps of 0.5 ms at 4096 s, 8 ms at 65536 s). Wrap on the CPU, in f64, before
//     converting: t = seconds % FLICKER_PERIOD. The wrap is seamless.
//   * Determinism: integer hashing, so every device gets the same knots; the TS twin agrees to
//     about 1e-6.
//
// Cost: flicker_intensity 9 pcg_2d hashes (~180 integer ops) plus ~60 float ops, no branches, no
// textures; flicker_offset 6 hashes. Cheap per light, wasteful per pixel: evaluate once per light
// in the vertex stage, in a small texture (as src/effects/flicker does), or on the CPU with the
// twin. GPU time has not been measured.

#include "hash.wgsl"

// The signal repeats exactly with this period, in seconds.
const FLICKER_PERIOD: f32 = 1024.0;

// Safe caps (see "Why it is safe").
const FLICKER_SAFE_MAX_RATE: f32 = 4.0;
const FLICKER_SAFE_MAX_DEPTH: f32 = 1.0;
const FLICKER_SAFE_MAX_SHIMMER: f32 = 0.04;
const FLICKER_SAFE_MAX_SHIMMER_RATE: f32 = 24.0;

// Numeric limit on both rates in the unsafe path. Not a safety cap.
const FLICKER_RATE_LIMIT: f32 = 512.0;

// Share of the slow swing given to the quarter-rate drift octave.
const FLICKER_DRIFT_SHARE: f32 = 0.4;

// Lanes keep the parts of one seed's signal independent of each other.
const _FLICKER_LANE_MAIN: u32 = 0u;
const _FLICKER_LANE_DRIFT: u32 = 1u;
const _FLICKER_LANE_SHIMMER: u32 = 2u;
const _FLICKER_LANE_OFFSET_MAIN: u32 = 3u;
const _FLICKER_LANE_OFFSET_DRIFT: u32 = 4u;

struct FlickerSettings {
  rate: f32,
  depth: f32,
  shimmer: f32,
  shimmer_rate: f32,
}

fn flicker_settings(rate: f32, depth: f32, shimmer: f32, shimmer_rate: f32) -> FlickerSettings {
  return FlickerSettings(rate, depth, shimmer, shimmer_rate);
}

fn flicker_default() -> FlickerSettings {
  return FlickerSettings(3.0, 0.3, 0.03, 13.0);
}

fn flicker_clamp(s: FlickerSettings) -> FlickerSettings {
  let shimmer = clamp(s.shimmer, 0.0, FLICKER_SAFE_MAX_SHIMMER);
  return FlickerSettings(
    clamp(s.rate, 0.0, FLICKER_SAFE_MAX_RATE),
    clamp(s.depth, 0.0, FLICKER_SAFE_MAX_DEPTH - shimmer),
    shimmer,
    clamp(s.shimmer_rate, 0.0, FLICKER_SAFE_MAX_SHIMMER_RATE),
  );
}

// One knot's two control values, uniform in [0, 1).
fn _flicker_knot(index: i32, lane: u32) -> vec2f {
  return to_unorm_2d(pcg_2d(vec2u(u32(index), lane)));
}

// Uniform quadratic B-spline through the knots of `lane`: one knot per unit of p (p >= 0),
// repeating every `period` knots. The three weights are non-negative and sum to 1.
fn _flicker_spline(p: f32, period: i32, lane: u32) -> vec2f {
  let cell = floor(p);
  let f = p - cell;
  let g = 1.0 - f;
  let n = max(period, 1);
  let i = i32(cell) % n;
  let a = _flicker_knot((i + n - 1) % n, lane);
  let b = _flicker_knot(i, lane);
  let c = _flicker_knot((i + 1) % n, lane);
  return 0.5 * (a * (g * g) + b * (1.0 + 2.0 * f * g) + c * (f * f));
}

// Time wrapped to [0, FLICKER_PERIOD]. Exact: the period is a power of two.
fn _flicker_time(t: f32) -> f32 {
  return t - FLICKER_PERIOD * floor(t / FLICKER_PERIOD);
}

// The slow swing, two values in [0, 1]: a main octave plus a drift octave at a quarter of the rate.
fn _flicker_slow(tw: f32, rate: f32, lane_main: u32, lane_drift: u32) -> vec2f {
  // A whole number of knots per period, in fours so the drift octave also closes the loop.
  let knots = 4.0 * floor(clamp(rate, 0.0, FLICKER_RATE_LIMIT) * (FLICKER_PERIOD / 4.0) + 0.5);
  let p = tw * (knots / FLICKER_PERIOD);
  let main = _flicker_spline(p, i32(knots), lane_main);
  let drift = _flicker_spline(0.25 * p, i32(knots) / 4, lane_drift);
  return mix(main, drift, FLICKER_DRIFT_SHARE);
}

fn flicker_intensity_unsafe(t: f32, seed: u32, s: FlickerSettings) -> f32 {
  let tw = _flicker_time(t);
  let lane = seed * 8u;
  let slow = _flicker_slow(tw, s.rate, lane + _FLICKER_LANE_MAIN, lane + _FLICKER_LANE_DRIFT).x;
  let knots = floor(clamp(s.shimmer_rate, 0.0, FLICKER_RATE_LIMIT) * FLICKER_PERIOD + 0.5);
  let p = tw * (knots / FLICKER_PERIOD);
  let fast = _flicker_spline(p, i32(knots), lane + _FLICKER_LANE_SHIMMER).x;
  return saturate(1.0 - max(s.depth, 0.0) * (1.0 - slow) - max(s.shimmer, 0.0) * (1.0 - fast));
}

fn flicker_intensity(t: f32, seed: u32, s: FlickerSettings) -> f32 {
  return flicker_intensity_unsafe(t, seed, flicker_clamp(s));
}

fn flicker_offset_unsafe(t: f32, seed: u32, s: FlickerSettings) -> vec2f {
  let lane = seed * 8u;
  let slow = _flicker_slow(
    _flicker_time(t), s.rate, lane + _FLICKER_LANE_OFFSET_MAIN, lane + _FLICKER_LANE_OFFSET_DRIFT);
  return 2.0 * slow - 1.0;
}

fn flicker_offset(t: f32, seed: u32, s: FlickerSettings) -> vec2f {
  return flicker_offset_unsafe(t, seed, flicker_clamp(s));
}
