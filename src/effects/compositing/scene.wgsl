// The compositing study's test scene: a flame (emission only, no coverage), smoke above it
// (premultiplied colour with real coverage in alpha) and two charred logs (opaque). It writes
// LINEAR premultiplied radiance + coverage into the HDR scene target and leaves everything else
// (0, 0, 0, 0), so each alpha mode of the output pass has something different to work with.
#include "fullscreen.wgsl"
#include "fbm.wgsl"
#include "sdf.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

// Heat 0..1 -> linear HDR colour (multiply by intensity). A local stand-in for the shared ramps:
// a saturated orange body that rises with heat^1.6 and a pale core that only the hottest 30% reach.
fn comp_fire_color(heat: f32) -> vec3f {
  let body = vec3f(1.0, 0.26, 0.035) * pow(heat, 1.6);
  let core = vec3f(1.0, 0.78, 0.42) * pow(heat, 6.0) * 2.0;
  return body + core;
}

// Flame heat at q: x across (0 on the axis), y up the flame (0 base, 1 tip), both in flame heights.
fn comp_flame(q: vec2f, t: f32) -> f32 {
  let h = q.y;
  if (h < -0.08 || h > 1.25 || abs(q.x) > 0.6) { return 0.0; }
  // The whole tongue leans slowly, and wobbles faster the higher up it is.
  let sway = fbm_2d(vec2f(h * 1.4 - t * 0.8, t * 0.3), 2, 2.0, 0.5) * 0.16 * h;
  let wobble = fbm_3d(vec3f(q.x * 3.0, h * 2.6 - t * 1.9, t * 0.5), 3, 2.0, 0.5);
  let x = q.x - sway + wobble * 0.11 * smoothstep(0.0, 0.7, h);
  // Teardrop: widest just above the base, tapering to a point.
  let width = 0.3 * pow(clamp(1.0 - h, 0.0, 1.0), 0.75) * smoothstep(-0.08, 0.16, h);
  let body = 1.0 - abs(x) / max(width, 1e-3);
  // Rising noise eats the edge, more with height, which is what makes separate licks at the tip.
  let n = 0.5 + 0.5 * fbm_3d(vec3f(x * 5.0, h * 3.0 - t * 2.7, t * 0.6), 4, 2.0, 0.55);
  return clamp(body * 1.15 - (1.0 - n) * (0.35 + 1.3 * h), 0.0, 1.0);
}

// Smoke coverage 0..1 at q (same units as the flame).
fn comp_smoke(q: vec2f, t: f32) -> f32 {
  let rise = q.y - 0.55;
  if (rise < 0.0) { return 0.0; }
  let drift = fbm_2d(vec2f(q.y * 0.9 - t * 0.35, 3.7), 2, 2.0, 0.5) * 0.22 * rise;
  let x = q.x - drift;
  let spread = 0.09 + 0.3 * rise;
  let plume = exp(-x * x / (spread * spread)) * smoothstep(0.0, 0.45, rise);
  let n = 0.5 + 0.5 * fbm_3d(vec3f(x * 2.6, q.y * 1.7 - t * 0.75, t * 0.14), 4, 2.0, 0.55);
  return clamp(plume * smoothstep(0.3, 0.72, n) * 1.25, 0.0, 1.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // y up, one unit = the canvas height; a narrow canvas zooms out so the flame still fits.
  let fit = min(1.0, params.aspect / 0.75);
  let p = vec2f((in.uv.x - 0.5) * params.aspect, 1.0 - in.uv.y) / fit;
  let base = 0.17;
  let q = vec2f(p.x, p.y - base) / params.height;
  let t = params.time;

  // Smoke: dark soot, lit warm from below by the flame. Premultiplied, with its coverage in alpha.
  // It fades out before the top edge so the canvas rectangle never shows.
  let edge = smoothstep(0.0, 0.16, in.uv.y) * smoothstep(0.0, 0.08, 0.5 - abs(in.uv.x - 0.5));
  let cover = comp_smoke(q, t) * params.smoke * 0.85 * edge;
  let underlight = vec3f(1.0, 0.32, 0.06) * exp(-max(q.y - 0.7, 0.0) * 3.2) * 0.35 * params.intensity / 8.0;
  let soot = vec3f(0.035, 0.032, 0.03) + underlight;
  var out = vec4f(soot * cover, cover);

  // Flame: emission only. It adds light and covers nothing.
  let heat = comp_flame(q, t);
  out = vec4f(out.rgb + comp_fire_color(heat) * params.intensity, out.a);

  // Logs: opaque char with ember cracks, in front of the flame's base.
  let aa = params.pixel / (fit * params.height);
  let la = sd_capsule_2d(q, vec2f(-0.3, -0.105), vec2f(0.29, -0.03), 0.05);
  let lb = sd_capsule_2d(q, vec2f(-0.27, -0.02), vec2f(0.31, -0.115), 0.046);
  let d = min(la, lb);
  let wood = sd_coverage(d, aa) * params.logs;
  if (wood > 0.0) {
    let cracks = ridged_2d(q * vec2f(5.0, 13.0), 3, 2.0, 0.5);
    let breathe = 0.75 + 0.25 * fbm_2d(vec2f(q.x * 4.0, t * 0.6), 2, 2.0, 0.5);
    let near_fire = exp(-q.x * q.x / 0.03) * smoothstep(-0.16, -0.02, q.y);
    let glow = pow(cracks, 9.0) * near_fire * breathe;
    let char_color = vec3f(0.012, 0.009, 0.008) * (0.6 + 0.8 * cracks);
    let ember = vec3f(1.0, 0.22, 0.025) * glow * 0.7 * params.intensity;
    out = mix(out, vec4f(char_color + ember, 1.0), wood);
  }
  return out;
}
