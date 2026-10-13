#include "fullscreen.wgsl"

@group(0) @binding(0) var march_tex: texture_2d<f32>;
@group(0) @binding(1) var march_samp: sampler;

// Stretches the reduced-resolution march over the scene target. Smoke has no edges sharper than the bilinear
// filter, and premultiplied colour and alpha interpolate correctly together.
@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  return textureSampleLevel(march_tex, march_samp, in.uv, 0.0);
}
