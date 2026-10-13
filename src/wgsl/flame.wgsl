// flame.wgsl -- 2D flame shaping: silhouette SDFs, height envelopes, turbulence, edge erosion and
// the heat field that every 2D flame (candle, torch, fireplace, flame strip, fire ring) is built
// from. The chunk evaluates NO noise: the caller generates and advects it and passes the values
// in, so everything here is a few dozen ALU ops.
//
// Flame space
//   Origin at the CENTRE OF THE BASE, +y up, the tip at (0, height). Units are the caller's; the
//   usual choice is height = 1 ("flame heights"). Every shape is mirror-symmetric in x.
//   t = y / height is the normalised height: 0 at the base, 1 at the tip.
//   Sign convention as sdf.wgsl: negative inside, 0 on the surface, positive outside.
//
// Silhouettes (both EXACT Euclidean distances, Lipschitz-1 inside and outside; combine them with
// the sd_* / smin_* helpers of sdf.wgsl, e.g. sd_round(flame_sd_taper(..), r) to round the corners)
//   flame_sd_teardrop(p, half_width, height) -> f32
//       Round base, pointed tip: a circle of radius half_width resting on the origin (centre at
//       (0, half_width), so the widest point is at y = half_width) joined by its two tangent lines
//       to the tip (0, height). half_width is clamped to [0, height / 2]; at the upper limit the
//       shape is a circle, at 0 a line. Deepest point: the circle's centre, d = -half_width.
//       ~15 ALU ops, 1 sqrt.
//   flame_sd_taper(p, base_half_width, tip_half_width, height) -> f32
//       Tapering column for jets and torches: a flat base from (-base, 0) to (base, 0), straight
//       sides, a flat top from (-tip, height) to (tip, height). tip = 0 is a cone (a triangle),
//       tip = base a column, tip > base a widening jet. ~20 ALU ops, 1 sqrt.
//
// Height envelopes (t is clamped to [0, 1] first; `power` is clamped to >= 0.001; one pow each)
//   flame_tip_weight(t, power) -> f32             [0, 1]: t^power. EXACTLY 0 at and below the base,
//       1 at and above the tip. The envelope of everything that must leave the base anchored.
//       power 1 = linear, 2 = the lower half barely moves, 0.5 = most of the flame is affected.
//   flame_height_falloff(t, start, power) -> f32  [0, 1]: heat fading with height. 1 at and below
//       t = start, then (1 - u)^power with u running 0..1 from `start` to the tip, 0 at and above
//       the tip. power < 1 keeps the flame hot almost to the tip, > 1 cools it early. `start` is
//       clamped to [0, 0.999].
//
// Turbulence and erosion (the noise is an INPUT)
//   flame_turbulence(p, noise: vec2f, amount, height, power) -> vec2f
//       The sample position displaced by noise * amount * flame_tip_weight(p.y / height, power):
//       sway and lick. `noise` is signed, nominally in [-1, 1] per axis (x = sideways sway, y =
//       stretch; pass 0 for an axis you do not want); `amount` is the displacement at the tip in
//       flame units. Returns p unchanged, bit for bit, at and below the base. An SDF evaluated at
//       the result is a bound, not a distance: for noise that is constant in space its Lipschitz
//       constant is at most 1 + |noise| * amount * power / height (power >= 1).
//   flame_erode(d, noise, amount, t, power) -> f32
//       d + noise * amount * flame_tip_weight(t, power): the surface recedes by up to `amount`
//       (flame units) where noise = 1, more at the tip than at the base, which breaks the edge
//       into tongues and pinches off detached licks. With noise in [0, 1] the shape only ever
//       SHRINKS, so the bare SDF stays a conservative bound; negative noise grows it. Zero noise
//       or zero amount returns d unchanged.
//
// Heat (0..1; feed it to a ramp, e.g. ramp_fire(heat) from ramp.wgsl)
//   struct FlameParams      turbulence, erosion and core are in units of half_width, so a flame
//                           keeps its character when it is made thinner or wider
//     half_width        widest half extent of the shape, flame units                       > 0
//     height            height of the tip above the base, flame units                      > 0
//     turbulence        sideways travel of the tip, in half_widths, at noise = +-1         0 .. 1.5
//     turbulence_curve  flame_tip_weight power of the displacement                         1 .. 3
//     erosion           depth removed at the tip, in half_widths, at noise = 1             0 .. 1.5
//     erosion_curve     flame_tip_weight power of the erosion                              0.3 .. 2
//     core              interior depth, in half_widths, at which the body saturates: small = a
//                       flat hot body with a thin rim, 1 = hottest only on the axis        0.2 .. 1
//     hot               normalised height of the hot spot: no height falloff below it      0 .. 0.6
//     falloff           flame_height_falloff power above `hot`                             0.1 .. 3
//     base_soft         0 = full heat right down to the base, 1 = heat fades to nothing at the
//                       base (over the heights 0 .. hot): the cool foot of a candle flame  0 .. 1
//   flame_params(half_width, height) -> FlameParams   the given size with the defaults: turbulence
//       0.6, turbulence_curve 1.6, erosion 0.85, erosion_curve 1.1, core 0.85, hot 0.2,
//       falloff 0.45, base_soft 0.8
//   flame_params_default() -> FlameParams             flame_params(0.19, 1.0)
//   flame_heat_from_sd(d, t, erosion_noise, params) -> f32
//       The shading shared by every shape, for an SDF of your own (a ring, a strip, a union of
//       tongues). d is the distance at the (already displaced) sample position, t its normalised
//       height. Erodes d, turns interior depth into a body value (0 on the surface, depth^0.7,
//       1 at depth core * half_width), then multiplies by the base fade and the height falloff.
//       0 on and outside the eroded surface and at or above the tip.
//   flame_heat_teardrop(uv, noise: vec2f, params) -> f32
//       The whole chain for one flame at flame-space position uv: turbulence, SDF, erosion, heat.
//       noise.x = sway noise in [-1, 1], noise.y = erosion noise in [0, 1] (0 = untouched).
//       With zero noise the hottest point is on the axis at t = hot (exactly 1 when hot * height
//       is within (1 - core) * half_width of the circle's centre, as with the defaults), and heat
//       falls monotonically up the axis to 0 at the tip and outward to 0 on the surface.
//   flame_heat_taper(uv, noise: vec2f, tip_half_width, params) -> f32
//       Same for the taper (base half-width params.half_width, tip_half_width in flame units),
//       with an OPEN BASE: the base line is not a soft edge. The sides are continued one
//       half_width below y = 0 and the result is cut to 0 at uv.y <= 0, so with base_soft = 0 and
//       hot = 0 the flame leaves its burner at full heat. Cover the cut with the emitter.
//   flame_reach(uv, params) -> bool
//       Conservative early-out: false only where flame_heat_teardrop and flame_heat_taper (tip not
//       wider than the base) are 0 for EVERY noise.x in [-1, 1] and noise.y >= 0. Test it before
//       generating the noise. ~8 ALU ops, 1 pow.
//
// Cost: flame_heat_teardrop / flame_heat_taper are about 50 ALU ops, one sqrt and four pow per
// call, with no noise evaluation and no texture fetch. The noise the caller feeds them is the
// whole budget. The visible flame is shorter than `height`: with the default erosion the body ends
// around t = 0.6 and the thin tip above it holds the licks, so size the silhouette generously.
// The teardrop is the uneven capsule with a zero tip radius and the taper the isosceles trapezoid,
// both after Inigo Quilez's "2D distance functions", re-derived here for a base-anchored frame.

struct FlameParams {
  half_width: f32,
  height: f32,
  turbulence: f32,
  turbulence_curve: f32,
  erosion: f32,
  erosion_curve: f32,
  core: f32,
  hot: f32,
  falloff: f32,
  base_soft: f32,
}

const _FLAME_EPS: f32 = 1e-6;
// Body profile exponent: below 1 so heat climbs steeply from the surface and the dim rim is thin.
const _FLAME_BODY_POWER: f32 = 0.7;

// ---- Silhouettes --------------------------------------------------------------------------------

fn flame_sd_teardrop(p: vec2f, half_width: f32, height: f32) -> f32 {
  let h = max(height, _FLAME_EPS);
  let r = clamp(half_width, 0.0, 0.5 * h);
  let q = vec2f(abs(p.x), p.y - r); // relative to the circle's centre
  let rise = h - r; // centre to tip
  // (cos_n, sin_n) is the outward normal of the right-hand tangent line.
  let sin_n = r / rise;
  let cos_n = sqrt(max(1.0 - sin_n * sin_n, 0.0));
  // Position along the tangent line: below 0 the circle is nearest, past the tip the tip is.
  let along = dot(q, vec2f(-sin_n, cos_n));
  if (along < 0.0) {
    return length(q) - r;
  }
  if (along > cos_n * rise) {
    return length(q - vec2f(0.0, rise));
  }
  return dot(q, vec2f(cos_n, sin_n)) - r;
}

fn flame_sd_taper(p: vec2f, base_half_width: f32, tip_half_width: f32, height: f32) -> f32 {
  let h = max(height, _FLAME_EPS);
  let r_base = max(base_half_width, 0.0);
  let r_tip = max(tip_half_width, 0.0);
  let q = vec2f(abs(p.x), p.y);
  // Offset from the nearer cap (base below mid-height, top above); .y < 0 between the two caps.
  let cap_r = select(r_tip, r_base, q.y < 0.5 * h);
  let cap = vec2f(q.x - min(q.x, cap_r), abs(q.y - 0.5 * h) - 0.5 * h);
  // Offset from the nearest point of the slanted side (r_base, 0) -> (r_tip, h).
  let edge = vec2f(r_tip - r_base, h);
  let w = q - vec2f(r_base, 0.0);
  let side = w - edge * clamp(dot(w, edge) / dot(edge, edge), 0.0, 1.0);
  let dist = sqrt(min(dot(cap, cap), dot(side, side)));
  return select(dist, -dist, side.x < 0.0 && cap.y < 0.0);
}

// ---- Height envelopes ---------------------------------------------------------------------------

fn flame_tip_weight(t: f32, power: f32) -> f32 {
  // pow(0, y) is 0 in exact arithmetic but is computed through a logarithm; the select keeps the
  // base anchored exactly on every backend.
  return select(pow(clamp(t, 0.0, 1.0), max(power, 1e-3)), 0.0, t <= 0.0);
}

fn flame_height_falloff(t: f32, start: f32, power: f32) -> f32 {
  let s = clamp(start, 0.0, 0.999);
  let u = clamp((t - s) / (1.0 - s), 0.0, 1.0);
  return select(pow(1.0 - u, max(power, 1e-3)), 0.0, u >= 1.0);
}

// ---- Turbulence and erosion ---------------------------------------------------------------------

fn flame_turbulence(p: vec2f, noise: vec2f, amount: f32, height: f32, power: f32) -> vec2f {
  return p + noise * (amount * flame_tip_weight(p.y / max(height, _FLAME_EPS), power));
}

fn flame_erode(d: f32, noise: f32, amount: f32, t: f32, power: f32) -> f32 {
  return d + noise * amount * flame_tip_weight(t, power);
}

// ---- Heat ---------------------------------------------------------------------------------------

fn flame_params(half_width: f32, height: f32) -> FlameParams {
  return FlameParams(half_width, height, 0.6, 1.6, 0.85, 1.1, 0.85, 0.2, 0.45, 0.8);
}

fn flame_params_default() -> FlameParams {
  return flame_params(0.19, 1.0);
}

fn flame_heat_from_sd(d: f32, t: f32, erosion_noise: f32, params: FlameParams) -> f32 {
  let w = max(params.half_width, _FLAME_EPS);
  let eroded = flame_erode(d, erosion_noise, params.erosion * w, t, params.erosion_curve);
  let depth = clamp(-eroded / (max(params.core, 1e-3) * w), 0.0, 1.0);
  let body = pow(depth, _FLAME_BODY_POWER);
  let base = 1.0 - params.base_soft * (1.0 - smoothstep(0.0, max(params.hot, 1e-3), t));
  return body * base * flame_height_falloff(t, params.hot, params.falloff);
}

fn flame_heat_teardrop(uv: vec2f, noise: vec2f, params: FlameParams) -> f32 {
  let travel = params.turbulence * params.half_width;
  let p = flame_turbulence(uv, vec2f(noise.x, 0.0), travel, params.height, params.turbulence_curve);
  let d = flame_sd_teardrop(p, params.half_width, params.height);
  return flame_heat_from_sd(d, p.y / max(params.height, _FLAME_EPS), noise.y, params);
}

fn flame_heat_taper(uv: vec2f, noise: vec2f, tip_half_width: f32, params: FlameParams) -> f32 {
  let h = max(params.height, _FLAME_EPS);
  let travel = params.turbulence * params.half_width;
  let p = flame_turbulence(uv, vec2f(noise.x, 0.0), travel, h, params.turbulence_curve);
  // Open base: the sides are continued one half_width below y = 0 so the base is not a soft edge
  // of the distance field, and the flame is cut on the base line instead.
  let sink = params.half_width;
  let sunk_half_width = params.half_width + (params.half_width - tip_half_width) * sink / h;
  let d = flame_sd_taper(p + vec2f(0.0, sink), sunk_half_width, tip_half_width, h + sink);
  return select(flame_heat_from_sd(d, p.y / h, noise.y, params), 0.0, uv.y <= 0.0);
}

fn flame_reach(uv: vec2f, params: FlameParams) -> bool {
  let t = uv.y / max(params.height, _FLAME_EPS);
  let travel = abs(params.turbulence) * flame_tip_weight(t, params.turbulence_curve);
  return uv.y > 0.0 && uv.y < params.height && abs(uv.x) < params.half_width * (1.0 + travel);
}
