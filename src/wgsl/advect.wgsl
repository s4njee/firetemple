// advect.wgsl -- noise that looks carried by rising hot gas instead of sliding past as one texture.
//
// Every variant answers the same question: "what is the noise at p now, given that the gas has
// risen by `drift` and its eddies have aged by `t`?" The shared arguments are
//   p        vec2f  position in lattice units (noise cells are 1.0 wide), y up
//   drift    vec2f  how far the gas has travelled so far, in lattice units: the integral of its
//                   velocity, e.g. vec2f(0.0, speed * seconds). Accumulate it on the CPU from
//                   time.delta so that changing the speed never makes the picture jump
//   t        f32    evolution clock, independent of the drift. About one unit per second suits a
//                   pattern rising one or two cells per second; held constant, only the drift acts
//   octaves  i32    octaves of the pattern (lacunarity 2, gain 0.5), clamped to [0, 16]
// Each returns a zero-mean value in [-1, 1] with the spread of fbm_2d (std dev 0.19 at 4 octaves,
// values within about +-0.75), so swapping variants does not change how much flame there is. The
// four "amount" variants share one call shape: advect_x(p, drift, t, amount, octaves).
//
// Cost is in noise evaluations per call at octaves = 4, and in the lattice corners they hash
// (2D = 4 corners, 3D = 8), which is the better guide to GPU time.
//
//   advect_scroll(p, drift, t, octaves) -> f32   4 x 3D, 32 corners
//       fbm_3d(vec3f(p - drift, t)), rescaled to the common spread: the baseline. With t held
//       constant it is exactly a translation, a rigid sliding texture. t fades features in and out
//       where they are ("boiling"); nothing moves relative to anything else. Its spread dips by 6%
//       once per unit of t, where octave 0 crosses a lattice plane. Without t, fbm_2d(p - drift)
//       is half the price.
//   advect_warp(p, drift, t, strength, octaves) -> f32   2 x 3D + 4 x 2D, 32 corners
//   advect_warp_pos(p, drift, t, strength) -> vec2f   2 x 3D, 16 corners
//       Scroll plus an animated domain warp of the lookup. `strength` is the RMS displacement in
//       lattice units; 0.2-0.5 is the useful span, 0 is a rigid scroll of fbm_2d. Good: features
//       visibly move relative to their neighbours, more than with any other single-sample variant.
//       Bad: the two warp components are unrelated, so the map has divergence: features swell and
//       pinch (RMS area change 0.56 at strength 0.4), and it costs two field evaluations.
//       _pos returns the lookup position (drift already subtracted) for a pattern of your own.
//   advect_curl(p, drift, t, strength, octaves) -> f32   1 x 3D + 4 x 2D, 24 corners
//   advect_curl_pos(p, drift, t, strength) -> vec2f   1 x 3D with gradient, 8 corners
//       Scroll plus one step backwards along a divergence-free curl-noise field. `strength` is again
//       the RMS displacement in lattice units, 0 a rigid scroll. Zero divergence makes the area
//       change second order in the strength (RMS 0.10 at 0.2, 0.39 at 0.4, against 0.27 and 0.56
//       for the warp): features shear and swirl without swelling. Good: the same decorrelation as
//       the warp for one field evaluation instead of two. Bad: it is one displacement, not an
//       integrated advection; the field is rougher than the warp's, so past strength ~0.5 fine
//       detail is drawn out into fibres.
//   advect_flownoise(p, drift, t, advection, octaves) -> f32   4 x 2D with gradient, 16 corners
//       Flow noise (Perlin & Neyret 2001): a fractal sum of rotating-gradient noise. Octave 0 turns
//       by t radians (RMS; see advect_rotnoise_2d), each finer octave ADVECT_SPIN_GAIN times faster.
//       With `advection` > 0 each octave is looked up `advection` times the summed gradient of the
//       coarser octaves away ("pseudo-advection"): fine detail is pushed off the crests of the
//       large shapes into the troughs between them, giving round billows with sharp dark creases.
//       0 = off, 0.1-0.2 useful, more turns the creases into a net. The cheapest variant: no 3D
//       noise, but 4 sin/cos pairs per evaluation. Good: features turn over and die on their own.
//       Bad: like the scroll clock it changes features where they are (nothing travels sideways),
//       and the billow look is its own thing, closer to lava or thick smoke than to flame tongues.
//   advect_rotnoise_2d(p, angle) -> f32   1 x 2D, 4 corners
//   advect_rotnoise_2d_d(p, angle) -> vec3f   1 x 2D, 4 corners
//       The noise flow noise is made of: gradient noise whose lattice gradients rotate. Range
//       [-1, 1], zero on integer points and the statistics of gnoise_2d at every angle. Each gradient
//       starts at a hashed phase and turns at its own hashed rate, triangular over +-2.45 times the
//       angle (RMS 1, both senses). That makes the correlation between the field at two angles
//       sinc^2 of their difference: it falls to zero by 2.6 radians and never goes negative. With one
//       shared rate, as in the original, it is cos: the field turns into its negative every half
//       turn and repeats exactly. _d returns (value, d/dx, d/dy), the analytic gradient.
//   advect_twophase(p, drift, t, strength, cycle, octaves) -> f32   1 x 3D + 9 x 2D, 44 corners
//   advect_flowmap(p, drift, t, flow, cycle, octaves) -> f32   9 x 2D, 36 corners
//       Advection along a velocity field for as long as you like without accumulating stretch: the
//       flow-map technique (Vlachos 2010). The pattern is sampled at two phases half a cycle apart;
//       each follows the flow for `cycle` units of t and is then reset, and a triangle cross-fade
//       gives a phase zero weight while it resets. `flow` is the local velocity relative to the
//       drift, in lattice units per unit t: a flow-map texture, a plume profile, noise.
//       advect_twophase supplies a slowly evolving curl-noise flow of RMS speed `strength`. A phase
//       is displaced by at most flow * cycle / 2; keep |flow| * cycle below about 1.5. Good: the only
//       variant in which features travel along streamlines, and the one to use when the flame has a
//       real velocity field. Bad: twice the pattern cost, features live no longer than `cycle`, and
//       most of its change over a short time is cross-fading, not motion.
//   advect_phases(p, drift, t, flow, cycle, jitter) -> AdvectPhases   1 x 2D, 4 corners
//   advect_phase_mix(a: f32, b: f32, ph: AdvectPhases) -> f32
//       The two halves of the technique, for patterns other than fbm (a texture, Voronoi, a flame
//       shape). advect_phases returns the two lookup positions (.pos_a, .pos_b; drift subtracted,
//       each moved to an unrelated part of the pattern, and to a new one every cycle so that no
//       cycle replays the last) and the weight of b (.mix_b; a has 1 - mix_b). `jitter` offsets the
//       phase per pixel by that many cycles times smooth noise fixed to p (about +-0.7), so the
//       frame does not reset all at once; pass ADVECT_PHASE_JITTER, or 0 for none. It also scales
//       the apparent speed by 1 / (1 - cycle * dot(flow, gradient of the offset)), about +-13% at
//       flow 0.5, cycle 2: the reason for the limit on |flow| * cycle. advect_phase_mix blends two
//       ZERO-MEAN samples and divides by sqrt(w^2 + (1 - w)^2): a plain mix of two unrelated
//       signals keeps only half its variance at mid-fade, which shows as the pattern going soft
//       and flat twice per cycle. The result can reach sqrt(2) times the inputs; advect_flowmap and
//       advect_twophase clamp it to [-1, 1]. For a pattern with a mean, subtract it first.
//
// Combining: the _pos functions compose with any pattern, including flow noise. Curl-displaced flow
// noise moves features AND lets them die, for 24 corners:
//   advect_flownoise(advect_curl_pos(p, drift, t, 0.4), vec2f(0.0), 1.35 * t, 0.12, 4)
//
// What moves with what: the pattern with the full drift; the warp, curl and flow fields with
// ADVECT_FIELD_DRIFT of it (vortices in a shear layer travel at about half the speed of the gas),
// so even with t held constant the pattern shears through them; the phase offset is fixed to p.
// Warp and curl displacements are bounded, so they cannot remove a feature larger than the
// displacement: the coarsest octave survives and is still seen to slide (co-moving correlation
// 0.25-0.3 after a second at strength 0.4). Give the pattern its own evolution if that shows.
//
// Techniques: K. Perlin and F. Neyret, "Flow Noise" (SIGGRAPH 2001 technical sketch); S. Gustavson's
// psrdnoise for the gradient form of the pseudo-advection; R. Bridson et al., "Curl-Noise for
// Procedural Fluid Flow" (2007); A. Vlachos, "Water Flow in Portal 2" (SIGGRAPH 2010 course);
// I. Quilez, "Domain warping". Code written from the published descriptions.

#include "curl.wgsl"

const ADVECT_LACUNARITY: f32 = 2.0;
const ADVECT_GAIN: f32 = 0.5;
// The warp, curl and flow fields: frequency relative to the pattern, the share of the drift they
// move with, and their octave count (one keeps the strain low for a given displacement).
const ADVECT_FIELD_SCALE: f32 = 0.5;
const ADVECT_FIELD_DRIFT: f32 = 0.5;
const ADVECT_FIELD_OCTAVES: i32 = 1;
// Flow noise: each octave's gradients turn this much faster than the one below. 2^(2/3), the
// Kolmogorov scaling of eddy turnover rate with a doubling of frequency.
const ADVECT_SPIN_GAIN: f32 = 1.5874;
// Two-phase blend: the default per-pixel phase offset (in cycles, times noise in about +-0.7; enough
// to spread the resets over half a cycle), the frequency of that noise relative to the pattern, and
// how fast advect_twophase's flow field evolves relative to t (slowly, so that a phase sees a nearly
// steady flow during its life).
const ADVECT_PHASE_JITTER: f32 = 0.35;
const ADVECT_PHASE_SCALE: f32 = 0.3;
const ADVECT_FLOW_EVOLVE: f32 = 0.35;

// 3D gradient noise has a smaller spread than 2D (std dev 0.160 against 0.188 at four octaves, the
// same ratio at any octave count); this brings advect_scroll level with the other variants. Its
// slices are flattest on lattice planes, so t = 0 is placed a quarter of a cell off one, where the
// spread is the average.
const _ADVECT_SCROLL_GAIN: f32 = 1.175;
const _ADVECT_SCROLL_PLANE: f32 = 0.25;
// 1 / (RMS length of the raw displacement), measured over 60 000 samples and checked by
// tests/emission-motion.test.ts, so that `strength` is an RMS distance in lattice units.
const _ADVECT_WARP_NORM: f32 = 2.717;
const _ADVECT_CURL_NORM: f32 = 1.037;
// Half-width of the triangular distribution of gradient turning rates: sqrt(6), which makes the
// RMS rate 1 radian per unit angle.
const _ADVECT_SPIN_SPREAD: f32 = 2.4495;
// Unit gradients peak at sqrt(1/2) in the middle of a cell, as in gnoise_2d.
const _ADVECT_ROTNOISE_SCALE: f32 = 1.4142;
const _ADVECT_PHASE_SEED = vec2f(11.3, 47.9);
const _ADVECT_LAYER_SPREAD: f32 = 64.0;

struct AdvectPhases {
  pos_a: vec2f,
  pos_b: vec2f,
  mix_b: f32,
}

// Where the warp, curl and flow fields are sampled for the pattern position p.
fn _advect_field_pos(p: vec2f, drift: vec2f) -> vec2f {
  return (p - ADVECT_FIELD_DRIFT * drift) * ADVECT_FIELD_SCALE;
}

fn advect_scroll(p: vec2f, drift: vec2f, t: f32, octaves: i32) -> f32 {
  let q = vec3f(p - drift, t + _ADVECT_SCROLL_PLANE);
  let n = fbm_3d(q, octaves, ADVECT_LACUNARITY, ADVECT_GAIN);
  return clamp(_ADVECT_SCROLL_GAIN * n, -1.0, 1.0);
}

fn advect_warp_pos(p: vec2f, drift: vec2f, t: f32, strength: f32) -> vec2f {
  let q = _advect_field_pos(p, drift);
  let offset =
    domain_warp_2d_anim(q, t, 1.0, ADVECT_FIELD_OCTAVES, ADVECT_LACUNARITY, ADVECT_GAIN) - q;
  return p - drift + (strength * _ADVECT_WARP_NORM) * offset;
}

fn advect_warp(p: vec2f, drift: vec2f, t: f32, strength: f32, octaves: i32) -> f32 {
  return fbm_2d(advect_warp_pos(p, drift, t, strength), octaves, ADVECT_LACUNARITY, ADVECT_GAIN);
}

// Unit-RMS divergence-free velocity at p.
fn _advect_curl_field(p: vec2f, drift: vec2f, t: f32) -> vec2f {
  return _ADVECT_CURL_NORM *
    curl_2d_anim(
      _advect_field_pos(p, drift),
      t,
      ADVECT_FIELD_OCTAVES,
      ADVECT_LACUNARITY,
      ADVECT_GAIN,
    );
}

fn advect_curl_pos(p: vec2f, drift: vec2f, t: f32, strength: f32) -> vec2f {
  // Backwards along the field: the pattern appears to have moved forwards along it.
  return p - drift - strength * _advect_curl_field(p, drift, t);
}

fn advect_curl(p: vec2f, drift: vec2f, t: f32, strength: f32, octaves: i32) -> f32 {
  return fbm_2d(advect_curl_pos(p, drift, t, strength), octaves, ADVECT_LACUNARITY, ADVECT_GAIN);
}

fn _advect_fade(f: vec2f) -> vec2f {
  return f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
}

fn _advect_fade_d(f: vec2f) -> vec2f {
  let a = f * (1.0 - f);
  return 30.0 * a * a;
}

// The gradient of lattice point c after the field has turned by `angle`.
fn _advect_gradient(c: vec2i, angle: f32) -> vec2f {
  let h = pcg_2d(bitcast<vec2u>(c));
  // Sum of two uniform values: a triangular distribution of rates over +-_ADVECT_SPIN_SPREAD.
  let rate = (f32(h.y >> 16u) + f32(h.y & 0xffffu)) / 65536.0 - 1.0;
  let a = TAU * to_unorm_1d(h.x) + angle * (_ADVECT_SPIN_SPREAD * rate);
  return vec2f(cos(a), sin(a));
}

fn advect_rotnoise_2d_d(p: vec2f, angle: f32) -> vec3f {
  let ip = floor(p);
  let f = p - ip;
  let c = vec2i(ip);
  let u = _advect_fade(f);
  let du = _advect_fade_d(f);
  let ga = _advect_gradient(c, angle);
  let gb = _advect_gradient(c + vec2i(1, 0), angle);
  let gc = _advect_gradient(c + vec2i(0, 1), angle);
  let gd = _advect_gradient(c + vec2i(1, 1), angle);
  let va = dot(ga, f);
  let vb = dot(gb, f - vec2f(1.0, 0.0));
  let vc = dot(gc, f - vec2f(0.0, 1.0));
  let vd = dot(gd, f - vec2f(1.0, 1.0));
  let k = va - vb - vc + vd;
  let value = va + (vb - va) * u.x + (vc - va) * u.y + k * u.x * u.y;
  // Gradient = blend of the corner gradients + the change of the blend weights.
  let g = mix(mix(ga, gb, u.x), mix(gc, gd, u.x), u.y);
  let d = g + du * vec2f((vb - va) + k * u.y, (vc - va) + k * u.x);
  return _ADVECT_ROTNOISE_SCALE * vec3f(value, d);
}

fn advect_rotnoise_2d(p: vec2f, angle: f32) -> f32 {
  return advect_rotnoise_2d_d(p, angle).x;
}

fn advect_flownoise(p: vec2f, drift: vec2f, t: f32, advection: f32, octaves: i32) -> f32 {
  let n = clamp(octaves, 0, FBM_MAX_OCTAVES);
  // Same per-octave transform as fbm_2d: q' = lacunarity * R q + shift.
  let turn = mat2x2f(0.8, 0.6, -0.6, 0.8);
  var q = p - drift;
  var rot = mat2x2f(1.0, 0.0, 0.0, 1.0); // rotation of the current octave's lattice
  var freq = 1.0;
  var angle = t;
  var amp = 1.0;
  var sum = 0.0;
  var norm = 0.0;
  var slope = vec2f(0.0); // amplitude-weighted gradients of the octaves so far, in p's frame
  for (var i = 0; i < n; i++) {
    // Pseudo-advection: this octave is looked up `advection * slope` away (in p units).
    let d = advect_rotnoise_2d_d(q + (advection * freq) * (rot * slope), angle);
    sum += amp * d.x;
    slope += amp * (d.yz * rot);
    norm += amp;
    amp *= ADVECT_GAIN;
    q = ADVECT_LACUNARITY * (turn * q) + vec2f(1.37, 2.71);
    rot = turn * rot;
    freq *= ADVECT_LACUNARITY;
    angle *= ADVECT_SPIN_GAIN;
  }
  return sum / max(norm, 1e-6);
}

// A fresh, unrelated part of the pattern for cycle number `cycle_index` of layer `layer`.
fn _advect_layer_offset(cycle_index: f32, layer: f32) -> vec2f {
  return (hash_2to2(vec2f(cycle_index, layer)) - 0.5) * _ADVECT_LAYER_SPREAD;
}

fn advect_phases(
  p: vec2f,
  drift: vec2f,
  t: f32,
  flow: vec2f,
  cycle: f32,
  jitter: f32,
) -> AdvectPhases {
  let span = max(cycle, 1e-3);
  let phase = t / span + jitter * gnoise_2d(p * ADVECT_PHASE_SCALE + _ADVECT_PHASE_SEED);
  let cycle_a = floor(phase);
  let age_a = phase - cycle_a; // 0..1 through the life of layer a
  let cycle_b = floor(phase + 0.5);
  let age_b = phase + 0.5 - cycle_b;
  // The displacement is centred on mid-life, where the layer is at full weight, so the layer is
  // undistorted when it is most visible and never further than half a cycle from that.
  let base = p - drift;
  var ph: AdvectPhases;
  ph.pos_a = base - flow * ((age_a - 0.5) * span) + _advect_layer_offset(cycle_a, 1.0);
  ph.pos_b = base - flow * ((age_b - 0.5) * span) + _advect_layer_offset(cycle_b, 2.0);
  // Triangle weights: a is at zero weight when it resets (age_a = 0), b when age_a = 0.5.
  ph.mix_b = abs(2.0 * age_a - 1.0);
  return ph;
}

fn advect_phase_mix(a: f32, b: f32, ph: AdvectPhases) -> f32 {
  let w = ph.mix_b;
  return mix(a, b, w) * inverseSqrt(w * w + (1.0 - w) * (1.0 - w));
}

fn advect_flowmap(p: vec2f, drift: vec2f, t: f32, flow: vec2f, cycle: f32, octaves: i32) -> f32 {
  let ph = advect_phases(p, drift, t, flow, cycle, ADVECT_PHASE_JITTER);
  let a = fbm_2d(ph.pos_a, octaves, ADVECT_LACUNARITY, ADVECT_GAIN);
  let b = fbm_2d(ph.pos_b, octaves, ADVECT_LACUNARITY, ADVECT_GAIN);
  return clamp(advect_phase_mix(a, b, ph), -1.0, 1.0);
}

fn advect_twophase(
  p: vec2f,
  drift: vec2f,
  t: f32,
  strength: f32,
  cycle: f32,
  octaves: i32,
) -> f32 {
  let flow = strength * _advect_curl_field(p, drift, t * ADVECT_FLOW_EVOLVE);
  return advect_flowmap(p, drift, t, flow, cycle, octaves);
}
