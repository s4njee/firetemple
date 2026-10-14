// march.wgsl -- the ray march through the simulated fire, at reduced resolution (src/gpu/volume/reduced.ts),
// with the kernel in src/wgsl/volume.wgsl. Every step reads the four fields of fire3d.ts with one filtered
// 3D fetch (r temperature, g fuel, b smoke, a burn rate) and builds the medium there:
//
//   flame   hot gas glowing as a blackbody (fire-shade.wgsl), whitened toward its core (ramp_whiten) and
//           emitted in thermal equilibrium (volume_emitter_thermal): however thick, never brighter than
//           its temperature allows. How opaque it is follows the soot: a sooty wood flame is a bright,
//           nearly solid body, a clean gas flame a faint one.
//   blue    where fuel is burning right now, a faint blue emission (the chemiluminescence of a gas
//           flame's base), in proportion to the burn rate: the reaction zone the fields carry.
//   smoke   soot absorbing and scattering (smoke.wgsl), lit by the fire as measured by the light probe
//           (probe.wgsl) and self-shadowed by smoke.wgsl's one-tap gradient shadow toward it, plus a
//           dim sky.
//
// Empty samples (cool, clear air) skip all shading. The march stops at the scene depth of its own texel and
// at an early-out transmittance.

#include "fullscreen.wgsl"
#include "camera.wgsl"
#include "volume.wgsl"
#include "smoke.wgsl"
#include "ramp.wgsl"
#include "fire-shade.wgsl"
#include "march-params.wgsl"

struct FireLight {
  position: vec4f,
  color: vec4f,
}

@group(0) @binding(0) var<uniform> params: MarchParams;
@group(0) @binding(1) var<uniform> cam: Camera;
@group(0) @binding(2) var march_depth: texture_2d<f32>;
@group(0) @binding(3) var fields: texture_3d<f32>;
@group(0) @binding(4) var samp: sampler;
@group(0) @binding(5) var<storage, read> light: FireLight;

const BLUE = vec3f(0.12, 0.3, 1.0);

fn field_at(p: vec3f) -> vec4f {
  return textureSampleLevel(fields, samp, volume_to_uvw(p, params.box_min, params.box_max), 0.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv * params.uv_scale;
  let dir = camera_world_ray(cam, uv);
  let forward = -normalize(cam.inv_view[2].xyz);
  let scene_depth = textureLoad(march_depth, vec2i(in.position.xy), 0).r;

  var span = volume_ray_box(cam.position, dir, params.box_min, params.box_max);
  span = volume_clip_span(span, volume_depth_to_distance(scene_depth, dir, forward));
  if (!volume_hit(span)) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  let m = volume_march_length(span, params.step_length, params.max_steps, volume_jitter(in.position.xy, 0u));
  let fire_position = light.position.xyz;
  let fire_surface = light.color.rgb * params.fire_surface;
  let albedo = smoke_multi_albedo(smoke_albedo(params.soot));
  let sky = smoke_sky_light(params.sky, vec3f(1.0));
  var acc = volume_start();
  for (var i = 0; i < m.steps; i++) {
    let p = cam.position + dir * volume_march_t(m, i);
    let s = max(field_at(p), vec4f(0.0));
    if (s.r < 0.25 && s.b < 0.003 && s.a < 0.05) {
      continue;
    }
    var medium = volume_vacuum();
    if (s.r >= 0.25) {
      let radiance = ramp_whiten(fire3d_radiance(s.r) * params.brightness, params.whiten);
      let sigma = params.flame_opacity * smoothstep(0.25, 0.7, s.r);
      medium = volume_emitter_thermal(radiance, vec3f(sigma));
    }
    // Only where the gas is still cool enough not to be glowing yellow: the base of the reaction zone.
    if (s.a >= 0.05) {
      let base = 1.0 - smoothstep(0.7, 1.3, s.r);
      medium = volume_combine(medium, volume_emitter(BLUE * (params.blue * s.a * base), vec3f(0.0)));
    }
    if (s.b >= 0.003) {
      let sigma = smoke_extinction(s.b, params.smoke_extinction, params.soot);
      let to_fire = fire_position - p;
      let d = max(length(to_fire), 1e-3);
      let l = to_fire / d;
      let tap = 0.5 * d;
      let toward = max(field_at(p + l * tap).b, 0.0);
      let shadow = smoke_shadow_gradient(s.b, toward, tap, params.smoke_extinction, d);
      let direct = smoke_fire_light(fire_surface, d, params.fire_radius, vec3f(shadow));
      let phase = smoke_phase(smoke_cos_theta(l, dir), 0.35);
      medium = volume_combine(medium, VolumeMedium(smoke_in_scatter(sigma, albedo, direct, phase, sky), sigma));
    }
    acc = volume_accumulate_medium(acc, medium, m.ds);
    if (volume_opaque(acc, params.early_out)) {
      break;
    }
  }
  return volume_resolve(acc, params.early_out);
}
