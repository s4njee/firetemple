// The moving part of the firelight background: slow domain-warped noise, drawn SMALL (an eighth
// of the canvas each way) because nothing in it is finer than a few hundred pixels. glow.wgsl
// stretches it over the canvas with one bilinear fetch.
//
// Output, both 0..1 with mean 0.5:
//   r   where the light is stronger and weaker: the patches that drift away from the fire
//   g   a slower, broader field that shifts the colour a little
// Nine evaluations of 3D gradient noise per texel, which is why this is not done at full size.
#include "fullscreen.wgsl"
#include "fbm.wgsl"
#include "field-params.wgsl"

@group(0) @binding(0) var<uniform> field: FieldParams;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Canvas heights, y up, in noise cells; the whole pattern drifts away from the fire.
  let p = vec2f(in.uv.x * field.aspect, 1.0 - in.uv.y) * field.scale - field.drift;
  // The domain warp: the lookup position is pushed around by two more slow noise fields, so the
  // patches stretch and fold instead of sliding past as one sheet. The third coordinate is time:
  // the pattern changes where it is.
  let q = domain_warp_2d_anim(p * 0.7, field.time * 0.6, field.warp, 2, 2.0, 0.5) / 0.7;
  let light = fbm_3d(vec3f(q, field.time), 3, 2.0, 0.5);
  let hue = fbm_3d(vec3f(q * 0.45 + vec2f(21.0, 4.0), field.time * 0.5), 2, 2.0, 0.5);
  // A fractal sum stays within about +-0.5; stretch it to use the range.
  return vec4f(
    0.5 + 0.5 * clamp(light * 2.0, -1.0, 1.0),
    0.5 + 0.5 * clamp(hue * 2.0, -1.0, 1.0),
    0.0,
    1.0,
  );
}
