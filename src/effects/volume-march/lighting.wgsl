// Lights the opaque scene. The forward pass before it wrote flat albedo and depth (a tiny G-buffer);
// this pass rebuilds position and normal from the depth buffer and adds the night sky, the moon and
// the fire as a point light with a soft falloff. It exists so the test scene has something for the
// volume to sit in and against; the story is the march, not this.

#include "fullscreen.wgsl"
#include "camera.wgsl"
#include "noise.wgsl"
#include "light-params.wgsl"

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> light: LightParams;
@group(0) @binding(2) var albedo_tex: texture_2d<f32>;
@group(0) @binding(3) var depth_tex: texture_depth_2d;

const HORIZON = vec3f(0.016, 0.018, 0.028);
const ZENITH = vec3f(0.003, 0.004, 0.009);
const MOON_DIR = vec3f(-0.42, 0.78, -0.46);
const MOON = vec3f(0.035, 0.045, 0.075);

fn world_at(pixel: vec2i, depth: f32) -> vec3f {
  return camera_world_pos(cam, (vec2f(pixel) + vec2f(0.5)) / cam.viewport, depth);
}

// Shortest distance between the segment a0..a1 and the segment b0..b1.
fn segment_distance(a0: vec3f, a1: vec3f, b0: vec3f, b1: vec3f) -> f32 {
  let da = a1 - a0;
  let db = b1 - b0;
  let r = a0 - b0;
  let aa = dot(da, da);
  let bb = dot(db, db);
  let ab = dot(da, db);
  let ar = dot(da, r);
  let br = dot(db, r);
  let denom = max(aa * bb - ab * ab, 1e-6);
  var s = clamp((ab * br - ar * bb) / denom, 0.0, 1.0);
  let t = clamp((ab * s + br) / max(bb, 1e-6), 0.0, 1.0);
  s = clamp((ab * t - ar) / max(aa, 1e-6), 0.0, 1.0);
  return length(r + da * s - db * t);
}

// Soft shadow of an upright post: how far the path from p to the fire passes from the post's axis,
// against a penumbra that widens with distance behind the post (the fire is not a point).
fn post_shadow(p: vec3f, fire: vec3f, post: vec3f) -> f32 {
  let top = post + vec3f(0.0, light.post_height, 0.0);
  let miss = segment_distance(p, fire, post, top);
  let behind = length(p.xz - post.xz) / max(length(fire.xz - post.xz), 0.1);
  let penumbra = 0.02 + 0.16 * behind;
  return smoothstep(light.post_radius - penumbra * 0.5, light.post_radius + penumbra, miss);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let depth = textureLoad(depth_tex, pixel, 0);
  let view_dir = camera_world_ray(cam, in.uv);
  if (depth >= 1.0) {
    return vec4f(mix(HORIZON, ZENITH, smoothstep(0.0, 0.5, view_dir.y)), 1.0);
  }

  // Normal from depth: across each axis, difference toward the neighbour that is closer in depth,
  // so a silhouette does not bend the normal of the pixels beside it.
  let last = vec2i(textureDimensions(depth_tex)) - vec2i(1);
  let p = world_at(pixel, depth);
  let dl = textureLoad(depth_tex, max(pixel - vec2i(1, 0), vec2i(0)), 0);
  let dr = textureLoad(depth_tex, min(pixel + vec2i(1, 0), last), 0);
  let du = textureLoad(depth_tex, max(pixel - vec2i(0, 1), vec2i(0)), 0);
  let dd = textureLoad(depth_tex, min(pixel + vec2i(0, 1), last), 0);
  var across = world_at(pixel + vec2i(1, 0), dr) - p;
  if (abs(dl - depth) < abs(dr - depth)) {
    across = p - world_at(pixel - vec2i(1, 0), dl);
  }
  var down = world_at(pixel + vec2i(0, 1), dd) - p;
  if (abs(du - depth) < abs(dd - depth)) {
    down = p - world_at(pixel - vec2i(0, 1), du);
  }
  var n = normalize(cross(down, across));
  if (dot(n, view_dir) > 0.0) {
    n = -n;
  }

  // Albedo, mottled so large flat surfaces are not one flat colour, and scorched near the fire.
  let ring = length(p.xz);
  let mottle = 0.8 + 0.3 * gnoise_3d(p * 3.1) + 0.15 * gnoise_3d(p * 11.0);
  let scorch = mix(0.3, 1.0, smoothstep(0.35, 1.5, ring));
  let albedo = textureLoad(albedo_tex, pixel, 0).rgb * mottle * scorch;

  // The fire: a point light with a softened inverse-square falloff (the flame has a size), slightly
  // wrapped because it is a tall source, shadowed by the two posts.
  let to_fire = light.fire_position - p;
  let dist2 = dot(to_fire, to_fire);
  let l = to_fire * inverseSqrt(dist2);
  let wrap = max((dot(n, l) + 0.2) / 1.2, 0.0);
  let shadow = post_shadow(p, light.fire_position, vec3f(light.post_x, 0.0, 0.0))
    * post_shadow(p, light.fire_position, vec3f(-light.post_x, 0.0, 0.0));
  let fire = light.fire_color * (light.fire_intensity * wrap * shadow / (dist2 + 0.3));

  let sky = mix(HORIZON, ZENITH * 2.0 + HORIZON, n.y * 0.5 + 0.5) * 1.5;
  let moon = MOON * max(dot(n, normalize(MOON_DIR)), 0.0);
  var color = albedo * (sky + moon + fire);

  // An ember bed under the flame: hot, slowly crawling patches on whatever lies there.
  let embers = smoothstep(0.55, 0.05, ring) * smoothstep(0.5, 0.0, p.y);
  let crawl = 0.5 + 0.5 * gnoise_3d(vec3f(p.xz * 9.0, light.time * 0.35));
  color += vec3f(1.0, 0.2, 0.02) * (embers * crawl * crawl * 5.0 * light.fire_intensity / 3.0);

  // Distance haze hides the edge of the ground plane.
  let haze = 1.0 - exp(-length(p - cam.position) * 0.045);
  return vec4f(mix(color, HORIZON, haze), 1.0);
}
