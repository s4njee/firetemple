// lighting.wgsl -- lights the opaque scene (ground, logs or burner, stones) into the HDR target. The forward
// pass before it wrote flat albedo and depth; this pass rebuilds position and normal from the depth and
// adds a night sky, a faint moon and the fire as a point light whose colour, strength and position come
// from the light probe (probe.wgsl), i.e. from the simulation itself. Surfaces inside the fire's box also
// glow with the temperature of the gas against them, read straight from the fields: the logs' undersides
// and the ground under the flames are embers exactly where the simulated fire is hot.
//
// Bindings: 0 camera, 1 LightParams, 2 albedo, 3 depth, 4 the fire's fields, 5 a linear sampler, 6 the light.

#include "fullscreen.wgsl"
#include "camera.wgsl"
#include "noise.wgsl"
#include "fire-shade.wgsl"
#include "light-params.wgsl"

struct FireLight {
  position: vec4f,
  color: vec4f,
}

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> params: LightParams;
@group(0) @binding(2) var albedo_tex: texture_2d<f32>;
@group(0) @binding(3) var depth_tex: texture_depth_2d;
@group(0) @binding(4) var fields: texture_3d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<storage, read> light: FireLight;

const HORIZON = vec3f(0.016, 0.018, 0.028);
const ZENITH = vec3f(0.003, 0.004, 0.009);
const MOON_DIR = vec3f(-0.42, 0.78, -0.46);
const MOON = vec3f(0.035, 0.045, 0.075);

fn world_at(pixel: vec2i, depth: f32) -> vec3f {
  return camera_world_pos(cam, (vec2f(pixel) + vec2f(0.5)) / cam.viewport, depth);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let depth = textureLoad(depth_tex, pixel, 0);
  let view_dir = camera_world_ray(cam, in.uv);
  if (depth >= 1.0) {
    return vec4f(mix(HORIZON, ZENITH, smoothstep(0.0, 0.5, view_dir.y)), 1.0);
  }

  // Normal from depth: across each axis, difference toward the neighbour closer in depth, so a
  // silhouette does not bend the normal of the pixels beside it.
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
  let scorch = mix(0.35, 1.0, smoothstep(0.3, 1.2, ring));
  let albedo = textureLoad(albedo_tex, pixel, 0).rgb * mottle * scorch;

  // The fire as a point light with a softened inverse-square falloff (the flames have a size), wrapped a
  // little because it is a tall source.
  let to_fire = light.position.xyz - p;
  let dist2 = dot(to_fire, to_fire);
  let l = to_fire * inverseSqrt(max(dist2, 1e-6));
  let wrap = max((dot(n, l) + 0.25) / 1.25, 0.0);
  let fire = light.color.rgb * (params.fire_gain * wrap / (dist2 + params.fire_soft));

  let sky = mix(HORIZON, ZENITH * 2.0 + HORIZON, n.y * 0.5 + 0.5) * 1.5;
  let moon = MOON * max(dot(n, normalize(MOON_DIR)), 0.0);
  var color = albedo * (sky + moon + fire);

  // Embers: a surface inside the box glows with the gas against it, crawling slowly.
  let uvw = (p + n * params.ember_offset - params.box_min) / (params.box_max - params.box_min);
  if (all(uvw > vec3f(0.0)) && all(uvw < vec3f(1.0)) && p.y < params.ember_height) {
    let t = textureSampleLevel(fields, samp, uvw, 0.0).r;
    let crawl = 0.55 + 0.45 * gnoise_3d(vec3f(p.xz * 13.0, params.time * 0.3) + vec3f(p.y * 7.0));
    // Capped at a dull-orange heat: the gas against a surface can be flame-hot, the surface glows less.
    color += fire3d_radiance(min(t, params.ember_cap)) * (params.ember_gain * crawl * crawl);
  }

  // Distance haze hides the edge of the ground plane.
  let haze = 1.0 - exp(-length(p - cam.position) * 0.045);
  return vec4f(mix(color, HORIZON, haze), 1.0);
}
