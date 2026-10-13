#include "fullscreen.wgsl"
#include "fbm.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

// Writes linear radiance into the HDR scene target; the tail turns it into canvas colour.
@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let up = 1.0 - in.uv.y;
  let p = vec2f(in.uv.x * params.aspect, up) * params.scale;

  // The pattern drifts upward; the warp keeps it from reading as one sliding texture.
  let rising = p - vec2f(0.0, params.time);
  let warped = domain_warp_2d_anim(rising, params.time * 0.2, params.warp, 3, 2.0, 0.5);
  let n = 0.5 + 0.5 * fbm_3d(vec3f(warped, params.time * 0.3), 5, 2.0, 0.5);

  // Hot at the base, cooling with height: noise minus a height ramp.
  let heat = clamp(n * 1.7 - up * params.falloff, 0.0, 1.0);

  let body = params.tint * pow(heat, 2.0);
  let core = vec3f(1.0, 0.85, 0.6) * pow(heat, 6.0);
  return vec4f((body + core) * params.intensity, 1.0);
}
