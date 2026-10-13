#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "params.wgsl"

// Hot air over a picture. One pass into the HDR scene target: the media texture (a photo, a video
// frame or the stand-in picture) read at coordinates nudged by a rising noise field, wherever a
// heat mask says the air is hot. No flame anywhere: this is the shimmer on its own.
//
// It is the shared haze chunk (src/wgsl/haze.wgsl) rebuilt on texture fetches. That chunk gets
// its offset from two evaluations of 3D gradient noise with derivatives, which is most of what
// the Epic 3 heat-haze scene costs; here the offset is two fetches of the shared baked noise tile
// and there is no procedural noise at all. What a pixel costs:
//   cold air                       1 media tap
//   hot air                        2 noise fetches + 1 media tap (3 with a colour split)
//   in a mirage pool (thin band)   + 1 noise fetch + 1 media tap

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var media_tex: texture_2d<f32>;
@group(0) @binding(2) var media_smp: sampler;
@group(0) @binding(3) var noise_tex: texture_2d<f32>;
@group(0) @binding(4) var noise_smp: sampler;

// Rising air smears into vertical streaks: the cells are this many times taller than wide, which
// makes the push mostly sideways. Vertical edges waver; horizontal ones barely move.
const HO_STRETCH: f32 = 3.0;
// Brings the typical push to about 0.4 of `strength` before it is squashed below 1.
const HO_GAIN: f32 = 1.7;
// The second layer: finer, and offset so its tile does not sit on the first one's.
const HO_FINE: f32 = 1.83;
const HO_FINE_WEIGHT: f32 = 0.8;
// Outside the picture when it is fitted with `contain`.
const HO_BARS = vec3f(0.0);

const HO_SHAPE_BAND: u32 = 0u;
const HO_SHAPE_PLUME: u32 = 1u;
const HO_SHAPE_FULL: u32 = 2u;

// How hot the air is at canvas uv, 0..1. `rel` is the height above the source line, in picture
// heights (negative below it).
fn ho_heat(uv: vec2f, rel: f32) -> f32 {
  if (params.shape == HO_SHAPE_FULL) {
    return 1.0;
  }
  let extent = max(params.extent, 1e-3);
  var f = 0.0;
  if (params.shape == HO_SHAPE_PLUME) {
    // A column that starts `width` wide at its source and spreads as it rises.
    if (rel <= 0.0 || rel >= extent) {
      return 0.0;
    }
    let k = rel / extent;
    let half = params.width * (0.5 + 1.6 * k);
    let aside = abs(uv.x - params.centre) * params.aspect;
    f = (1.0 - k) * (1.0 - smoothstep(0.3 * half, half, aside));
  } else {
    // A band lying on the source line: it reaches `extent` above the line and a third of that
    // below it (the air under a sight line that grazes hot ground).
    let reach = select(0.35 * extent, extent, rel >= 0.0);
    f = clamp(1.0 - abs(rel) / reach, 0.0, 1.0);
  }
  return f * f * (3.0 - 2.0 * f);
}

// The direction the air pushes the picture at p (canvas heights, y down): a smooth field with
// length below 1, mostly sideways, zero mean. Two fetches of the baked tile, at different scales
// and climbing at different speeds, so the pattern boils instead of sliding as one sheet.
fn ho_direction(p: vec2f) -> vec2f {
  let q = vec2f(p.x, p.y / HO_STRETCH) * params.scale;
  let coarse = textureSampleLevel(
    noise_tex,
    noise_smp,
    noisetex_uv(q + vec2f(0.0, params.rise.x)),
    params.noise_lod,
  ).rg;
  let fine = textureSampleLevel(
    noise_tex,
    noise_smp,
    noisetex_uv(q * HO_FINE + vec2f(2.7, 5.1 + params.rise.y)),
    params.noise_lod + 0.87,
  ).gr;
  let g = ((coarse - vec2f(0.5)) + (fine - vec2f(0.5)) * HO_FINE_WEIGHT) *
    vec2f(2.0, 2.0 / HO_STRETCH) * HO_GAIN;
  // Smooth saturation: same direction, length mapped from [0, inf) onto [0, 1).
  return g * inverseSqrt(1.0 + dot(g, g));
}

// The picture at canvas uv, fitted (cover or contain) and read `offset` (canvas uv) away, from the
// given mip level. Whether a pixel is on the picture or on the bars beside it is decided where
// the pixel IS, not where it reads from, and the sampler clamps: so the haze can never drag a bar
// into the picture or push the picture's edge out of the frame.
fn ho_picture(uv: vec2f, offset: vec2f, level: f32) -> vec3f {
  let m = (uv - vec2f(0.5)) * params.fit + vec2f(0.5);
  let texel = textureSampleLevel(media_tex, media_smp, m + offset * params.fit, level).rgb;
  let inside = all(m >= vec2f(0.0)) && all(m <= vec2f(1.0));
  return select(HO_BARS, texel, inside);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let rel = (1.0 - in.uv.y) - params.position;
  let heat = ho_heat(in.uv, rel);
  if (params.view == 1u) {
    return vec4f(vec3f(heat), 1.0);
  }
  if (heat <= 0.0) {
    // Cold air: the picture as it is, in one tap.
    return vec4f(ho_picture(in.uv, vec2f(0.0), params.media_lod), 1.0);
  }

  let p = in.uv * vec2f(params.aspect, 1.0);
  let offset = ho_direction(p) * (params.strength * heat) / vec2f(params.aspect, 1.0);
  // Heat squared: the softening belongs to the hottest air.
  let level = params.media_lod + params.blur * heat * heat;

  var color = ho_picture(in.uv, offset, level);
  if (params.chroma > 0.0) {
    // Red is pushed a little further and blue a little less: a faint fringe on edges. Not
    // physical (air barely disperses), but it reads as looking through something.
    color.r = ho_picture(in.uv, offset * (1.0 + params.chroma), level).r;
    color.b = ho_picture(in.uv, offset * (1.0 - params.chroma), level).b;
  }

  if (params.mirage > 0.0 && params.shape == HO_SHAPE_BAND && rel < 0.0) {
    // An inferior mirage: just below the line the hot ground shows the picture above it upside
    // down, in flat pools that thin out toward the viewer. That is the "water on the road".
    let depth = 0.35 * max(params.extent, 1e-3);
    let k = -rel / depth;
    if (k < 1.0) {
      let lie = textureSampleLevel(
        noise_tex,
        noise_smp,
        noisetex_uv(vec2f(p.x * 2.2 + 0.05 * params.rise.x, k * 0.9 + 0.11 * params.rise.y)),
        2.0,
      ).b;
      let pool = smoothstep(0.0, 0.1, lie - 0.34 - 0.3 * k) * (1.0 - k * k);
      let mirrored = vec2f(0.0, 2.0 * rel) + 2.5 * offset;
      color = mix(color, ho_picture(in.uv, mirrored, level + 1.0), params.mirage * pool);
    }
  }

  return vec4f(color, 1.0);
}
