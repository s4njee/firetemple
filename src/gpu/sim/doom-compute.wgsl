// The Doom fire step as a compute pass: 8 x 8 cells per workgroup, the previous state read with
// textureLoad (inside the kernel) and the next written to a write-only storage texture. There is
// no read-write storage here: `rgba16float` is write-only storage on every WebGPU device, and the
// two states are separate textures that swap after the step.
#include "doom-kernel.wgsl"

@group(1) @binding(1) var doom_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn doom_step(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(doom_out);
  // The dispatch is rounded up to whole workgroups; the cells past the edge do not exist.
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  textureStore(doom_out, id.xy, doom_next(vec2i(id.xy)));
}
