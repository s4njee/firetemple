// ramp.wgsl -- flame colour ramps: heat in 0..1 to LINEAR HDR radiance (Rec.709 primaries).
//
// `heat` is a shaped scalar, not a temperature: 0 is no flame, about 0.5 the body, 1 the hottest
// core. It is clamped to 0..1. Every ramp is exactly black at heat 0 and monotonic per channel, and
// returns scene radiance in the site's units (1.0 = paper white), so an effect can write the result
// straight into the HDR target or scale it by its own intensity. Never tonemap or sRGB-encode it.
// The peaks are chosen for the tail's per-channel ACES curve, which shows any channel above about 3
// as full: a colour keeps its hue only while its smaller channels are below 1. That is why the fire
// ramp can peak at 16 (its core is meant to go white) and the coloured flames stop at about 8.
//
// Authored ramps, as polynomials in heat (no pow, no texture; 5-8 multiplies each)
//   ramp_fire(heat) -> vec3f         wood and candle fire: black, deep red, orange, yellow, pale core.
//                                    (6.4 h^2 + 9.6 h^3, 12 h^6, 6 h^12); peak (16, 12, 6). Red by
//                                    heat 0.25, orange 0.5, yellow 0.75, white only above 0.9
//   ramp_gas(heat) -> vec3f          premixed gas flame (stove, torch, burner): dim violet-blue
//                                    mantle to an azure inner cone, never white. Peak (0.32, 1.6, 8)
//   ramp_tinted(heat, tint) -> vec3f a flame coloured by one emitter: constant hue `tint` (linear RGB,
//                                    largest channel 1, the others small) with the brightness curve
//                                    of ramp_fire's red channel, plus a little grey at the core.
//                                    Peak 8 * tint + 0.5. A line emitter does not change hue with
//                                    heat; the bright end pales in the tonemapper, as in a camera.
//   ramp_copper(heat)   ramp_sodium(heat)   ramp_potassium(heat)   ramp_lithium(heat)   -> vec3f
//                                    ramp_tinted with RAMP_TINT_COPPER (blue-green), RAMP_TINT_SODIUM
//                                    (the 589 nm amber-yellow), RAMP_TINT_POTASSIUM (lilac) and
//                                    RAMP_TINT_LITHIUM (crimson). Colours picked by eye from flame
//                                    tests, not derived from spectra.
//   ramp_select(kind, heat) -> vec3f one of the six above by number: RAMP_FIRE = 0, RAMP_GAS = 1,
//                                    RAMP_COPPER = 2, RAMP_SODIUM = 3, RAMP_POTASSIUM = 4,
//                                    RAMP_LITHIUM = 5 (anything else is fire). For a uniform-driven
//                                    choice; costs the selected ramp plus a switch.
//
// Physically based
//   ramp_blackbody(heat, t_cold, t_hot) -> vec3f
//       heat mapped linearly to a temperature between t_cold and t_hot (kelvin) and through
//       blackbody_radiance with the tamed intensity (gamma BLACKBODY_GAMMA), scaled so the
//       luminance at heat 1 is RAMP_BLACKBODY_PEAK = 12, like ramp_fire's. The first 0.15 of heat
//       fades to black, because a body at t_cold = 800 K still glows. Soot in a wood or candle flame
//       is roughly 1000-1900 K: at those temperatures the colour only runs from red to orange, and
//       the yellow-white of a real flame is the tonemapper (or the eye) saturating. About 40 ALU ops
//       and 3 exp/log.
//
// Highlights
//   ramp_whiten(color, knee) -> vec3f
//       Pulls bright colours toward grey of the same luminance: mix(color, luminance, w^2) with
//       w = L / (L + knee), so a quarter of the way at L = knee and never past grey. Radiance units;
//       knee 4-10 is useful, a huge knee is a no-op. This is the job of a camera or a filmic
//       tonemapper. The tail's ACES curve works per channel and has none of it, so a saturated
//       colour with a zero channel (any blackbody below 1900 K) ends at pure yellow (1, 1, 0) when
//       it is bright, where a real overexposed flame goes pale. The authored ramps have their pale
//       core built in and do not need it. 1 dot, 1 divide.
//
// Texture lookup
//   ramp_lookup(ramps, smp, heat, row) -> vec3f
//       One bilinear fetch from a W x R `rgba16float` texture holding one ramp per row, baked by
//       createRampTexture (src/gpu/emission/ramp-texture.ts) from any function or list of colour
//       stops. `smp` must be linear and clamp-to-edge; `row` is the ramp's index (0 for a
//       single-ramp texture). Texel centres sit at heat 0 and heat 1. Use it for gradients with no
//       tidy formula (bands, hand-placed stops) or to switch ramps at run time without a branch.
//       Baking error, worst channel, as shown by the tail (ACES then sRGB): ramp_fire in 64 texels
//       0.7/255, in 32 texels 2.7/255, in 16 texels 12/255. ramp_blackbody has kinks where it
//       leaves black and where the gamut clips, which linear filtering cannot follow: 11/255 at 64
//       texels, 1.7/255 at 256.
//
// Dependencies: blackbody.wgsl (ramp_blackbody), and color.wgsl through it (luminance).
#include "blackbody.wgsl"

const RAMP_FIRE: i32 = 0;
const RAMP_GAS: i32 = 1;
const RAMP_COPPER: i32 = 2;
const RAMP_SODIUM: i32 = 3;
const RAMP_POTASSIUM: i32 = 4;
const RAMP_LITHIUM: i32 = 5;

const RAMP_TINT_COPPER = vec3f(0.02, 1.0, 0.22);
const RAMP_TINT_SODIUM = vec3f(1.0, 0.42, 0.0);
const RAMP_TINT_POTASSIUM = vec3f(0.55, 0.12, 1.0);
const RAMP_TINT_LITHIUM = vec3f(1.0, 0.0, 0.07);

const RAMP_BLACKBODY_PEAK: f32 = 12.0;

// The brightness curve shared by the red channel of ramp_fire and by ramp_tinted: h^2 near black
// (a soft foot, no hard edge) steepening to h^3, 1 at heat 1.
fn _ramp_body(h: f32) -> f32 {
  return h * h * (0.4 + 0.6 * h);
}

fn ramp_fire(heat: f32) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let h2 = h * h;
  let h6 = h2 * h2 * h2;
  return vec3f(16.0 * _ramp_body(h), 12.0 * h6, 6.0 * h6 * h6);
}

fn ramp_gas(heat: f32) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let h2 = h * h;
  let h4 = h2 * h2;
  // A little red at the cool end makes the mantle violet; green arrives late and turns the cone
  // azure. The red term still rises all the way to heat 1 (its slope there is 0.16).
  return vec3f(0.8 * h2 * (1.0 - 0.6 * h), 1.6 * h4, 8.0 * _ramp_body(h));
}

fn ramp_tinted(heat: f32, tint: vec3f) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let h2 = h * h;
  return 8.0 * _ramp_body(h) * tint + vec3f(0.5 * h2 * h2 * h2);
}

fn ramp_copper(heat: f32) -> vec3f {
  return ramp_tinted(heat, RAMP_TINT_COPPER);
}

fn ramp_sodium(heat: f32) -> vec3f {
  return ramp_tinted(heat, RAMP_TINT_SODIUM);
}

fn ramp_potassium(heat: f32) -> vec3f {
  return ramp_tinted(heat, RAMP_TINT_POTASSIUM);
}

fn ramp_lithium(heat: f32) -> vec3f {
  return ramp_tinted(heat, RAMP_TINT_LITHIUM);
}

fn ramp_select(kind: i32, heat: f32) -> vec3f {
  switch kind {
    case 1 { return ramp_gas(heat); }
    case 2 { return ramp_copper(heat); }
    case 3 { return ramp_sodium(heat); }
    case 4 { return ramp_potassium(heat); }
    case 5 { return ramp_lithium(heat); }
    default { return ramp_fire(heat); }
  }
}

fn ramp_blackbody(heat: f32, t_cold: f32, t_hot: f32) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let radiance = blackbody_radiance(mix(t_cold, t_hot, h), t_hot, BLACKBODY_GAMMA);
  return radiance * (RAMP_BLACKBODY_PEAK * smoothstep(0.0, 0.15, h));
}

fn ramp_whiten(color: vec3f, knee: f32) -> vec3f {
  let l = luminance(color);
  let w = l / (l + max(knee, 1e-6));
  return mix(color, vec3f(l), w * w);
}

fn ramp_lookup(ramps: texture_2d<f32>, smp: sampler, heat: f32, row: i32) -> vec3f {
  let size = vec2f(textureDimensions(ramps));
  let uv = vec2f(
    (clamp(heat, 0.0, 1.0) * (size.x - 1.0) + 0.5) / size.x,
    (f32(row) + 0.5) / size.y,
  );
  return textureSampleLevel(ramps, smp, uv, 0.0).rgb;
}
