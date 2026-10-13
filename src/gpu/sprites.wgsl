// The instanced sprite renderer's shader (src/gpu/sprites.ts). One quad per instance, built in the
// vertex stage from `sprite.wgsl`: camera-facing, stretched along its on-screen velocity, never
// smaller than a pixel. The fragment stage shades it with `shade_sprite` (the default lives in
// sprites.ts; an effect can supply its own) and fades it against the scene depth.
//
// `sprite-settings.wgsl` is generated from the TypeScript struct; `sprite-shade.wgsl` is supplied
// at run time and must define `fn shade_sprite(s: SpriteSample) -> vec3f`.

#include "camera.wgsl"
#include "sprite.wgsl"
#include "sprite-settings.wgsl"

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> settings: SpriteSettings;
@group(0) @binding(2) var scene_depth: texture_depth_2d;

// What a shading function gets for one pixel of one sprite.
struct SpriteSample {
  // Quad-local position, -1..1, +x along the motion.
  p: vec2f,
  // The instance's colour (rgb, linear) and its fourth component.
  color: vec4f,
  // The instance's free parameter.
  param: f32,
  // `settings.shape`.
  shape: u32,
  // Length / width of the quad, 1 when unstretched.
  ratio: f32,
  // `settings.user`, for values a custom shading function needs.
  user: vec4f,
}

#include "sprite-shade.wgsl"

struct SpriteVarying {
  @builtin(position) position: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
  // param, stretch ratio, radiance scale, effective half-width in world units
  @location(2) @interpolate(flat) misc: vec4f,
  // View-space distance along the view axis. The quad lies in a plane of constant view z.
  @location(3) @interpolate(flat) view_z: f32,
}

@vertex fn vs(
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position_size: vec4f,
  @location(1) velocity_param: vec4f,
  @location(2) color: vec4f,
) -> SpriteVarying {
  var out: SpriteVarying;
  let view_pos = (cam.view * vec4f(position_size.xyz, 1.0)).xyz;
  let view_z = -view_pos.z;
  let base_size = position_size.w * settings.size_scale;
  // Dead slots of a fixed-capacity buffer (size or alpha of 0) and sprites behind the eye are
  // moved outside the clip volume, so they cost four vertices and no pixels.
  if (base_size <= 0.0 || color.a <= 0.0 || view_z <= 0.0) {
    out.position = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }

  let pixels_per_unit = cam.proj[1][1] * cam.viewport.y * 0.5 / view_z;
  let sized = sprite_pixel_clamp(base_size, pixels_per_unit, settings.min_pixels);

  let view_velocity = (cam.view * vec4f(velocity_param.xyz, 0.0)).xyz;
  let screen_velocity = sprite_screen_velocity(view_pos, view_velocity);
  let ratio = sprite_stretch_ratio(screen_velocity, settings.stretch, settings.max_stretch);
  let corner = sprite_corner(vertex_index);
  let offset = sprite_stretch_offset(corner, screen_velocity, sized.x, ratio, settings.trail);

  out.position = cam.proj * vec4f(view_pos.xy + offset, view_pos.z, 1.0);
  out.p = corner;
  out.color = color;
  let radiance_scale = settings.intensity * sized.y * pow(ratio, -settings.stretch_dim);
  out.misc = vec4f(velocity_param.w, ratio, radiance_scale, sized.x);
  out.view_z = view_z;
  return out;
}

@fragment fn fs(in: SpriteVarying) -> @location(0) vec4f {
  var fade = sprite_near_fade(in.view_z, settings.near_fade.x, settings.near_fade.y);
  if (settings.depth_mode != 0u) {
    let depth = textureLoad(scene_depth, vec2i(in.position.xy), 0);
    let scene_z = camera_linear_depth(cam, depth);
    if (settings.depth_mode == 1u) {
      fade *= sprite_depth_fade(scene_z, in.view_z, 0.0);
    } else {
      // The fade distance can grow with the sprite: a spark and a glow puff need different ones.
      let reach = settings.fade_distance + settings.fade_scale * in.misc.w;
      fade *= sprite_depth_fade_contrast(scene_z, in.view_z, reach, settings.fade_contrast);
    }
  }
  if (fade <= 0.0) {
    return vec4f(0.0);
  }

  var s: SpriteSample;
  s.p = in.p;
  s.color = in.color;
  s.param = in.misc.x;
  s.shape = settings.shape;
  s.ratio = in.misc.y;
  s.user = settings.user;
  // Alpha is written as 0 and the blend state keeps the target's own alpha either way.
  return vec4f(max(shade_sprite(s), vec3f(0.0)) * (fade * in.misc.z), 0.0);
}
