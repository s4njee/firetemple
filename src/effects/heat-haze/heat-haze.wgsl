#include "fullscreen.wgsl"
#include "haze.wgsl"
#include "fbm.wgsl"
#include "voronoi.wgsl"
#include "params.wgsl"

// One pass: the backdrop seen through rising hot air, with the thing that heats it drawn on top.
// Writes linear radiance into the HDR scene target. The backdrop is page content (at most 1.0);
// only the embers and the flames go above it.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var backdrop: texture_2d<f32>;
@group(0) @binding(2) var backdrop_sampler: sampler;

// Heights are fractions of the picture height, measured up from the bottom edge.
const HZ_BED_HEIGHT: f32 = 0.07;
const HZ_FLAME_HEIGHT: f32 = 0.19;

// Local stand-in for a blackbody ramp: red first, green as the square, blue as the fourth power,
// so it runs from dull red through orange to a pale yellow as `t` goes from 0 to about 1.5.
fn hz_glow(t: f32) -> vec3f {
  let x = max(t, 0.0);
  return vec3f(x, 0.36 * x * x, 0.07 * x * x * x * x);
}

// How hot the air is at `p` (y down, one unit = picture height), 0..1. `up` is the height above
// the top of the ember bed. Hottest just above the bed and gone by `extent`; higher up it breaks
// into columns that drift upward, each reaching a different height.
fn hz_heat(p: vec2f, up: f32) -> f32 {
  if (up >= params.extent) {
    return 0.0;
  }
  if (up <= 0.0) {
    return 1.0;
  }
  // Two octaves: where the columns stand, and the ragged edges that make them look like air.
  let q = vec3f(p.x * 4.2, (p.y + 0.6 * params.rise) * 0.9, 0.07 * params.boil);
  let column = gnoise_3d(q) + 0.45 * gnoise_3d(q * vec3f(2.3, 2.3, 1.7) + vec3f(7.7, 3.1, 5.3));
  let plume = smoothstep(-0.35, 0.5, column);
  let reach = params.extent * mix(1.0, 0.35 + 0.65 * plume, params.plumes);
  let f = clamp(1.0 - up / reach, 0.0, 1.0);
  // Just above the bed the air is hot everywhere; the gaps between columns open with height.
  let gaps = mix(1.0, plume, params.plumes * (1.0 - f * f));
  return f * sqrt(f) * gaps;
}

// The ember bed: lumps of coal, glowing where they touch and in slow patches. Returns radiance in
// rgb and coverage in a; `up` is negative inside the bed.
fn hz_embers(p: vec2f, up: f32) -> vec4f {
  // The lumpy top edge never rises more than 0.016 above the nominal one.
  if (up > 0.02) {
    return vec4f(0.0);
  }
  let lumps = 0.012 * gnoise_2d(vec2f(p.x * 14.0, 3.7)) + 0.004 * gnoise_2d(vec2f(p.x * 47.0, 9.1));
  let depth = lumps - up;
  if (depth <= 0.0) {
    return vec4f(0.0);
  }
  // Bent a little so the coals are lumps, not tiles.
  let bend = vec2f(gnoise_2d(p * 9.0 + vec2f(3.0, 0.0)), gnoise_2d(p * 9.0 + vec2f(0.0, 5.0)));
  let coal = voronoi_2d((p + 0.012 * bend) * vec2f(23.0, 31.0), 0.9);
  let crack = 1.0 - smoothstep(0.0, 0.16, coal.f2 - coal.f1);
  // Each coal breathes at its own slow rate; the whole bed never pulses together.
  let breath = 0.5 + 0.5 * sin(params.fire_time * (0.5 + 1.3 * coal.id) + coal.id * 40.0);
  let patches = 0.5 + 0.5 * gnoise_2d(vec2f(p.x * 5.0 + 0.11 * params.fire_time, p.y * 7.0));
  // Ash-grey faces, a few of them glowing through; the gaps between coals are where the heat is.
  let face = (0.08 + 0.55 * coal.id * coal.id * coal.id) * (0.5 + 0.5 * breath) * (0.35 + patches);
  let temperature = (face + 0.75 * crack * crack * (0.45 + 0.55 * patches)) *
    (0.75 + 0.45 * smoothstep(0.0, HZ_BED_HEIGHT, depth));
  let radiance = hz_glow(temperature) * (0.5 + 3.2 * temperature * temperature) +
    vec3f(0.006, 0.005, 0.005);
  return vec4f(radiance * params.fire, smoothstep(0.0, 0.004, depth));
}

// Low flames licking up from the bed: additive radiance.
fn hz_flames(p: vec2f, up: f32) -> vec3f {
  if (up > HZ_FLAME_HEIGHT || up < -0.03) {
    return vec3f(0.0);
  }
  let t = params.fire_time;
  let h = max(up, 0.0);
  // Tongues: tall where a slow noise along the bed says so, absent in between.
  let tongue = 0.5 + 0.5 * gnoise_2d(vec2f(p.x * 5.5 + 0.3 * sin(t * 0.7 + p.x * 3.0), t * 0.8));
  let height = HZ_FLAME_HEIGHT * (0.2 + 0.8 * tongue);
  let q = vec3f(p.x * 13.0 + 1.6 * h * sin(t * 2.1 + p.x * 9.0), (p.y + t * 0.5) * 7.0, t * 0.9);
  let n = 0.5 + 0.5 * fbm_3d(q, 3, 2.1, 0.55) * 1.4;
  // Signed "how far inside the flame": noise minus a height ramp, so tongues taper to points.
  let inside = (n * 1.5 - 0.3 - h / height) * smoothstep(-0.03, 0.0, up);
  // Cool red at the ragged edge, orange in the body, pale only in the thick of a tongue.
  let hot = clamp(inside / 0.85, 0.0, 1.0);
  let hot2 = hot * hot;
  let radiance = hz_glow(0.5 + 0.9 * hot) * 8.0 * hot2 +
    vec3f(1.0, 0.85, 0.6) * 8.0 * hot2 * hot2 * hot;
  return radiance * params.fire;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = in.uv * vec2f(params.aspect, 1.0);
  let up = 1.0 - HZ_BED_HEIGHT - in.uv.y;

  let heat = hz_heat(p, up);

  if (params.view == 1u) {
    return vec4f(vec3f(heat), 1.0);
  }
  if (params.view == 2u) {
    // The offset field before strength: red is sideways, green is vertical (magnified by
    // HAZE_STRETCH so it shows at all), flat grey is no offset.
    let direction = haze_direction(p, params.rise, params.boil, params.scale) * heat;
    let shown = clamp(0.5 + 0.5 * direction * vec2f(1.0, HAZE_STRETCH), vec2f(0.0), vec2f(1.0));
    return vec4f(vec3f(shown, 0.5) * 0.8, 1.0);
  }

  let embers = hz_embers(p, up);
  var behind = vec3f(0.0);
  if (heat <= 0.0) {
    // Cold air: the backdrop as it is, in one tap.
    behind = haze_sample(backdrop, backdrop_sampler, in.uv, vec2f(0.0)).rgb;
  } else if (embers.a < 1.0) {
    // (Nothing to refract where the coals hide the backdrop completely.)
    let offset = haze_offset(p, params.rise, params.boil, heat, params.strength, params.scale) /
      vec2f(params.aspect, 1.0);
    // Heat squared: the softening belongs to the hottest air, close to the source.
    behind = haze_sample_soft(
      backdrop,
      backdrop_sampler,
      in.uv,
      offset,
      heat * heat,
      params.chroma,
      params.blur,
    ).rgb;
  }
  let color = mix(behind, embers.rgb, embers.a) + hz_flames(p, up);
  return vec4f(color, 1.0);
}
