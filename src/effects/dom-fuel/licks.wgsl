// Flames rising off whatever is alight, kept in a small texture of their own (one texel per
// solver cell, ping-ponged once a frame). Each cell holds the hotter of two things: the solver's
// heat here, and what the cell below held a moment ago, a little cooler. Heat therefore climbs a
// cell a frame and dies away with height, which is the rule of the Doom fire, with one change:
// how much survives each cell comes from a smooth noise field that drifts upwards, not from a
// random number per cell per frame, so the tongues lean and stretch instead of flickering at the
// frame rate.
//
// The height a flame reaches is set in canvas heights, so it does not depend on the grid.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "licks-params.wgsl"

@group(0) @binding(0) var<uniform> licks: Licks;
@group(0) @binding(1) var state_tex: texture_2d<f32>;
@group(0) @binding(2) var previous_tex: texture_2d<f32>;
@group(0) @binding(3) var grid_smp: sampler;
@group(0) @binding(4) var noise_tex: texture_2d<f32>;
@group(0) @binding(5) var noise_smp: sampler;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = vec2f(in.uv.x * licks.aspect, in.uv.y);
  // r: how tall the flame is here and now. g: which way it leans.
  let n = noisetex_sample_lod(noise_tex, noise_smp, p * licks.scale + vec2f(0.0, licks.rise), licks.lod);
  let heat = textureSampleLevel(state_tex, grid_smp, in.uv, 0.0).g;

  // uv grows downwards: the cell below is one row further on.
  let below = in.uv + vec2f((n.g - 0.5) * 1.8 * licks.cell.x, licks.cell.y);
  let carried = textureSampleLevel(previous_tex, grid_smp, below, 0.0).r;
  // Share that survives one cell of climb, for a flame `reach` canvas heights tall.
  let reach = licks.reach * (0.15 + 1.7 * n.r);
  let keep = exp(-licks.cell.y / max(reach, 1e-5));

  return vec4f(max(clamp(heat, 0.0, 1.0), carried * keep), 0.0, 0.0, 1.0);
}
