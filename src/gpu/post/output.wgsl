// Final pass of the HDR chain: scene (+ bloom) -> exposure -> tonemap -> sRGB -> dither -> canvas.
#include "fullscreen.wgsl"
#include "color.wgsl"
#include "output-params.wgsl"

@group(0) @binding(0) var scene_tex: texture_2d<f32>;
@group(0) @binding(1) var bloom_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: OutputParams;

const TONEMAP_NONE = 0u;
const TONEMAP_ACES = 1u;
const TONEMAP_REINHARD = 2u;
const VIEW_FINAL = 0u;
const VIEW_SCENE = 1u;
const VIEW_BLOOM = 2u;
const ALPHA_OPAQUE = 0u;
const ALPHA_ADDITIVE = 1u;
const ALPHA_COVERAGE = 2u;
const ALPHA_LUMINANCE = 3u;

// The tonemap curve itself, not clamped for `none` so the HDR shoulder can continue past 1.
fn post_curve(c: vec3f, mode: u32) -> vec3f {
  if (mode == TONEMAP_ACES) { return tonemap_aces(c); }
  if (mode == TONEMAP_REINHARD) { return tonemap_reinhard(c); }
  return max(c, vec3f(0.0));
}

// Display-referred linear colour in [0, 1] for an SDR canvas.
fn post_map_sdr(c: vec3f, mode: u32) -> vec3f {
  return min(post_curve(c, mode), vec3f(1.0));
}

// Extended-range mapping for an HDR canvas. Up to scene value 1.0 (after exposure) it is exactly the
// SDR curve, so SDR content looks the same as it does on an SDR canvas. Above that, instead of
// clipping to 1 the curve keeps going with the slope the SDR curve had at 1.0 and rolls off
// smoothly (C1-continuous) towards `headroom`, in multiples of SDR white:
//   y(x) = f0 + d * slope / (1 + d * slope / (headroom - f0)),   d = x - 1
fn post_map_hdr(c: vec3f, mode: u32, headroom: f32) -> vec3f {
  let f0 = post_curve(vec3f(1.0), mode).x;
  let eps = 0.001;
  let slope = max((f0 - post_curve(vec3f(1.0 - eps), mode).x) / eps, 1e-3);
  // A headroom of 1 (or less) means "no HDR": the shoulder then tops out at SDR white.
  let room = max(max(headroom, 1.0) - f0, 1e-3);
  let d = max(c - vec3f(1.0), vec3f(0.0));
  let above = vec3f(f0) + d * slope / (vec3f(1.0) + d * slope / room);
  return select(above, post_map_sdr(c, mode), c <= vec3f(1.0));
}

// Interleaved gradient noise (Jimenez 2014): cheap, well distributed, no texture. Two evaluations
// at unrelated offsets summed give triangular-PDF noise in [-1, 1], which decorrelates the
// quantisation error from the signal (plain uniform noise leaves a little noise-modulated banding).
fn post_ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn post_dither(pixel: vec2f, frame: f32) -> f32 {
  let shift = vec2f(5.588238 * frame);
  return post_ign(pixel + shift) + post_ign(pixel.yx + vec2f(37.0, 91.0) + shift) - 1.0;
}

// Burn to white. The tonemap curves work per channel, so a very bright colour with an empty
// channel (flame orange has almost no blue) saturates to a pure secondary: (16, 12, 0) displays as
// lemon yellow however bright it gets. Film and eyes do the opposite: the hottest part of a flame
// goes white. This blends a colour toward a neutral of its own peak as that peak passes 2x paper
// white, complete by 16x. Colours at or below paper white are untouched.
fn post_whiten(c: vec3f, amount: f32) -> vec3f {
  let peak = max(c.r, max(c.g, c.b));
  let stops_over = log2(max(peak, 1e-4)) - 1.0;
  let w = amount * smoothstep(0.0, 3.0, stops_over);
  return mix(c, vec3f(peak), w);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let scene_texel = textureSampleLevel(scene_tex, samp, in.uv, 0.0);
  let scene = scene_texel.rgb;
  let glow = textureSampleLevel(bloom_tex, samp, in.uv, 0.0).rgb;

  var radiance = scene + glow;
  if (post.view == VIEW_SCENE) { radiance = scene; }
  if (post.view == VIEW_BLOOM) { radiance = glow; }

  let exposed = post_whiten(max(radiance, vec3f(0.0)) * post.exposure, post.whiten);
  var mapped = post_map_sdr(exposed, post.tonemap);
  if (post.hdr == 1u) { mapped = post_map_hdr(exposed, post.tonemap, post.headroom); }

  let encoded = linear_to_srgb(mapped);
  let noise = post_dither(in.position.xy, post.frame) * post.dither_lsb;
  if (post.alpha_mode == ALPHA_OPAQUE) {
    return vec4f(max(encoded + vec3f(noise), vec3f(0.0)), 1.0);
  }

  // See-through output for a premultiplied canvas: the page shows wherever alpha is below 1, and
  // the colour is added on top of it (the canvas blends as rgb + (1 - alpha) * page).
  let peak = max(encoded.r, max(encoded.g, encoded.b));
  // No dither where nothing is drawn: a fully transparent pixel must leave the page untouched.
  let grain = noise * smoothstep(0.0, 2.0 / 255.0, peak);
  let rgb = max(encoded + vec3f(grain), vec3f(0.0));

  var alpha = 0.0;
  if (post.alpha_mode == ALPHA_COVERAGE) { alpha = clamp(scene_texel.a, 0.0, 1.0); }
  if (post.alpha_mode == ALPHA_LUMINANCE) {
    // Taken from the colour that is actually written (dither included), so with a gain of 1 or
    // more no channel is ever above alpha: a valid premultiplied colour, whatever the browser
    // does with invalid ones.
    let written = max(rgb.r, max(rgb.g, rgb.b));
    alpha = clamp(max(scene_texel.a, written * post.alpha_gain), 0.0, 1.0);
  }

  // The underlay is a second, darker layer under the light: it dims the page around the fire,
  // using the bloom as a soft mask, so the flame stays the brightest thing on a page that is
  // already near white. `veil` is how much of the page it hides, at most `underlay`; the curve
  // lets it reach further out than the visible glow does. The two layers multiply (the page is
  // seen through both), so the underlay adds to every alpha mode instead of hiding behind it.
  let halo = linear_to_srgb(post_map_sdr(max(glow, vec3f(0.0)) * post.exposure, post.tonemap));
  let reach = 1.0 - clamp(max(halo.r, max(halo.g, halo.b)), 0.0, 1.0);
  let veil = clamp(post.underlay, 0.0, 1.0) * (1.0 - reach * reach * reach);
  alpha = 1.0 - (1.0 - alpha) * (1.0 - veil);
  return vec4f(rgb, alpha);
}
