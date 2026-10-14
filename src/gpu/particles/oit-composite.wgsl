// The resolve of weighted blended OIT (src/gpu/particles/oit.ts, oit.wgsl): one fullscreen pass
// over the scene, blended (one, one-minus-src-alpha), so
//   scene.rgb = avg * (1 - revealage) + emission * mix(1, revealage, occlusion) + scene.rgb * revealage
//   scene.a   = (1 - revealage) + scene.a * revealage
// where avg = accum.rgb / accum.a. With nothing drawn (accum 0, revealage 1, emission 0) the source
// is exactly 0 and the scene is left as it was.

#include "fullscreen.wgsl"

struct OitComposite {
  occlusion: f32,
  emissive: u32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> oit: OitComposite;
@group(0) @binding(1) var oit_accum: texture_2d<f32>;
@group(0) @binding(2) var oit_revealage: texture_2d<f32>;
@group(0) @binding(3) var oit_emission: texture_2d<f32>;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let revealage = clamp(textureLoad(oit_revealage, pixel, 0).r, 0.0, 1.0);
  // The paper's guard against a half-float overflow: an infinite sum becomes a flat colour.
  let accum = min(textureLoad(oit_accum, pixel, 0), vec4f(65504.0));
  let coverage = 1.0 - revealage;
  let avg = accum.rgb / clamp(accum.a, 1e-6, 5e4);
  var rgb = avg * coverage;
  if (oit.emissive != 0u) {
    let emission = textureLoad(oit_emission, pixel, 0).rgb;
    rgb += emission * mix(1.0, revealage, oit.occlusion);
  }
  return vec4f(rgb, coverage);
}
