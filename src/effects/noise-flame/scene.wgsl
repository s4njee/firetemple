// The scrolling-noise flame: noise scrolled upward, shaped by a height gradient, through a ramp.
// A wall of fire along the bottom edge of the canvas, with nothing drawn (and nothing computed)
// above the height a flame can reach. Emission only: scene alpha stays 0, the tail derives the
// canvas alpha from the light.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "sources.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Noise cells are this many times taller than wide: tongues, not blobs.
const STRETCH: f32 = 2.0;
// Fewest noise cells across the canvas width.
const MIN_ACROSS: f32 = 5.0;
// How much of the gradient the noise may remove right at the base. Small, so the foot of the
// wall is solid fire with a little texture instead of a gap.
const BASE_BITE: f32 = 0.16;
// Heat of the flame body where the noise is lowest, and how much the noise adds to it. The fire
// ramp is orange at 0.5, yellow at 0.75 and white only above 0.9.
const BODY_HEAT: f32 = 0.46;
const CORE_HEAT: f32 = 0.36;

// The noise at p (cells, y up) after rising `rise` cells, in [-1, 1].
fn scene_noise(p: vec2f, rise: f32) -> f32 {
  let kind = i32(params.noise_kind);
  if (kind == NF_TEXTURE) {
    // Two fetches of the shared baked tile.
    return noisetex_flame(noise_tex, noise_smp, p, rise);
  }
  return nf_flame(kind, p, rise, i32(params.octaves), params.warp > 0.5);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // t: 0 on the bottom edge, 1 at the highest point any flame can reach.
  let y = 1.0 - in.uv.y;
  let t = y / params.height;
  // The early-out. The noise below only ever REMOVES heat, so above t = 1 there is none.
  if (t >= 1.0) {
    return vec4f(0.0);
  }

  // Noise cells: `scale` of them across one flame height, stretched upward. A canvas narrower
  // than it is tall gets at least MIN_ACROSS of them across its width, so a phone in portrait
  // shows a row of tongues and not a close-up of one.
  let cells = max(params.scale / params.height, MIN_ACROSS / params.aspect);
  let p = vec2f(in.uv.x * params.aspect * cells, y * cells / STRETCH);
  let n = clamp(0.5 + scene_noise(p, params.rise), 0.0, 1.0);

  // The classic, in three lines. A gradient that is 1 at the base and 0 at the top...
  let gradient = 1.0 - t;
  // ...minus noise that bites harder the higher up it is, which is what breaks the top into
  // tongues and pinches off licks...
  let bite = (1.0 - n) * (BASE_BITE + params.ragged * t);
  // ...and whatever is left is how deep inside the fire this pixel is.
  let depth = clamp(gradient - bite, 0.0, 1.0);

  // Depth to heat: a steep rise at the surface (a thin red rim, not a wide orange fog), levelling
  // off at a body heat that follows the noise, so tongues have hotter middles and the foot of
  // the wall is textured yellow instead of a flat white bar.
  let shell = 1.0 - depth;
  let heat = (BODY_HEAT + CORE_HEAT * n) * (1.0 - shell * shell * shell);

  return vec4f(ramp_fire(heat) * params.intensity, 0.0);
}
