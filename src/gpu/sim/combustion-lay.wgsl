// Lays the fuel for the combustion model (src/gpu/sim/combustion.ts): writes a whole new state.
//
// The capacity F0 comes from the shared baked noise tile, sampled here once and then fixed, so
// rich and poor patches stay where they are for as long as this grid lives. With `keep` the old
// temperature and the burnt share of each cell are carried over (read by uv, so the old grid may
// have had another size): a slider or a resize re-lays the fuel without putting the fire out.
// Without it the fuel is full and cold, apart from a few fronts that are already burning, so the
// first frame is a picture and not an empty canvas.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "combustion-lay-params.wgsl"

@group(0) @binding(0) var<uniform> lay: CombustionLay;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;
@group(0) @binding(3) var prev: texture_2d<f32>;
@group(0) @binding(4) var prev_smp: sampler;

// The tile's fractal channel has a standard deviation of about 0.1 around 0.5.
const COMBUST_NOISE_GAIN: f32 = 4.5;
// Widths of a ready-made front, in canvas heights: the preheated zone ahead of it, the reaction
// zone, and the cooling tail behind.
const COMBUST_PREHEAT: f32 = 0.012;
const COMBUST_ZONE: f32 = 0.015;
const COMBUST_TAIL: f32 = 0.06;

// Fuel capacity at uv: 1 everywhere at patchiness 0; at 1 about a quarter of the ground is bare
// or too poor to carry a front and a quarter is full.
fn combust_capacity(uv: vec2f) -> f32 {
  let p = vec2f(uv.x * lay.aspect, uv.y) * lay.scale + lay.offset;
  let n = (noisetex_sample(noise_tex, noise_smp, p).r - 0.5) * COMBUST_NOISE_GAIN;
  return clamp(1.0 + lay.patchiness * (1.3 * n - 0.4), 0.0, 1.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv;
  let capacity = combust_capacity(uv);

  if (lay.keep > 0.5) {
    let old = textureSampleLevel(prev, prev_smp, uv, 0.0);
    // Keep the share of the fuel that is left, not the amount: the capacity may have changed.
    let share = clamp(old.g / max(old.b, 1e-3), 0.0, 1.0);
    return vec4f(old.r, capacity * share, capacity, 0.0);
  }

  var t = 0.0;
  var share = 1.0;
  let here = vec2f(uv.x * lay.aspect, uv.y);
  for (var i = 0u; i < lay.count; i++) {
    let front = lay.fronts[i];
    // d: distance ahead of the front (negative behind it, inside the ring), in canvas heights.
    let d = length(here - vec2f(front.x * lay.aspect, front.y)) - front.z;
    // The temperature peaks where the fuel is gone, one reaction zone behind the fuel's edge.
    let hot = d + COMBUST_ZONE;
    let ahead = exp(-max(hot, 0.0) / COMBUST_PREHEAT);
    let behind = exp(min(hot, 0.0) / COMBUST_TAIL);
    t = max(t, lay.peak * ahead * behind);
    // Burnt behind the front, growing back further in.
    let burnt = 1.0 - smoothstep(-COMBUST_ZONE, 0.0, d);
    let healed = smoothstep(0.0, lay.heal, -d - COMBUST_ZONE);
    share = min(share, 1.0 - burnt * (1.0 - healed));
  }
  // A front does not stand on ground that cannot burn.
  t *= smoothstep(0.3, 0.7, capacity);
  return vec4f(t, capacity * share, capacity, 0.0);
}
