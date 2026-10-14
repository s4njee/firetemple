// The fuel map of the burn-front solver: where there is something to burn, and how unevenly it
// burns. Drawn once, and again whenever the rectangles or the grid change; never per step.
//
//   r  signed distance to the nearest fuel, in canvas heights (negative inside), capped at 4
//   g  speed noise      -1..1, standard deviation about 0.4: how fast the front crosses this cell
//   b  burn-rate noise  -1..1: how long this cell takes to burn through
//   a  crumble noise    -1..1: how soon its char falls away
//
// Fuel is the union of up to BURN_MAX_RECTS rounded rectangles in canvas uv. Keeping the distance
// instead of a mask gives the display a sharp edge at any grid resolution, and tells the solver
// which empty cells are close enough to fuel to carry the fire across a gap.
#include "fullscreen.wgsl"
#include "sdf.wgsl"
#include "noisetex.wgsl"
#include "burn-map-uniforms.wgsl"

@group(0) @binding(0) var<uniform> fuel_map: BurnMap;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Scale of the second noise layer against the first; `FINE_SCALE` in burn.ts.
const BURN_FINE: f32 = 2.63;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let scale = vec2f(fuel_map.aspect, 1.0);
  var distance_to_fuel = 4.0;
  for (var i = 0u; i < fuel_map.count; i++) {
    let rect = fuel_map.rects[i];
    let d = sd_rounded_box_2d((in.uv - rect.xy) * scale, rect.zw * scale, fuel_map.shapes[i].x);
    distance_to_fuel = min(distance_to_fuel, d);
  }

  // Two layers of the shared tile at unrelated scales, so its 8-cell repeat never shows as a
  // copy. `grain` is noise cells per canvas height. Each layer is read at the mip level where a
  // texel is about a grid cell: a coarse grid would otherwise alias the fine layer into rings.
  let p = in.uv * scale * fuel_map.grain + fuel_map.offset;
  let coarse = noisetex_sample_lod(noise_tex, noise_smp, p, fuel_map.lod_coarse);
  let fine = noisetex_sample_lod(noise_tex, noise_smp, p * BURN_FINE + vec2f(5.1, 1.7), fuel_map.lod_fine);
  // Each channel of the tile has a standard deviation of about 0.107 around 0.5.
  let speed_noise = clamp(((coarse.r - 0.5) * 0.75 + (fine.g - 0.5) * 0.4) * 4.4, -1.0, 1.0);
  let rate_noise = clamp(((coarse.g - 0.5) * 0.6 + (fine.b - 0.5) * 0.6) * 4.4, -1.0, 1.0);
  let crumble_noise = clamp(((fine.r - 0.5) * 0.8 + (coarse.b - 0.5) * 0.5) * 4.4, -1.0, 1.0);
  return vec4f(distance_to_fuel, speed_noise, rate_noise, crumble_noise);
}
