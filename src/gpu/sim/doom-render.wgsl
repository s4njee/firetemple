// The Doom fire step as a render pass: one fullscreen triangle over the next state, one fragment
// per cell. `position.xy` is the cell centre in texels, so the cell index is its floor. This
// version ports to WebGL2 as it stands (texelFetch for textureLoad, a half-float colour buffer).
#include "fullscreen.wgsl"
#include "doom-kernel.wgsl"

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  return doom_next(vec2i(in.position.xy));
}
