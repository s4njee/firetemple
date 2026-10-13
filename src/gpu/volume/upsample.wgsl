// Pass 3 of a reduced-resolution march (reduced.ts): the low-resolution march result, upsampled to
// the scene's resolution and composited over it.
//
// The march target holds vec4f(radiance, transmittance). Plain bilinear upsampling smears it across
// silhouettes: a low-resolution texel that marched all the way to the far wall bleeds its fog over
// the near object in front, as a halo one low-resolution texel wide. The depth-aware filter weighs
// each of the four texels by how close the depth it was marched against is to this pixel's own
// depth (volume_upsample_weights), so the edge of the volume against geometry stays as sharp as
// the geometry.
//
// Output is premultiplied: rgb = radiance, a = 1 - transmittance, for the blend
// (one, one-minus-src-alpha), which leaves scene * transmittance + radiance in the target.

#include "fullscreen.wgsl"
#include "volume.wgsl"
#include "volume-reduce-params.wgsl"

@group(0) @binding(0) var<uniform> reduce: VolumeReduceParams;
@group(0) @binding(1) var scene_depth: texture_depth_2d;
@group(0) @binding(2) var march: texture_2d<f32>;
@group(0) @binding(3) var march_depth: texture_2d<f32>;

fn view_depth(depth: f32) -> f32 {
  let z = reduce.near * reduce.far / (reduce.far - depth * (reduce.far - reduce.near));
  return min(z, reduce.depth_limit);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let last = vec2i(textureDimensions(march)) - vec2i(1);

  // This pixel's centre in low-resolution texel coordinates (texel centres at integers).
  let at = (vec2f(pixel) + vec2f(0.5)) / reduce.divisor - vec2f(0.5);
  // The 2x2 footprint is slid back inside the texture at the borders instead of collapsing onto
  // the last row or column: the weights there are the same (0 and 1), but the depth-aware filter
  // keeps four distinct candidates, so the checkerboard of depths still offers both sides.
  let base = clamp(vec2i(floor(at)), vec2i(0), max(last - vec2i(1), vec2i(0)));
  let t00 = base;
  let t10 = min(base + vec2i(1, 0), last);
  let t01 = min(base + vec2i(0, 1), last);
  let t11 = min(base + vec2i(1, 1), last);

  var weights = volume_bilinear_weights(clamp(at - vec2f(base), vec2f(0.0), vec2f(1.0)));
  if (reduce.depth_aware != 0u) {
    let depths = vec4f(
      textureLoad(march_depth, t00, 0).r,
      textureLoad(march_depth, t10, 0).r,
      textureLoad(march_depth, t01, 0).r,
      textureLoad(march_depth, t11, 0).r,
    );
    let depth = view_depth(textureLoad(scene_depth, pixel, 0));
    weights = volume_upsample_weights(weights, depths, depth, reduce.tolerance);
  }

  // Written as the first texel plus weighted differences: where the four texels agree the
  // differences are exactly zero, so a constant field comes through bit for bit.
  let first = textureLoad(march, t00, 0);
  let result = first
    + (textureLoad(march, t10, 0) - first) * weights.y
    + (textureLoad(march, t01, 0) - first) * weights.z
    + (textureLoad(march, t11, 0) - first) * weights.w;
  return vec4f(result.rgb, 1.0 - result.a);
}
