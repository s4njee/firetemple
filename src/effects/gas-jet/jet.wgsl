// Gas jets: a tight blue cone with a pale inner cone, alone, in a row or as the crown of a stove
// burner, and shock diamonds along the jet for an exhaust.
//
// Every pixel belongs to at most one jet. It finds which one with arithmetic (a round along the
// row, or an atan2 round the ring), moves into that jet's frame, and shades ONE jet: a taper from
// flame.wgsl for the mantle, a second taper for the inner cone, and a repeated lozenge for the
// diamonds. One fetch of the shared noise tile inside the jet's reach, none outside.
#include "fullscreen.wgsl"
#include "sdf.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "noisetex.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

const JET_TAU: f32 = 6.283185307;
const JET_STEEL = vec3f(0.055, 0.056, 0.062);
const JET_BRASS = vec3f(0.3, 0.19, 0.06);
const JET_PALE = vec3f(0.5, 0.86, 1.0);
// The shared gas ramp leaves a long violet tail on something this thin; hold its red back.
const JET_LESS_RED = vec3f(0.35, 1.0, 1.0);
const JET_DIAMOND_COOL = vec3f(0.62, 0.86, 1.0);
const JET_DIAMOND_WARM = vec3f(1.0, 0.8, 0.5);

// Radiance of one jet. `l` is in the jet's frame: x across, y along the axis from the nozzle, in
// scene units. `jet` is its number, which only moves it to another part of the noise.
fn jet_flame(l: vec2f, jet: f32) -> vec3f {
  let len = params.length;
  let half = params.half_width / len;
  let q = l / len;
  var fp = flame_params(half, 1.0);
  fp.turbulence = 0.4 * params.roar;
  fp.turbulence_curve = 2.0;
  fp.erosion = 0.1 + 0.7 * params.roar;
  fp.erosion_curve = 1.3;
  fp.core = 0.55;
  fp.hot = 0.0;
  fp.falloff = 0.5;
  fp.base_soft = 0.0;
  if (!flame_reach(q, fp)) {
    return vec3f(0.0);
  }
  // Streaks, stretched eleven times along the jet and rushing away from the nozzle. The stretch
  // is what lets the flow look fast while a point on the jet changes only a few times a second:
  // the noise passes at JET_RUSH cells a second (index.ts), so that is its base frequency in hertz.
  let n = noisetex_sample(noise_tex, noise_smp, vec2f(
    0.55 * l.x / params.half_width + 1.37 * jet,
    0.05 * l.y / params.half_width - params.rise + 0.61 * jet,
  ));
  let sway = clamp(4.0 * n.g - 2.0, -1.0, 1.0);
  let erode = smoothstep(0.3, 0.7, n.r);

  // Shock cells: where the diamonds are, how far along (each one fainter), and the plume drawn in
  // a little between them.
  let cell = (q.y - 0.6 * params.diamond_step) / params.diamond_step;
  let k = max(floor(cell + 0.5), 0.0);
  let fade = params.diamonds * exp(-0.32 * k);
  let between = 0.5 - 0.5 * cos(JET_TAU * cell);
  // (Fading continuously here: the per-diamond fade steps exactly where the squeeze is greatest.)
  let squeeze = params.diamonds * exp(-0.32 * max(cell, 0.0)) * between;
  let squeezed = vec2f(q.x * (1.0 + 0.22 * squeeze), q.y);

  // Mantle: the outer cone.
  let heat = flame_heat_taper(squeezed, vec2f(sway, erode), params.tip * half, fp);
  // The gas ramp's cool end is violet and a jet's mantle is thin, so most of it would land there:
  // lift the heat first. The warm version starts well up the fire ramp, so it runs orange to pale
  // yellow and never through the ramp's red end, which over any blue reads as pink.
  let lifted = pow(heat, 0.6);
  let cool = ramp_gas(0.82 * lifted) * JET_LESS_RED;
  let mantle = mix(cool, (0.14 * heat) * ramp_fire(0.72 + 0.25 * heat), params.warmth);

  // Inner cone: a thin luminous wall with a paler fill, steady, and it only fades into the mantle.
  let d_in = flame_sd_taper(q, 0.62 * half, 0.0, params.inner);
  let wall = exp(-d_in * d_in / (0.022 * half * half));
  let cone = max(wall, 0.72 * saturate(-d_in / (0.12 * half))) * saturate(heat * 6.0);
  var color = mantle + ramp_gas(cone) * 0.8 + JET_PALE * (1.2 * cone * cone * cone);

  // Diamonds: a lozenge |x| / a + |y| / b < 1 at every shock cell, its edge broken by the noise.
  if (fade > 0.001) {
    let reach = half * mix(1.0, max(params.tip, 0.25), q.y) * 0.7;
    let lozenge = 1.0 - abs(q.x) / reach - abs(cell - k) / 0.34 + 0.15 * (n.r - 0.5);
    let shimmer = 0.88 + 0.12 * sin(params.time * 7.0 + 2.1 * k + jet);
    let lit = smoothstep(0.0, 0.9, lozenge) * fade * shimmer * saturate(heat * 3.0);
    color += mix(JET_DIAMOND_COOL, JET_DIAMOND_WARM, params.warmth) * (7.0 * lit);
  }
  return color * params.intensity;
}

// Metal with a highlight along it: `across` is -1..1 over its width. `lit` is the flame's colour
// on the edge nearest the mouth.
fn jet_metal(base: vec3f, across: f32, lit: f32) -> vec3f {
  let rounded = sqrt(max(1.0 - across * across, 0.0));
  let sheen = 0.35 + 0.65 * rounded + 1.2 * exp(-(across + 0.4) * (across + 0.4) / 0.03);
  let flame = mix(vec3f(0.1, 0.35, 1.0), vec3f(1.0, 0.45, 0.12), params.warmth);
  return base * sheen + flame * (0.5 * lit * params.intensity);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Centred, y up, one unit = the canvas height; `fit` zooms out until the arrangement fits.
  let p = vec2f((in.uv.x - 0.5) * params.aspect, 0.5 - in.uv.y) / params.fit - params.origin;
  let px = params.pixel;
  let axis = params.axis;
  let side = vec2f(axis.y, -axis.x);
  let half = params.half_width;

  var l = vec2f(dot(p, side), dot(p, axis)); // the jet's frame
  var jet = 0.0;
  var body = 1.0; // signed distance to the burner
  var across = 0.0;
  var mouth = 0.0; // distance behind the mouth, for the light on the metal
  var metal = JET_STEEL;

  if (params.mode < 0.5) {
    // One jet from a tube.
    let tube = vec2f(1.3 * half + 2.0 * px, 0.5 * params.nozzle);
    body = sd_rounded_box_2d(l + vec2f(0.0, tube.y), tube, min(0.25 * half, 0.012));
    across = l.x / tube.x;
    mouth = -l.y;
  } else if (params.mode < 1.5) {
    // A row along a pipe.
    let last = params.count - 1.0;
    jet = clamp(round(l.x / params.spacing + 0.5 * last), 0.0, last);
    let centre = (jet - 0.5 * last) * params.spacing;
    let end = 0.5 * last * params.spacing + half;
    let radius = 0.5 * params.nozzle;
    body = sd_capsule_2d(l, vec2f(-end, -radius), vec2f(end, -radius), radius);
    across = (l.y + radius) / radius;
    mouth = -l.y;
    l.x -= centre;
    // Each port is a brass insert.
    metal = mix(JET_STEEL, JET_BRASS, 1.0 - smoothstep(1.2 * half, 1.5 * half, abs(l.x)));
  } else {
    // A ring, seen from above: jets leave the edge of a round cap.
    let reach = length(p);
    if (reach > params.radius + params.length + 2.0 * px) {
      return vec4f(0.0);
    }
    let turn = JET_TAU / params.count;
    jet = round((atan2(p.x, p.y) - params.angle) / turn);
    let a = params.angle + jet * turn;
    let out_dir = vec2f(sin(a), cos(a));
    l = vec2f(dot(p, vec2f(out_dir.y, -out_dir.x)), dot(p, out_dir) - params.radius);
    jet = jet + params.count; // keep it positive for the noise offset
    body = reach - params.radius - 0.012;
    across = saturate(reach / params.radius) * 0.9;
    mouth = params.radius - reach;
    metal = mix(JET_STEEL * 0.6, JET_BRASS, smoothstep(0.78, 0.82, reach / params.radius));
  }

  var out = vec4f(jet_flame(l, jet), 0.0);

  if (params.nozzle > 0.0 && body < px) {
    let lit = exp(-max(mouth, 0.0) / (1.5 * half));
    out = mix(out, vec4f(jet_metal(metal, across, lit), 1.0), sd_coverage(body, px));
  }
  return out;
}
