// The flame strip: a band of fire along the bottom edge of a wide, short canvas.
//
// It is the scrolling-noise flame (a height gradient minus rising noise, through the fire ramp)
// with two additions. The height the fire reaches follows a row of crests, so the band has a
// silhouette with a rhythm instead of one level top. And everything is periodic across the canvas
// width, so the left edge continues into the right one and the strip tiles: a whole number of
// crests, and a whole number of noise tiles in each of the two noise layers. The layers repeat
// `tiles` and `tiles_warp` times, consecutive whole numbers, which share no factor: together they
// repeat once per canvas width and not sooner.
//
// Units are flame heights: y = 0 on the bottom edge, 1 at the top of the tallest crest.
// Emission only: scene alpha stays 0 and the tail derives the canvas alpha from the light.
#include "fullscreen.wgsl"
#include "math.wgsl"
#include "hash.wgsl"
#include "noisetex.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Noise cells are this many times taller than wide.
const STRETCH: f32 = 2.0;
// Heat of the body where the noise is lowest and how much the noise adds: the fire ramp is
// orange at 0.5, yellow at 0.75 and white only above 0.9.
const BODY_HEAT: f32 = 0.45;
const CORE_HEAT: f32 = 0.4;

// How much of the gradient the noise may remove right at the base.
const BASE_BITE: f32 = 0.16;

// Height of crest `index` (any integer; crests repeat every `count`), in 0..1.
fn strip_peak(index: i32) -> f32 {
  let count = max(i32(params.count), 1);
  let id = ((index % count) + count) % count;
  let h = ihash_2to2(vec2i(id, 7));
  // Each crest grows and shrinks on its own slow clock: a whole number of cycles (6 to 14) per
  // loop of `clock`, so between 4.5 and 11 seconds each, and the loop closes exactly.
  let breath = 0.5 + 0.5 * sin(TAU * (params.clock * (6.0 + floor(h.y * 9.0)) + h.x));
  return 1.0 - params.uneven * (0.7 * h.x + 0.3 * breath);
}

// How high the fire reaches at x (flame heights): the crests' own heights, joined smoothly, with
// a dip between neighbours that `gap` deepens from none (a wall) to all the way down (separate
// fires standing on the bed).
fn strip_crest(x: f32, pitch: f32) -> f32 {
  let c = x / pitch - 0.5;
  let index = floor(c);
  let f = c - index;
  let height = mix(strip_peak(i32(index)), strip_peak(i32(index) + 1), smoothstep(0.0, 1.0, f));
  let dip = sin(PI * f);
  return height * (1.0 - params.gap * dip * dip);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let y = (1.0 - in.uv.y) / params.flame;
  // The early-out: no crest is taller than 1 and the noise only removes heat.
  if (y >= 1.0) {
    return vec4f(0.0);
  }
  // The canvas width in flame heights, and this pixel's place along it.
  let span = params.aspect / params.flame;
  let x = in.uv.x * span;

  // Two fetches of the shared noise tile, both a whole number of tiles across the canvas. The
  // first is a slower, coarser layer that displaces the second and leans the fire.
  let across = in.uv.x * NOISETEX_CELLS;
  let up = y * NOISETEX_CELLS * params.tiles / (span * STRETCH);
  let warp = noisetex_fbm2(
    noise_tex,
    noise_smp,
    vec2f(across * params.tiles_warp + 3.7, up * 0.71 - params.rise_slow),
  );
  let s = noisetex_sample(
    noise_tex,
    noise_smp,
    vec2f(across * params.tiles, up - params.rise) + 0.45 * warp,
  );
  let n = clamp(0.5 + (s.r * 2.0 - 1.0) * 0.8 + (s.b * 2.0 - 1.0) * 0.35, 0.0, 1.0);

  // The silhouette: how high the fire reaches here. The column leans with the slow noise layer,
  // more the higher up it is, and never drops below the bed, whose top follows the noise.
  let pitch = span / params.count;
  let lean = params.sway * pitch * warp.x * flame_tip_weight(y, 1.4);
  let reach = max(strip_crest(x + lean, pitch), params.bed * (0.4 + 1.2 * n));

  // From here it is the scrolling-noise flame: a gradient that is 1 at the base and 0 at the
  // top of this column, minus noise that bites harder with height.
  let t = y / max(reach, 1e-3);
  let bite = (1.0 - n) * (BASE_BITE + params.erosion * t);
  let depth = clamp(1.0 - t - bite, 0.0, 1.0);
  // A steep rise at the surface (a thin red rim), levelling off at a body heat that follows the
  // noise.
  let shell = 1.0 - depth;
  let heat = (BODY_HEAT + CORE_HEAT * n) * (1.0 - shell * shell * shell);

  return vec4f(ramp_fire(heat) * params.intensity, 0.0);
}
