// Pass 1 of a reduced-resolution march (reduced.ts): the full-resolution depth buffer reduced to
// the march resolution, as view-space depth in world units (r32float).
//
// Each low-resolution texel covers a block of `divisor` x `divisor` full-resolution pixels and has
// to pick ONE depth for its ray. Averaging would invent a depth no pixel has. Taking the nearest
// in every block on a checkerboard and the farthest on the other squares (Shopf, "Mixed Resolution
// Rendering", GDC 2009) means that around any silhouette both the foreground and the background
// depth are present among neighbouring texels, so the depth-aware upsample can always find a texel
// that was marched to the right depth. A plain bilinear upsample cannot use that and would show the
// checkerboard as a zigzag: for it every block takes its farthest depth.

#include "fullscreen.wgsl"
#include "volume-reduce-params.wgsl"

@group(0) @binding(0) var<uniform> reduce: VolumeReduceParams;
@group(0) @binding(1) var scene_depth: texture_depth_2d;

// View-space depth, with everything beyond the medium treated as one distance (see reduced.ts).
fn view_depth(depth: f32) -> f32 {
  let z = reduce.near * reduce.far / (reduce.far - depth * (reduce.far - reduce.near));
  return min(z, reduce.depth_limit);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let texel = vec2i(in.position.xy);
  let last = vec2i(textureDimensions(scene_depth)) - vec2i(1);
  let divisor = i32(reduce.divisor);
  var nearest = 1.0;
  var farthest = 0.0;
  for (var y = 0; y < divisor; y++) {
    for (var x = 0; x < divisor; x++) {
      let d = textureLoad(scene_depth, min(texel * divisor + vec2i(x, y), last), 0);
      nearest = min(nearest, d);
      farthest = max(farthest, d);
    }
  }
  let pick_near = reduce.checker != 0u && ((texel.x + texel.y) & 1) == 0;
  return vec4f(view_depth(select(farthest, nearest, pick_near)), 0.0, 0.0, 1.0);
}
