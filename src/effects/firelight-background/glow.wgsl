// The firelight background at canvas size: the light of a fire that is just out of frame, falling
// off across the picture, with the slow field of field.wgsl moving patches of it around.
// One texture fetch and some arithmetic per pixel. Opaque: it writes linear radiance, alpha 1.
#include "fullscreen.wgsl"
#include "glow-params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var field_tex: texture_2d<f32>;
@group(0) @binding(2) var field_smp: sampler;

// What is left where the light does not reach: a warm near-black, not a hole.
const AMBIENT = vec3f(0.006, 0.004, 0.0035);
// Light level at which the colour is half way from the tint to its deep-red shadow colour.
const REDDEN_KNEE: f32 = 0.3;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Canvas heights, y up: the frame is aspect x 1 and the fire sits outside it at `origin`.
  let p = vec2f(in.uv.x * params.aspect, 1.0 - in.uv.y);
  let f = textureSampleLevel(field_tex, field_smp, in.uv, 0.0);

  // Distance to the fire, which is a line (`origin` -/+ `extent`), not a point: a hearth has a
  // width, and a point of light under a wide, short canvas would be a spotlight.
  let from_fire = p - params.origin;
  let along = clamp(
    dot(from_fire, params.extent) / max(dot(params.extent, params.extent), 1e-6),
    -1.0,
    1.0,
  );
  // Falloff: a quarter at one `reach`, a twenty-fifth at two. Steeper than the inverse square of
  // a bare flame, because a room swallows light too.
  let x = length(from_fire - params.extent * along) / params.reach;
  let inverse = 1.0 / (1.0 + x * x);
  let falloff = inverse * inverse;
  // The field brightens and dims patches around a mean of 1, so it moves light about without
  // adding or removing much of it.
  let patches = 1.0 + params.movement * (2.0 * f.r - 1.0);
  let level = params.level * falloff * patches;

  // Colour: the tint where the light is strong, redder where it is weak (green and blue fall
  // away faster than red, as they do in the shadow side of anything lit by a fire). The second
  // field moves the balance a little so the colour is not one flat hue.
  let warm = level / (level + REDDEN_KNEE) * (0.85 + 0.3 * f.g);
  let s = mix(1.0, warm, params.redden);
  let color = params.tint * level * vec3f(1.0, s, s * s);

  return vec4f(AMBIENT + color, 1.0);
}
