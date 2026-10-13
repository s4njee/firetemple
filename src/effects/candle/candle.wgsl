// One candle, drawn for a see-through canvas: a teardrop flame with a blue foot and a dark wick, a
// soft halo, and a wax body (or a tea light's cup) with real coverage. It writes LINEAR radiance
// and coverage; everything that moves arrives as a uniform, computed once per frame on the CPU.
//
// The flame is laminar, so it needs no noise for its shape: the lean, the trailing tip and the
// flicker are a spring and the shared flicker signal (index.ts, draught.ts). The only texture
// fetch is the fluttering edge, taken inside the silhouette and only when there is any flutter.
#include "fullscreen.wgsl"
#include "sdf.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "noisetex.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Flame space: origin where the flame leaves the wick, y up, one unit = the flame's height.
const CANDLE_MAX_LEAN: f32 = 0.55; // MAX_LEAN in draught.ts
const CANDLE_HALF_WIDTH: f32 = 0.15;
const CANDLE_WICK: f32 = 0.13; // wick standing out of the wax, flame heights
const CANDLE_FOOT: f32 = 0.04; // the flame starts this far up the wick
const CANDLE_ROUND: f32 = 0.03; // radius of the tip

const CANDLE_GLOW = vec3f(1.0, 0.52, 0.17);
const CANDLE_BLUE = vec3f(0.05, 0.2, 1.0);
const CANDLE_WAX_LIT = vec3f(1.0, 0.6, 0.27);
const CANDLE_METAL = vec3f(0.5, 0.51, 0.55);

// Radiance of the flame at flame-space q. One texture fetch, and only inside a fluttering flame.
fn candle_flame(q: vec2f) -> vec3f {
  var fp = flame_params(CANDLE_HALF_WIDTH, 1.0);
  fp.turbulence = CANDLE_MAX_LEAN / CANDLE_HALF_WIDTH;
  fp.turbulence_curve = 1.5;
  fp.erosion = params.flutter;
  fp.erosion_curve = 0.9;
  fp.core = 0.55;
  fp.hot = 0.36;
  fp.falloff = 0.28;
  fp.base_soft = 0.92;
  if (!flame_reach(q, fp)) {
    return vec3f(0.0);
  }
  // The lean: the tip follows the base a moment later, so a push travels up the flame, and a
  // ripple climbs it while the air is disturbed.
  let t = q.y;
  let bend = mix(params.lean, params.tip, t) + params.wobble * sin(7.0 * t - params.wobble_phase);
  let side = clamp(-bend / CANDLE_MAX_LEAN, -1.0, 1.0);
  var s = flame_turbulence(q, vec2f(side, 0.0), CANDLE_MAX_LEAN, 1.0, fp.turbulence_curve);
  // The teardrop's sides are straight lines to the tip. A candle's are convex, so the upper flame
  // is drawn up to 2.1 times wider (which still stays inside the teardrop's widest point, and so
  // inside flame_reach), and the whole outline is rounded by CANDLE_ROUND.
  let swell = 1.0 + 1.1 * smoothstep(0.15, 0.8, t);
  s.x /= swell;
  let d = flame_sd_teardrop(s - vec2f(0.0, CANDLE_ROUND), fp.half_width - CANDLE_ROUND, 1.0 - 2.0 * CANDLE_ROUND)
    - CANDLE_ROUND;
  if (d >= 0.0) {
    return vec3f(0.0);
  }
  var erode = 0.0;
  if (params.flutter > 0.01) {
    let n = noisetex_sample(noise_tex, noise_smp, vec2f(s.x * 2.6 + 1.7, s.y * 1.3 - params.rise));
    erode = smoothstep(0.38, 0.66, n.r);
  }
  var heat = flame_heat_from_sd(d, t, erode, fp);
  // The dark zone: unburnt vapour around the wick, which the flame is seen through.
  let w = vec2f(s.x / 0.075, (t - 0.1) / 0.14);
  heat *= 1.0 - 0.75 * exp(-dot(w, w));

  // The blue foot: a thin cup of clean burning round the base, strongest at the surface. It does
  // not flicker with the rest, and no soot glows inside it (red over blue would read as violet).
  let depth = saturate(-d / (0.5 * fp.half_width));
  let low = 1.0 - smoothstep(0.02, 0.24, t);
  let foot = low * low * smoothstep(0.0, 0.2, depth) * (1.0 - 0.8 * depth);
  heat *= 1.0 - 0.6 * low * low;
  return ramp_fire(heat) * (params.intensity * params.level) + CANDLE_BLUE * (foot * params.intensity);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // y up, one unit = the canvas height; a narrow canvas zooms out so the lean still fits.
  let p = vec2f((in.uv.x - 0.5) * params.aspect, 1.0 - in.uv.y) / params.fit;
  let px = params.pixel;
  let fh = params.flame_h;
  let half = params.body.x;
  let top = params.body.y;
  var out = vec4f(0.0);

  // Halo: light with no coverage, zero at its radius and at the canvas edge so no rectangle shows.
  let c = p - vec2f(0.4 * params.tip * fh, top + 0.45 * params.flame_rest);
  let r2 = dot(c, c) / (params.halo_radius * params.halo_radius);
  if (r2 < 1.0) {
    let border = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
    let window = (1.0 - r2) * (1.0 - r2) / (1.0 + 7.0 * r2);
    out = vec4f(CANDLE_GLOW * (params.halo * params.level * window * smoothstep(0.0, 0.08, border)), 0.0);
  }

  // Flame: emission only.
  out += vec4f(candle_flame((p - vec2f(0.0, top + CANDLE_FOOT * fh)) / fh), 0.0);

  // Wax, standing on the bottom edge of the canvas. Opaque.
  if (abs(p.x) < half + px && p.y < top + px) {
    let d = sd_rounded_box_2d(p - vec2f(0.0, 0.5 * top - 1.0), vec2f(half, 0.5 * top + 1.0), min(0.3 * half, 0.014));
    let across = p.x / half;
    let bulge = sqrt(max(1.0 - across * across, 0.0));
    let below = max(top - p.y, 0.0) / params.flame_rest; // resting flame heights under the rim
    let light = params.level * params.intensity;
    // Wax is translucent: the flame's light soaks into the top and dies away down the stick.
    let soak = exp(-below / 0.5) + 0.07 / (1.0 + below * below);
    var surface = params.wax * (params.ambient * (0.45 + 0.55 * bulge))
      + params.wax * CANDLE_WAX_LIT * (light * soak * (0.7 + 0.3 * bulge));
    if (params.cup > 0.5 && p.y < top - 0.16 * top) {
      // A tea light's cup: pressed metal, one soft highlight, the rim catching the flame.
      let rim = exp(-(top - 0.16 * top - p.y) / (0.1 * top));
      let sheen = 0.3 + 0.5 * bulge + 0.9 * exp(-(across + 0.42) * (across + 0.42) / 0.02);
      surface = CANDLE_METAL * (params.ambient * sheen) + CANDLE_WAX_LIT * (0.35 * light * rim * bulge);
    }
    out = mix(out, vec4f(surface, 1.0), sd_coverage(d, px));
  }

  // Wick: a dark thread through the foot of the flame, its end glowing.
  if (abs(p.x) < 0.1 * fh && p.y > top - 0.05 * fh && p.y < top + (CANDLE_WICK + 0.05) * fh) {
    let tip = vec2f(0.035 * fh + 0.1 * params.lean * fh, top + CANDLE_WICK * fh);
    let d = sd_segment_2d(p, vec2f(0.0, top - 0.02 * fh), tip) - max(0.011 * fh, 0.75 * px);
    let up = saturate((p.y - top) / (CANDLE_WICK * fh));
    let ember = vec3f(2.6, 0.5, 0.05) * (smoothstep(0.72, 1.0, up) * params.level * params.intensity);
    out = mix(out, vec4f(vec3f(0.012, 0.01, 0.009) + ember, 1.0), 0.92 * sd_coverage(d, px));
  }
  return out;
}
