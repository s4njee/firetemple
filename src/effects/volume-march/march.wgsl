// The march: a campfire plume (an emissive flame and absorbing, scattering smoke in one medium)
// integrated front to back with the kernel in src/wgsl/volume.wgsl. Drawn at reduced resolution into
// the ReducedVolume target (src/gpu/volume/reduced.ts) as vec4f(radiance, transmittance); every ray
// stops at the scene depth of its own low-resolution texel.

#include "fullscreen.wgsl"
#include "camera.wgsl"
#include "hash.wgsl"
#include "fbm.wgsl"
#include "volume.wgsl"
#include "march-params.wgsl"

@group(0) @binding(0) var<uniform> params: MarchParams;
@group(0) @binding(1) var<uniform> cam: Camera;
@group(0) @binding(2) var march_depth: texture_2d<f32>;
@group(0) @binding(3) var blue_noise: texture_2d<f32>;

// The box the medium lives in, world units (about metres). The fire sits on the ground at the origin.
const BOX_MIN = vec3f(-2.0, 0.0, -2.0);
const BOX_MAX = vec3f(2.0, 4.6, 2.0);
const FIRE_CENTRE = vec3f(0.0, 0.5, 0.0);
// The pot hanging in the flame (index.ts places the mesh): the gas flows round it.
const POT_CENTRE = vec3f(0.0, 1.5, 0.0);
const POT_RADII = vec3f(0.31, 0.27, 0.31);
// Dim moonlit sky reaching the smoke from all sides; the isotropic phase function is folded in.
const SKY_LIGHT = vec3f(0.05, 0.065, 0.1);

// Flame colour for a temperature-like value in 0..1, as the radiance of an optically thick flame:
// deep red at the cool edge, orange body, pale yellow core. Local to this scene on purpose (the
// shared blackbody and ramp chunks belong to stories 3.1 and 3.2).
fn flame_radiance(temperature: f32) -> vec3f {
  let t = clamp(temperature, 0.0, 1.0);
  let ember = vec3f(1.0, 0.1, 0.01) * smoothstep(0.0, 0.3, t) * 2.5;
  let body = vec3f(1.0, 0.34, 0.045) * smoothstep(0.08, 0.6, t) * 10.0;
  let core = vec3f(1.0, 0.7, 0.28) * smoothstep(0.45, 1.0, t) * 28.0;
  return ember + body + core;
}

// What the medium is at world position p. Costs 2 noise evaluations for the sway, plus a 3-octave
// fbm where the flame can be and a 4-octave one where the smoke can be; empty space pays only the sway.
fn medium_at(p: vec3f) -> VolumeMedium {
  let h = p.y;
  let t = params.time;

  // The plume's axis wanders, more with height, and the wander travels upward with the gas.
  let s = vec3f(h * 0.75 - t * 1.0, t * 0.17, 0.0);
  let sway = vec2f(gnoise_3d(s), gnoise_3d(s + vec3f(0.0, 0.0, 9.7))) * (0.02 + 0.13 * h)
    + vec2f(params.wind * h * h * 0.05, 0.0);
  let q = p.xz - sway;
  let r = length(q);
  var medium = volume_vacuum();

  // Nothing burns inside the pot, and the medium thins out toward its surface. Without this the
  // densest part of the flame would end abruptly at the pot, and a ray that stops inside a steep
  // gradient shows its jitter as grain (see notes.md).
  let pot = length((p - POT_CENTRE) / POT_RADII) - 1.0;
  let clear = smoothstep(0.0, 0.55, pot);
  if (clear <= 0.0) {
    return medium;
  }
  // ...and the flame bulges around it instead.
  let bulge = 0.14 * exp(-pow((h - POT_CENTRE.y + 0.15) / 0.3, 2.0));

  // Flame: a teardrop that tapers to its tip, torn by noise that rises faster than the smoke and
  // grows stronger with height, so the base is a steady body and the top breaks into tongues.
  let flame_height = 1.85 * params.flame;
  let u = h / flame_height;
  if (u < 1.3 && r < 1.0) {
    let n = fbm_3d(vec3f(q.x * 3.2, h * 1.8 - t * 3.2, q.y * 3.2), 3, 2.0, 0.55);
    let radius = (0.44 * pow(max(1.0 - u, 0.0), 0.7) + bulge) * params.flame;
    // Signed depth into the flame, in units of its soft edge: 0 at the surface, growing inward.
    let shape = (radius - r) / 0.2 + n * (1.2 + 1.4 * u) - 0.1;
    let fade = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.9, 1.3, u));
    let heat = clamp(shape, 0.0, 1.0) * fade * clear;
    if (heat > 0.0) {
      // Hottest deep inside and low down; cooler and redder at the surface and toward the tips.
      let temperature = clamp(shape * 0.4, 0.0, 1.0) * mix(1.0, 0.5, clamp(u, 0.0, 1.0)) * fade;
      let sigma = vec3f(heat * 4.5);
      let radiance = flame_radiance(temperature) * (1.3 * params.intensity * params.flicker);
      medium = volume_emitter_thermal(radiance, sigma);
    }
  }

  // Smoke: starts where the flame gives out, widens and thins with height, lit warm from below by
  // the fire (falling off with distance, and dimmed by the smoke in between) and cool by the sky.
  let start = smoothstep(0.5, 1.15, u);
  if (start > 0.0 && params.smoke > 0.0) {
    let radius = 0.2 + 0.17 * h;
    let soft = 0.22 + 0.08 * h;
    if (r < radius + soft * 1.7) {
      let n = fbm_3d(vec3f(q.x * 1.7, h * 1.3 - t * 1.2, q.y * 1.7) + vec3f(3.7), 4, 2.0, 0.55);
      let shape = (radius - r) / soft + n * 2.2;
      let edge = max(abs(p.x), abs(p.z));
      let fade = (1.0 - smoothstep(3.4, 4.5, h)) * (1.0 - smoothstep(1.6, 1.95, edge));
      let density = smoothstep(0.0, 0.7, shape) * start * fade * clear * mix(1.0, 0.45, h / BOX_MAX.y);
      if (density > 0.0) {
        let to_fire = FIRE_CENTRE - p;
        let reach = exp(-max(h - flame_height, 0.0) * 0.7 * params.smoke);
        let power = 2.4 * params.intensity * params.flicker * params.flame * params.flame;
        let glow = vec3f(1.0, 0.42, 0.12) * (power * reach / (dot(to_fire, to_fire) + 1.1));
        // The thick of the plume sees less sky than its skin: a stand-in for self-shadowing.
        let sky = SKY_LIGHT * mix(1.0, 0.3, density);
        let sigma = vec3f(density * 4.5 * params.smoke);
        medium = volume_combine(medium, volume_scatterer(sigma, vec3f(0.45, 0.43, 0.41), sky + glow));
      }
    }
  }
  return medium;
}

// The start offset of the march inside its first step, by the method under comparison.
fn step_jitter(pixel: vec2f) -> f32 {
  var jitter = 0.5;
  switch (params.jitter_mode) {
    case 1u: { jitter = hash_2to1(floor(pixel)); }                         // white
    case 2u: { jitter = volume_jitter(pixel, 0u); }                         // interleaved gradient noise
    case 3u: { jitter = fract(dot(floor(pixel), vec2f(0.7548776662, 0.5698402910))); }  // R2 lattice
    case 4u: { jitter = volume_jitter_blue(blue_noise, pixel, 0u); }        // void-and-cluster texture
    default: { return 0.5; }                                                // none: the bands show
  }
  return volume_jitter_animate(jitter, params.frame);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // The march target can hang over the scene's right and bottom edge by part of a texel.
  let uv = in.uv * params.uv_scale;
  let dir = camera_world_ray(cam, uv);
  let forward = -normalize(cam.inv_view[2].xyz);
  let scene_depth = textureLoad(march_depth, vec2i(in.position.xy), 0).r;

  var span = volume_ray_box(cam.position, dir, BOX_MIN, BOX_MAX);
  span = volume_clip_span(span, volume_depth_to_distance(scene_depth, dir, forward));
  if (!volume_hit(span)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  let m = volume_march_length(span, params.step_length, params.max_steps, step_jitter(in.position.xy));
  var acc = volume_start();
  for (var i = 0; i < m.steps; i++) {
    let p = cam.position + dir * volume_march_t(m, i);
    acc = volume_accumulate_medium(acc, medium_at(p), m.ds);
    if (volume_opaque(acc, params.early_out)) {
      break;
    }
  }
  return volume_resolve(acc, params.early_out);
}
