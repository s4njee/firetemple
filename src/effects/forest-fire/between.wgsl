// The state as the frame should show it: the last two steps blended by how far the frame is past
// the newer one. Drawn at grid size (a few thousand texels), so the full-size pass reads one
// texture instead of two and nothing in the picture jumps at the step rate.
#include "fullscreen.wgsl"
#include "between-params.wgsl"

@group(0) @binding(0) var<uniform> between: Between;
@group(0) @binding(1) var state_a: texture_2d<f32>;
@group(0) @binding(2) var state_b: texture_2d<f32>;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let cell = vec2i(in.position.xy);
  return mix(textureLoad(state_b, cell, 0), textureLoad(state_a, cell, 0), between.weight_a);
}
