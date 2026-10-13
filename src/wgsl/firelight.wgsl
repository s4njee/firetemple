// firelight.wgsl -- fire as a light source on a 2D page: falloff, point / disc / line lights that
// hover above the page, shadows cast by rounded-rectangle occluders, and normal-mapped receivers.
//
// CONVENTIONS
//  * "Page space" is any 2D space with square units; the site uses canvas uv scaled by the aspect
//    ratio, p = uv * vec2f(aspect, 1): top-left origin, y down, 1.0 = the image height. Every
//    length here (radius, height, light size, occluder size) is in those units.
//  * A light sits at a 2D position and hovers `height` above the page. Light directions are 3D,
//    (page x, page y, up): feed them normals in the same frame, which is what firelight_normal
//    builds from a height gradient taken in page space. A flat surface has normal (0, 0, 1).
//  * Colour and intensity are the caller's: every function returns a scalar factor (or a unit-max
//    tint). radiance = albedo * tint * intensity * sample.atten * firelight_diffuse(n, sample.dir)
//    * shadow. With that, `intensity` is the irradiance directly under a point light, in the scene's
//    units (1.0 = paper white).
//
// FALLOFF (windowed inverse square, after Karis 2013)
//   firelight_window(d, radius) -> f32            saturate(1 - (d/radius)^4)^2: 1 at d = 0, EXACTLY 0
//                                                 at d >= radius, C1 at the rim. Leaves the inverse
//                                                 square alone until about 0.6 radius (0.76 there).
//   firelight_falloff(d, radius, core) -> f32     window * core^2 / (d^2 + core^2). In [0, 1], 1 at
//                                                 d = 0 (finite), strictly decreasing, 0.5 * window at
//                                                 d = core, core^2 / d^2 (inverse square) for
//                                                 core << d << radius. `core` is the size of the hot
//                                                 spot: for a hovering light it is the light's height.
//                                                 `radius` is where the light ends; cull by it.
//
// LIGHTS: each returns
//   struct FirelightSample {
//     dir: vec3f,     unit vector from the receiver towards the light (page x, page y, up)
//     atten: f32,     falloff in [0, 1] (NOT including N.L or shadow)
//     pos: vec2f,     the 2D point of the light to aim a shadow ray at
//     spread: f32,    lateral half-extent of the source seen from the receiver, page units; add it
//                     to the light radius passed to the shadow functions
//   }
//   firelight_point(p, light_pos, height, radius) -> FirelightSample
//        atten = firelight_falloff(|p - light_pos|, radius, height). Under the light a flat
//        receiver gets atten * N.L = 1; in general height^3 / (d^2 + height^2)^1.5 * window.
//   firelight_disc(p, light_pos, disc_radius, height, radius) -> FirelightSample
//        A horizontal disc of radius a: the point light with core^2 = height^2 + a^2 / 2, same
//        far field (same power), a wider and dimmer hot spot. Matches the exact average over the
//        disc under its centre to 4% for a <= height, 17% low at a = 2 height. spread = a.
//   firelight_line(p, a, b, height, radius) -> FirelightSample
//        A segment a..b of point lights: atten is the EXACT average of the point kernel along the
//        segment (one atan2), so brightness does not grow with length. dir and pos use the point
//        that bisects the angle the segment subtends (representative point; no trig). The window
//        is taken on the distance to the nearest point of the segment, so the footprint is a
//        capsule. Converges to firelight_point as |b - a| -> 0. spread = half the segment's extent
//        across the line of sight.
//
// RECEIVERS
//   firelight_normal(gradient: vec2f, strength) -> vec3f   unit normal of a height field from its
//        page-space gradient (dh/dx, dh/dy): normalize(-gradient * strength, 1). Zero gradient or
//        zero strength gives (0, 0, 1).
//   firelight_diffuse(n, light_dir) -> f32        max(N.L, 0)
//   firelight_sheen(n, light_dir, gloss) -> f32   Blinn-Phong lobe for a viewer looking straight
//        down the page (view = +z), times N.L; in [0, 1]. gloss 8 is waxy, 64 is wet stone.
//   firelight_tint(warmth) -> vec3f               art-directable light colour, linear RGB, max
//        channel 1: 0 = deep ember red-orange (1, 0.18, 0.03), 0.5 = candle orange (1, 0.52, 0.16),
//        1 = pale flame yellow-white (1, 0.86, 0.62). Piecewise linear; not a physical curve.
//        Luminance rises from 0.34 to 0.87 with warmth: raise intensity for low warmth.
//
// OCCLUDERS: rounded rectangles, at most FIRELIGHT_MAX_OCCLUDERS (8)
//   struct FirelightOccluders {
//     count: i32,
//     rects: array<vec4f, 8>,     (centre.xy, half_size.xy) in page space
//     corners: array<vec4f, 8>,   .x = corner radius (clamped to fit); .yzw unused, keep 0
//   }
//   A chunk cannot own a binding, so the effect keeps the two arrays in its own uniform block,
//   copies them once per fragment into a function-scope `var occ = FirelightOccluders(n, u.rects,
//   u.corners);` and passes `&occ`. From an `ObstacleRect` of src/gpu/dom-rects.ts (canvas uv,
//   radius in image heights): rect = ((x + width / 2) * aspect, y + height / 2, width / 2 * aspect,
//   height / 2), corner = radius.
//   firelight_sd_occluders(p, occ, exclude) -> f32   signed distance to the union (negative
//        inside); 1e6 when there is nothing. `exclude` is an index to leave out (-1: none), for a
//        receiver that sits on an occluder. `count` SDF evaluations.
//   firelight_occluder_at(p, occ) -> i32          index of the first occluder containing p, or -1
//
// SHADOWS: all return visibility in [0, 1] (1 = lit) for a receiver p and a light at light_pos
// with radius light_radius (the size of the SOURCE, not its reach). All take
//   reach: vec2f   how much of the way to the light an occluder can block, as fractions of the
//        receiver-light distance: fully blocking nearer than reach.x, fading to nothing at
//        reach.y. FIRELIGHT_WALLS = (1, 1) is the classic 2D case, occluders are infinitely tall
//        and shadows run to the light's rim. Finite occluders give shadows that end:
//   firelight_reach(occluder_height, light_height, light_radius) -> vec2f   the reach of an
//        occluder of that height under a light at that height: (e / (h + R), e / (h - R)), each
//        capped at 1. The shadow of an edge at distance g from the light is about g * e / (h - e)
//        long and its tip is soft because the source is R tall.
//   firelight_shadow_hard(p, light_pos, reach, occ, exclude) -> f32
//        0 or 1. Exact segment-versus-rounded-box test (slab test plus corner distances); the
//        segment ends at the harmonic mean of the reach. No loop over distance. ~100 ALU ops per
//        occluder.
//   firelight_shadow_soft(p, light_pos, light_radius, reach, occ, exclude) -> f32
//        ANALYTIC penumbra, the recommended default. Each occluder is projected onto the light as
//        seen from the receiver (its box clipped to the reach, corners inflated by the corner
//        radius) and the covered part of the source is taken in closed form. No marching, no
//        banding, no leaks; exact for one occluder and a source with a smoothstep profile, the
//        product of the per-occluder terms where penumbrae overlap. Half lit exactly on the
//        geometric shadow edge; the 10%-90% width at a receiver t behind an edge that is g from
//        the light is 1.22 * R * t / g (measured to 0.5%). ~40 ALU ops for an occluder the light
//        cone misses, ~150 for one it touches (4 edges clipped, 8 divisions); one SDF evaluation
//        per occluder, no trace steps.
//   firelight_shadow_trace(p, light_pos, light_radius, reach, occ, exclude) -> f32
//        Sphere-traced penumbra for comparison and for scenes that are not boxes: FIRELIGHT_TRACE_STEPS
//        (32) steps, each one firelight_sd_occluders, i.e. up to 32 * count box SDFs per pixel per
//        light. Signed distances give the inner half of the penumbra as well as the outer, and the
//        closest approach between two samples is estimated from their two distance circles
//        (Aaltonen's improvement). Against _soft, for one card: penumbra 4-8% wider, mean error
//        inside the penumbra 0.014 (R = 0.08) to 0.05 (R = 0.01), worst 0.04 to 0.27, seen as
//        faint stripes across the penumbra. 64 steps bring that to 0.012 mean, 0.07 worst.
//   firelight_shadow_trace_classic(p, light_pos, light_radius, reach, occ, exclude) -> f32
//        Quilez's original min(k * h / t): outer penumbra only, so the umbra is the whole
//        geometric shadow, the penumbra is half as wide (0.53x measured) and the shadow reads
//        fatter and harder. Monotonic, no stripes. Same cost as _trace. For reference.
//   firelight_shadow(mode, p, light_pos, light_radius, reach, occ, exclude) -> f32
//        dispatch on FIRELIGHT_SHADOW_NONE (0, returns 1), _HARD (1), _SOFT (2), _TRACE (3),
//        _TRACE_CLASSIC (4).
//   Per-step maths, for an effect that marches its own SDF (glyphs, circles, a distance texture):
//   firelight_penumbra(h, t, dist, light_radius) -> f32   the cone test for one sample: h is the
//        signed distance at t along the ray to a light `dist` away; clamp(h * dist / (R * t), -1, 1).
//        Take the minimum over the march.
//   firelight_penumbra_resolve(res) -> f32        that minimum (-1..1) to visibility 0..1: smoothstep
//        of 0.5 + 0.5 * res, so 0 (a ray that grazes the edge) is half lit.
//
// A receiver inside an occluder that is not excluded is fully shadowed by every method. Occluders
// are expected not to overlap by much (the union's inside distance is then approximate).
//
// Technique: falloff from B. Karis, "Real Shading in Unreal Engine 4" (2013); sphere-traced
// penumbra from I. Quilez, "soft shadows in raymarched SDFs" (2010, improved 2018 after
// S. Aaltonen); the analytic penumbra is the clipped-polygon projection derived for this library.

#include "sdf.wgsl"

const FIRELIGHT_MAX_OCCLUDERS: i32 = 8;
const FIRELIGHT_TRACE_STEPS: i32 = 32;

const FIRELIGHT_SHADOW_NONE: i32 = 0;
const FIRELIGHT_SHADOW_HARD: i32 = 1;
const FIRELIGHT_SHADOW_SOFT: i32 = 2;
const FIRELIGHT_SHADOW_TRACE: i32 = 3;
const FIRELIGHT_SHADOW_TRACE_CLASSIC: i32 = 4;

/// Occluders are walls: they block all the way to the light.
const FIRELIGHT_WALLS: vec2f = vec2f(1.0, 1.0);

const _FIRELIGHT_FAR: f32 = 1e6;
const _FIRELIGHT_TINY: f32 = 1e-6;

struct FirelightSample {
  dir: vec3f,
  atten: f32,
  pos: vec2f,
  spread: f32,
}

struct FirelightOccluders {
  count: i32,
  rects: array<vec4f, FIRELIGHT_MAX_OCCLUDERS>,
  corners: array<vec4f, FIRELIGHT_MAX_OCCLUDERS>,
}

// ---- Falloff ------------------------------------------------------------------------------------

fn firelight_window(d: f32, radius: f32) -> f32 {
  let x = d / max(radius, _FIRELIGHT_TINY);
  let x2 = x * x;
  let w = clamp(1.0 - x2 * x2, 0.0, 1.0);
  // The comparison makes the rim exact even where the division is compiled to a reciprocal.
  return select(w * w, 0.0, d >= radius);
}

fn firelight_falloff(d: f32, radius: f32, core: f32) -> f32 {
  let c2 = max(core * core, 1e-10);
  return firelight_window(d, radius) * c2 / (d * d + c2);
}

// ---- Lights -------------------------------------------------------------------------------------

fn firelight_point(p: vec2f, light_pos: vec2f, height: f32, radius: f32) -> FirelightSample {
  let v = light_pos - p;
  let h = max(height, 1e-4);
  let d2 = dot(v, v);
  let dir = vec3f(v, h) * inverseSqrt(d2 + h * h);
  return FirelightSample(dir, firelight_falloff(sqrt(d2), radius, h), light_pos, 0.0);
}

fn firelight_disc(
  p: vec2f,
  light_pos: vec2f,
  disc_radius: f32,
  height: f32,
  radius: f32,
) -> FirelightSample {
  let v = light_pos - p;
  let h = max(height, 1e-4);
  let d2 = dot(v, v);
  let dir = vec3f(v, h) * inverseSqrt(d2 + h * h);
  // Same far field as the point light; the hot spot spreads over the disc.
  let atten = firelight_window(sqrt(d2), radius) * h * h
    / (d2 + h * h + 0.5 * disc_radius * disc_radius);
  return FirelightSample(dir, atten, light_pos, max(disc_radius, 0.0));
}

fn firelight_line(p: vec2f, a: vec2f, b: vec2f, height: f32, radius: f32) -> FirelightSample {
  let ab = b - a;
  let len = length(ab);
  if (len < 1e-5) {
    return firelight_point(p, 0.5 * (a + b), height, radius);
  }
  let u = ab / len;
  let rel = p - a;
  let x = dot(rel, u);
  let y = rel.x * u.y - rel.y * u.x;
  let h = max(height, 1e-4);
  // q: 3D distance from the receiver to the line the segment lies on. s0, s1: the segment's ends
  // measured along that line from the receiver's foot point.
  let q = sqrt(y * y + h * h);
  let s0 = -x;
  let s1 = len - x;
  // Mean of h^2 / (s^2 + q^2) over s0..s1 = h^2 * (atan(s1/q) - atan(s0/q)) / (q * len); the
  // difference of the two angles is in (0, pi), which this atan2 returns without cancellation.
  let angle = atan2(len * q, q * q + s0 * s1);
  let kernel = h * h * angle / (q * len);
  // The bisector of that angle meets the segment where it is divided as r0 : r1.
  let r0 = sqrt(s0 * s0 + q * q);
  let r1 = sqrt(s1 * s1 + q * q);
  let pos = a + u * (len * r0 / (r0 + r1));
  let nearest = a + u * clamp(x, 0.0, len);
  let v = pos - p;
  let d2 = dot(v, v);
  let dir = vec3f(v, h) * inverseSqrt(d2 + h * h);
  // Half the segment's extent across the line of sight; the whole half length when p is on it.
  let across = abs(u.x * v.y - u.y * v.x) * inverseSqrt(max(d2, 1e-12));
  let spread = 0.5 * len * select(across, 1.0, d2 < 1e-12);
  return FirelightSample(dir, firelight_window(distance(p, nearest), radius) * kernel, pos, spread);
}

// ---- Receivers ----------------------------------------------------------------------------------

fn firelight_normal(gradient: vec2f, strength: f32) -> vec3f {
  return normalize(vec3f(-gradient * strength, 1.0));
}

fn firelight_diffuse(n: vec3f, light_dir: vec3f) -> f32 {
  return max(dot(n, light_dir), 0.0);
}

fn firelight_sheen(n: vec3f, light_dir: vec3f, gloss: f32) -> f32 {
  let half_vector = normalize(light_dir + vec3f(0.0, 0.0, 1.0));
  let lobe = pow(max(dot(n, half_vector), 0.0), max(gloss, 1.0));
  return lobe * max(dot(n, light_dir), 0.0);
}

fn firelight_tint(warmth: f32) -> vec3f {
  let w = clamp(warmth, 0.0, 1.0);
  let ember = vec3f(1.0, 0.18, 0.03);
  let candle = vec3f(1.0, 0.52, 0.16);
  let pale = vec3f(1.0, 0.86, 0.62);
  return select(mix(candle, pale, w * 2.0 - 1.0), mix(ember, candle, w * 2.0), w < 0.5);
}

// ---- Occluders ----------------------------------------------------------------------------------

fn firelight_sd_occluders(p: vec2f, occ: ptr<function, FirelightOccluders>, exclude: i32) -> f32 {
  var d = _FIRELIGHT_FAR;
  let count = min((*occ).count, FIRELIGHT_MAX_OCCLUDERS);
  for (var i = 0; i < count; i++) {
    if (i == exclude) {
      continue;
    }
    let rect = (*occ).rects[i];
    d = min(d, sd_rounded_box_2d(p - rect.xy, rect.zw, (*occ).corners[i].x));
  }
  return d;
}

fn firelight_occluder_at(p: vec2f, occ: ptr<function, FirelightOccluders>) -> i32 {
  let count = min((*occ).count, FIRELIGHT_MAX_OCCLUDERS);
  for (var i = 0; i < count; i++) {
    let rect = (*occ).rects[i];
    if (sd_rounded_box_2d(p - rect.xy, rect.zw, (*occ).corners[i].x) < 0.0) {
      return i;
    }
  }
  return -1;
}

// ---- Shadows ------------------------------------------------------------------------------------

fn firelight_reach(occluder_height: f32, light_height: f32, light_radius: f32) -> vec2f {
  let e = max(occluder_height, 0.0);
  let top = light_height - light_radius;
  let lo = min(e / max(light_height + light_radius, _FIRELIGHT_TINY), 1.0);
  let hi = min(e / max(top, _FIRELIGHT_TINY), 1.0);
  return vec2f(lo, max(lo, hi));
}

// How much an occluder first met at `tn` (a fraction of the way to the light) blocks: 1 up to
// reach.x, 0 from reach.y on.
fn _firelight_tip(tn: f32, reach: vec2f) -> f32 {
  let x = clamp((tn - reach.x) / max(reach.y - reach.x, 1e-5), 0.0, 1.0);
  return 1.0 - x * x * (3.0 - 2.0 * x);
}

fn firelight_penumbra(h: f32, t: f32, dist: f32, light_radius: f32) -> f32 {
  // The source seen from the receiver is a cone of radius R * t / dist at depth t.
  return clamp(h * dist / (max(light_radius, _FIRELIGHT_TINY) * max(t, _FIRELIGHT_TINY)), -1.0, 1.0);
}

fn firelight_penumbra_resolve(res: f32) -> f32 {
  let x = clamp(0.5 + 0.5 * res, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// True when the segment p..q touches the rounded box.
fn _firelight_segment_blocked(p: vec2f, q: vec2f, rect: vec4f, corner: f32) -> bool {
  let r = clamp(corner, 0.0, min(rect.z, rect.w));
  let b = rect.zw - vec2f(r);
  let a0 = p - rect.xy;
  let a1 = q - rect.xy;
  // Slab test against the inner box (the box the corner circles are centred on).
  let d = a1 - a0;
  let safe = select(d, vec2f(1e-12), abs(d) < vec2f(1e-12));
  let ta = (-b - a0) / safe;
  let tb = (b - a0) / safe;
  let t_near = max(min(ta.x, tb.x), min(ta.y, tb.y));
  let t_far = min(max(ta.x, tb.x), max(ta.y, tb.y));
  if (t_near <= t_far && t_far >= 0.0 && t_near <= 1.0) {
    return true;
  }
  // Otherwise the segment and the inner box are apart: the gap is at an end of the segment or at
  // a corner of the box, and the rounded box is hit when the gap is under the corner radius.
  var gap = min(sd_box_2d(a0, b), sd_box_2d(a1, b));
  gap = min(gap, sd_segment_2d(b, a0, a1));
  gap = min(gap, sd_segment_2d(-b, a0, a1));
  gap = min(gap, sd_segment_2d(vec2f(b.x, -b.y), a0, a1));
  gap = min(gap, sd_segment_2d(vec2f(-b.x, b.y), a0, a1));
  return gap < r;
}

fn firelight_shadow_hard(
  p: vec2f,
  light_pos: vec2f,
  reach: vec2f,
  occ: ptr<function, FirelightOccluders>,
  exclude: i32,
) -> f32 {
  // The cut of a point source at the light's height: e / h, the harmonic mean of the two reaches.
  let cut = 2.0 * reach.x * reach.y / max(reach.x + reach.y, _FIRELIGHT_TINY);
  let q = p + (light_pos - p) * cut;
  let count = min((*occ).count, FIRELIGHT_MAX_OCCLUDERS);
  for (var i = 0; i < count; i++) {
    if (i == exclude) {
      continue;
    }
    if (_firelight_segment_blocked(p, q, (*occ).rects[i], (*occ).corners[i].x)) {
      return 0.0;
    }
  }
  return 1.0;
}

// Smooth step across the source: how much of it lies at tangent-of-angle below w, when it spans
// -wl..wl. Its derivative is the source's brightness profile, 6x(1-x): a soft-edged disc.
fn _firelight_source_below(w: f32, wl: f32) -> f32 {
  let x = clamp(0.5 + 0.5 * w / wl, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// The fraction of the source that one rounded box hides from a receiver outside it.
// Works in the ray frame: t along the ray to the light, l across it. A point (t, l) hides the
// light directions w = l / t, and the source spans |w| <= wl = R / dist, so the box hides the
// interval of w its part in front of the light (0 < t < reach) spans, widened by the corner radius.
fn _firelight_cover(
  p: vec2f,
  dir: vec2f,
  dist: f32,
  wl: f32,
  reach: vec2f,
  rect: vec4f,
  corner: f32,
) -> f32 {
  let r = clamp(corner, 0.0, min(rect.z, rect.w));
  let rel = rect.xy - p;
  if (sd_rounded_box_2d(-rel, rect.zw, r) < 0.0) {
    return 1.0;
  }
  let b = rect.zw - vec2f(r);
  let across = vec2f(-dir.y, dir.x);
  let centre = vec2f(dot(rel, dir), dot(rel, across));
  let ex = vec2f(dir.x, across.x) * b.x;
  let ey = vec2f(dir.y, across.y) * b.y;
  let t_lo = 1e-4 * dist;
  let t_hi = reach.y * dist;

  // Cull: behind the receiver, beyond the reach, or wholly outside the cone to the source.
  let ext_t = abs(ex.x) + abs(ey.x);
  let ext_l = abs(ex.y) + abs(ey.y);
  if (centre.x + ext_t < t_lo || centre.x - ext_t > t_hi) {
    return 0.0;
  }
  if (abs(centre.y) - ext_l - r > wl * min(centre.x + ext_t, t_hi)) {
    return 0.0;
  }

  var corners = array<vec2f, 4>(
    centre - ex - ey,
    centre + ex - ey,
    centre + ex + ey,
    centre - ex + ey,
  );
  var lo = _FIRELIGHT_FAR;
  var hi = -_FIRELIGHT_FAR;
  var nearest = _FIRELIGHT_FAR;
  for (var i = 0; i < 4; i++) {
    let v0 = corners[i];
    let v1 = corners[(i + 1) & 3];
    if (max(v0.x, v1.x) < t_lo || min(v0.x, v1.x) > t_hi) {
      continue;
    }
    // The part of this edge inside t_lo..t_hi. Every vertex of the clipped box is the end of one.
    let dt = v1.x - v0.x;
    let level = abs(dt) < 1e-9;
    let inv = 1.0 / select(dt, 1.0, level);
    let s0 = select(clamp((t_lo - v0.x) * inv, 0.0, 1.0), 0.0, level);
    let s1 = select(clamp((t_hi - v0.x) * inv, 0.0, 1.0), 1.0, level);
    let e0 = mix(v0, v1, s0);
    let e1 = mix(v0, v1, s1);
    let i0 = 1.0 / max(e0.x, t_lo);
    let i1 = 1.0 / max(e1.x, t_lo);
    lo = min(lo, min((e0.y - r) * i0, (e1.y - r) * i1));
    hi = max(hi, max((e0.y + r) * i0, (e1.y + r) * i1));
    nearest = min(nearest, min(e0.x, e1.x));
  }
  if (lo > hi) {
    return 0.0;
  }
  let hidden = _firelight_source_below(hi, wl) - _firelight_source_below(lo, wl);
  return hidden * _firelight_tip(max(nearest - r, 0.0) / dist, reach);
}

fn firelight_shadow_soft(
  p: vec2f,
  light_pos: vec2f,
  light_radius: f32,
  reach: vec2f,
  occ: ptr<function, FirelightOccluders>,
  exclude: i32,
) -> f32 {
  let v = light_pos - p;
  let dist = max(length(v), _FIRELIGHT_TINY);
  let dir = v / dist;
  let wl = max(light_radius, _FIRELIGHT_TINY) / dist;
  var lit = 1.0;
  let count = min((*occ).count, FIRELIGHT_MAX_OCCLUDERS);
  for (var i = 0; i < count; i++) {
    if (i == exclude) {
      continue;
    }
    lit *= 1.0 - _firelight_cover(p, dir, dist, wl, reach, (*occ).rects[i], (*occ).corners[i].x);
  }
  return clamp(lit, 0.0, 1.0);
}

fn firelight_shadow_trace(
  p: vec2f,
  light_pos: vec2f,
  light_radius: f32,
  reach: vec2f,
  occ: ptr<function, FirelightOccluders>,
  exclude: i32,
) -> f32 {
  let v = light_pos - p;
  let dist = max(length(v), _FIRELIGHT_TINY);
  let dir = v / dist;
  let t_end = dist * reach.y;
  var res = 1.0;
  var t = 0.0;
  var prev_h = -1.0;
  var prev_t = 0.0;
  for (var i = 0; i < FIRELIGHT_TRACE_STEPS; i++) {
    let h = firelight_sd_occluders(p + dir * t, occ, exclude);
    // Never step less than an even share of what is left, so the march always arrives: a ray
    // cannot run out of steps short of the light (which is what leaks light past a long edge),
    // and the steps saved crossing open ground are spent near the occluders.
    let min_step = (t_end - t) / f32(FIRELIGHT_TRACE_STEPS - i);
    var clear = h;
    var at = t;
    if (h > 0.0 && prev_h > 0.0) {
      // Both samples are outside. The surface cannot be inside either sample's distance circle,
      // so the nearest it can be to the ray between them is where the two circles cross. Only
      // when the step was the sphere-tracing step itself: after a forced, longer step the
      // circles barely overlap and the estimate collapses towards 0 beside a flat edge, which
      // showed up as dark dips of up to 0.4 in the penumbra.
      let gone = t - prev_t;
      let y = (h * h - prev_h * prev_h + gone * gone) / (2.0 * gone);
      if (y > 0.0 && y < h && gone <= prev_h * 1.001) {
        clear = sqrt(h * h - y * y);
        at = t - y;
      }
    }
    let s = firelight_penumbra(clear, at, dist, light_radius);
    res = min(res, mix(1.0, s, _firelight_tip(at / dist, reach)));
    if (res <= -1.0) {
      break;
    }
    prev_h = h;
    prev_t = t;
    t += max(abs(h), min_step);
    if (t > t_end) {
      break;
    }
  }
  return firelight_penumbra_resolve(res);
}

fn firelight_shadow_trace_classic(
  p: vec2f,
  light_pos: vec2f,
  light_radius: f32,
  reach: vec2f,
  occ: ptr<function, FirelightOccluders>,
  exclude: i32,
) -> f32 {
  let v = light_pos - p;
  let dist = max(length(v), _FIRELIGHT_TINY);
  let dir = v / dist;
  let t_end = dist * reach.y;
  var res = 1.0;
  var t = 0.0;
  for (var i = 0; i < FIRELIGHT_TRACE_STEPS; i++) {
    let h = firelight_sd_occluders(p + dir * t, occ, exclude);
    let min_step = (t_end - t) / f32(FIRELIGHT_TRACE_STEPS - i);
    let s = max(firelight_penumbra(h, t, dist, light_radius), 0.0);
    res = min(res, mix(1.0, s, _firelight_tip(t / dist, reach)));
    if (res <= 0.0) {
      break;
    }
    t += max(h, min_step);
    if (t > t_end) {
      break;
    }
  }
  return res * res * (3.0 - 2.0 * res);
}

fn firelight_shadow(
  mode: i32,
  p: vec2f,
  light_pos: vec2f,
  light_radius: f32,
  reach: vec2f,
  occ: ptr<function, FirelightOccluders>,
  exclude: i32,
) -> f32 {
  switch mode {
    case FIRELIGHT_SHADOW_HARD: {
      return firelight_shadow_hard(p, light_pos, reach, occ, exclude);
    }
    case FIRELIGHT_SHADOW_SOFT: {
      return firelight_shadow_soft(p, light_pos, light_radius, reach, occ, exclude);
    }
    case FIRELIGHT_SHADOW_TRACE: {
      return firelight_shadow_trace(p, light_pos, light_radius, reach, occ, exclude);
    }
    case FIRELIGHT_SHADOW_TRACE_CLASSIC: {
      return firelight_shadow_trace_classic(p, light_pos, light_radius, reach, occ, exclude);
    }
    default: {
      return 1.0;
    }
  }
}
