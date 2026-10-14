#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

// Hot gas over a picture, driven by a fluid simulation. One pass into the HDR scene target: the
// picture (a photo, a video frame or a stand-in) read at coordinates the gas has bent.
//
// THE OPTICS. Air's refractive index falls as it warms, so a ray crossing hot gas bends toward the
// cooler side, along -grad T, by an amount that grows with the gradient. The temperature T is dye r of
// the solver (src/gpu/sim/fluid.ts): it is advected, stretched and folded by the flow, so the
// shimmer is carried along with the gas, curls where the gas curls and dies where it cools. The
// gradient is taken by central differences one dye texel apart (four bilinear taps), which keeps it
// continuous across texels; a hot blob then shrinks what is behind it (a weak diverging lens) and
// its edges ripple.
//
// DETAIL. The dye has about one texel per four canvas pixels at 1080p; below that the gas carries a
// noise pattern of its own, the baked tile read through a flow map: two layers, each advected by the
// fluid's local velocity for at most `period` seconds and then restarted elsewhere, cross-faded so
// one is always fresh (Vlachos's flow maps; Neyret's advected textures). It moves at the gas's own
// speed and direction instead of scrolling as one sheet, and it is weighted by the temperature.
//
// What a pixel costs:
//   cold air (T below `cold` everywhere in the 4 taps)    4 dye taps + 1 picture tap
//   hot air                                                + 1 fields tap + 2 noise fetches
//                                                          + 1 picture tap (3 with a colour split)
// The displacement is exactly zero in cold air, and never longer than `strength`.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var media_tex: texture_2d<f32>;
@group(0) @binding(2) var media_smp: sampler;
@group(0) @binding(3) var dye_tex: texture_2d<f32>;
@group(0) @binding(4) var lin_smp: sampler;
@group(0) @binding(5) var fields_tex: texture_2d<f32>;
@group(0) @binding(6) var noise_tex: texture_2d<f32>;
@group(0) @binding(7) var noise_smp: sampler;

const FH_VIEW_PICTURE: u32 = 0u;
const FH_VIEW_TEMPERATURE: u32 = 1u;
const FH_VIEW_DISPLACEMENT: u32 = 2u;
// Outside the picture when it is fitted with `contain`.
const FH_BARS = vec3f(0.0);

// The picture at canvas uv, fitted (cover or contain) and read `offset` (canvas uv) away. Whether a
// pixel is on the picture or on the bars is decided where the pixel IS, so the haze never drags a bar
// into the picture.
fn fh_picture(uv: vec2f, offset: vec2f, level: f32) -> vec3f {
  let m = (uv - vec2f(0.5)) * params.fit + vec2f(0.5);
  let texel = textureSampleLevel(media_tex, media_smp, m + offset * params.fit, level).rgb;
  let inside = all(m >= vec2f(0.0)) && all(m <= vec2f(1.0));
  return select(FH_BARS, texel, inside);
}

fn fh_temperature(uv: vec2f) -> f32 {
  return max(textureSampleLevel(dye_tex, lin_smp, uv, 0.0).r, 0.0);
}

// The flow-mapped noise: zero-mean, about unit length, moving with the gas velocity `v` (image
// heights per second) at p (image heights).
fn fh_flow_noise(p: vec2f, v: vec2f) -> vec2f {
  let q = p * params.scale;
  let a = textureSampleLevel(
    noise_tex,
    noise_smp,
    noisetex_uv(q - v * (params.flow.x * params.scale) + params.seeds.xy),
    params.noise_lod,
  ).rg;
  let b = textureSampleLevel(
    noise_tex,
    noise_smp,
    noisetex_uv(q - v * (params.flow.y * params.scale) + params.seeds.zw),
    params.noise_lod,
  ).rg;
  let wa = params.flow.z;
  let wb = 1.0 - wa;
  // Divided by the length of the weights so the cross-fade does not dim the pattern halfway.
  return ((a - vec2f(0.5)) * wa + (b - vec2f(0.5)) * wb) * (4.0 * inverseSqrt(wa * wa + wb * wb));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv;
  let dx = vec2f(params.dye_texel.x, 0.0);
  let dy = vec2f(0.0, params.dye_texel.y);
  let t_right = fh_temperature(uv + dx);
  let t_left = fh_temperature(uv - dx);
  let t_down = fh_temperature(uv + dy);
  let t_up = fh_temperature(uv - dy);
  let t = 0.25 * (t_right + t_left + t_down + t_up);
  // Exactly zero below `cold`, so the picture is untouched wherever the gas has cooled.
  let mask = smoothstep(params.cold, 4.0 * params.cold, t);

  var offset = vec2f(0.0);
  if (mask > 0.0) {
    // T per image height (x is stretched by the aspect in uv).
    let grad = vec2f(
      (t_right - t_left) / (2.0 * params.dye_texel.x * params.aspect),
      (t_down - t_up) / (2.0 * params.dye_texel.y),
    );
    let warmth = clamp(t / params.full, 0.0, 1.0);
    var g = -grad * params.gain;
    if (params.detail > 0.0) {
      let v = textureSampleLevel(fields_tex, lin_smp, uv, 0.0).xy;
      g += fh_flow_noise(uv * vec2f(params.aspect, 1.0), v) * (params.detail * warmth);
    }
    // Smooth saturation: same direction, length mapped from [0, inf) onto [0, 1).
    offset = g * inverseSqrt(1.0 + dot(g, g)) * (params.strength * mask);
  }

  if (params.view == FH_VIEW_TEMPERATURE) {
    let h = clamp(1.0 - exp(-t * 0.8), 0.0, 1.0);
    return vec4f(vec3f(0.02) + ramp_fire(h) * 0.25, 1.0);
  }
  if (params.view == FH_VIEW_DISPLACEMENT) {
    // 0.5 is no displacement; 0.25 per `strength`: the encoding a test can read back.
    let s = offset / max(params.strength, 1e-6);
    return vec4f(0.5 + 0.25 * s.x, 0.5 + 0.25 * s.y, mask, 1.0);
  }

  let uv_offset = offset / vec2f(params.aspect, 1.0);
  let heat = clamp(t / params.full, 0.0, 1.0);
  // Heat squared: the softening belongs to the hottest air.
  let level = params.media_lod + params.blur * heat * heat;
  var color = fh_picture(uv, uv_offset, select(params.media_lod, level, mask > 0.0));
  if (params.chroma > 0.0 && mask > 0.0) {
    // Red is pushed a little further and blue a little less: a faint fringe on edges in the haze.
    color.r = fh_picture(uv, uv_offset * (1.0 + params.chroma), level).r;
    color.b = fh_picture(uv, uv_offset * (1.0 - params.chroma), level).b;
  }
  // The faint source: the hottest gas glows a dull red.
  if (params.glow > 0.0) {
    let h = clamp(1.0 - exp(-t * params.glow_scale), 0.0, 1.0);
    color += ramp_fire(h) * params.glow;
  }
  return vec4f(color, 1.0);
}
