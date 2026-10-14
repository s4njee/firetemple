// Carries the burn solver's state over to a grid of another size (a canvas resize), nearest cell
// to nearest cell: the clock channel holds codes and "never" values that must not be blended.
#include "fullscreen.wgsl"

@group(0) @binding(0) var old_tex: texture_2d<f32>;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(old_tex));
  let c = clamp(vec2i(in.uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(old_tex, c, 0);
}
