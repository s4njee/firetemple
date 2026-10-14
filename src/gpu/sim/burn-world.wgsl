// The last pass of "is anything left to burn?": the top of burn-reduce.wgsl's pyramid into the one
// texel the step shader reads.
//
//   r      1 if any block is live
//   g + b  seconds since nothing was (0 while something is). Whole seconds in g, the fraction in
//          b: a half float cannot count sixtieths of a second past 32 seconds, because the step
//          falls below half the spacing of its values.
#include "fullscreen.wgsl"
#include "burn-world-uniforms.wgsl"

@group(0) @binding(0) var<uniform> world: BurnWorld;
@group(0) @binding(1) var blocks_tex: texture_2d<f32>;
@group(0) @binding(2) var previous_tex: texture_2d<f32>;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(blocks_tex));
  var live = 0.0;
  for (var y = 0; y < dims.y; y++) {
    for (var x = 0; x < dims.x; x++) {
      live = max(live, textureLoad(blocks_tex, vec2i(x, y), 0).r);
    }
  }
  if (live > 0.5) { return vec4f(1.0, 0.0, 0.0, 1.0); }
  let previous = textureLoad(previous_tex, vec2i(0), 0);
  let fraction = previous.b + world.elapsed;
  let carried = floor(fraction);
  return vec4f(0.0, min(previous.g + carried, 2000.0), fraction - carried, 1.0);
}
