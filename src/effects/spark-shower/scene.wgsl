// The spark shower's backdrop, drawn before the sparks (index.ts). Everything is in the overlay space
// the particles live in: canvas heights, origin bottom-left, y up.
//
//   - Stand-in cards and a floor, only when the canvas has no marked page elements around it (the bare
//     canvas, thumbnails, tests): dim slate plates with real coverage, so the sparks visibly land on
//     something. Over a page the elements themselves are the solids and nothing is drawn for them.
//   - The anvil of the forge preset (the same distance field as the 'sdf' collider in hooks.wgsl):
//     dark iron with real coverage, and the glowing bar on its face that the hammer strikes.

#include "fullscreen.wgsl"
#include "blackbody.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

fn sc_box(p: vec2f, half: vec2f) -> f32 {
  let d = abs(p) - half;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sc_rounded_box(p: vec2f, half: vec2f, radius: f32) -> f32 {
  let r = min(radius, min(half.x, half.y));
  return sc_box(p, half - vec2f(r)) - r;
}

fn sc_uneven_capsule(p_in: vec2f, a: vec2f, b_in: vec2f, ra: f32, rb: f32) -> f32 {
  let p = p_in - a;
  let b = b_in - a;
  let h = dot(b, b);
  var q = vec2f(dot(p, vec2f(b.y, -b.x)), dot(p, b)) / h;
  q.x = abs(q.x);
  let k = ra - rb;
  let c = vec2f(sqrt(h - k * k), k);
  let side = c.x * q.y - c.y * q.x;
  if (side < 0.0) {
    return sqrt(h * dot(q, q)) - ra;
  }
  if (side > c.x) {
    return sqrt(h * (dot(q, q) + 1.0 - 2.0 * q.y)) - rb;
  }
  return dot(c, q) - ra;
}

// Kept in step with shower_anvil in hooks.wgsl.
fn sc_anvil(q: vec2f) -> f32 {
  var d = sc_box(q - vec2f(0.0, -0.05), vec2f(0.2, 0.05));
  d = min(d, sc_box(q - vec2f(-0.01, -0.155), vec2f(0.08, 0.06)));
  d = min(d, sc_box(q - vec2f(-0.01, -0.24), vec2f(0.15, 0.028)));
  d = min(d, sc_uneven_capsule(q, vec2f(0.19, -0.035), vec2f(0.36, -0.004), 0.034, 0.006));
  return d;
}

fn sc_cover(d: f32, aa: f32) -> f32 {
  return clamp(0.5 - d / aa, 0.0, 1.0);
}

// Light over coverage, premultiplied.
fn sc_over(dst: vec4f, rgb: vec3f, a: f32) -> vec4f {
  return vec4f(rgb * a + dst.rgb * (1.0 - a), a + dst.a * (1.0 - a));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = vec2f(in.uv.x * params.aspect, 1.0 - in.uv.y);
  let aa = params.pixel * 1.5;
  var out = vec4f(0.0);

  if (params.stand_ins != 0u) {
    // The floor: a dark ground below FLOOR_Y with a faint top edge.
    let below = params.floor_y - p.y;
    let ground = sc_cover(-below, aa);
    let edge = exp(-abs(below) / (2.0 * params.pixel));
    out = sc_over(out, vec3f(0.006, 0.0058, 0.0055), 0.25 * ground);
    out = vec4f(out.rgb + vec3f(0.05, 0.045, 0.04) * edge, out.a);
    for (var i = 0u; i < params.count; i++) {
      let box = params.boxes[i];
      let d = sc_rounded_box(p - box.xy, box.zw, 0.012);
      let fill = sc_cover(d, aa);
      let rim = exp(-abs(d) / (1.2 * params.pixel)) * 0.025;
      out = sc_over(out, vec3f(0.012, 0.012, 0.014), 0.22 * fill);
      out = vec4f(out.rgb + vec3f(rim), out.a);
    }
  }

  let anvil = params.anvil;
  if (anvil.w > 0.0) {
    let q = (p - anvil.xy) / anvil.z;
    let d = sc_anvil(q) * anvil.z;
    let iron = sc_cover(d, aa);
    // The face catches the bar's glow: brighter towards the top and the middle.
    let lit = exp(-max(-q.y, 0.0) * 30.0) * exp(-abs(q.x - 0.02) * 8.0);
    let colour = vec3f(0.011, 0.0105, 0.01) + vec3f(0.5, 0.2, 0.06) * lit * 0.12 * anvil.w;
    out = sc_over(out, colour, 0.92 * iron);
    // The hot bar on the face, struck by the hammer: about 1300 K, steady.
    let bar = sc_rounded_box(q - vec2f(0.02, 0.018), vec2f(0.1, 0.018), 0.01) * anvil.z;
    let hot = sc_cover(bar, aa);
    // Hotter in the middle, where it was last struck.
    let heat = 1250.0 + 250.0 * exp(-abs(q.x - 0.02) * 14.0);
    let radiance = blackbody_radiance(heat, 1800.0, 0.4) * 5.0 * anvil.w;
    out = sc_over(out, radiance, hot);
  }

  return out;
}
