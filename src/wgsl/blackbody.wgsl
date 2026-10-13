// blackbody.wgsl -- colour and brightness of a glowing body from its temperature in kelvin.
//
// Everything returns LINEAR Rec.709 / sRGB-primaries RGB, ready to write into the HDR scene target.
// Temperatures are `t` in kelvin. The colour routes are valid from BLACKBODY_T_MIN = 800 K (the
// first visible dull red, the Draper point) to BLACKBODY_T_MAX = 12000 K and clamp `t` to that range.
//
// Colour only ("chroma"): three routes to the same quantity, the Planckian colour scaled to relative
// luminance 1 (luminance(result) == 1), negative channels clipped to 0 before scaling. Below about
// 1900 K the true colour is more saturated than Rec.709 can show: blue clips to 0, and below about
// 950 K green does too, so the result is pure red (4.70, 0, 0) and only brightness varies.
//   blackbody_planck(t) -> vec3f
//       The reference. Planck's law integrated against the CIE 1931 colour-matching functions over
//       380-780 nm in BLACKBODY_PLANCK_STEPS = 80 midpoint samples (5 nm). About 800 exp per call:
//       for baking and for measuring the other two, not for a per-pixel loop.
//   blackbody_fit(t) -> vec3f
//       Two degree-5 polynomials in 1000/t (red and blue; green follows from luminance 1), fitted
//       here to blackbody_planck. No transcendentals, about 30 ALU ops. Error against the reference
//       over 800-12000 K, measured on the max-channel-1 form: max 0.0067 (1.7/255), mean 0.0027;
//       chromaticity max 0.0004 in CIE u'v' (a just-noticeable difference is about 0.001).
//   blackbody_lookup(lut, smp, t) -> vec3f
//       One bilinear fetch from a W x 1 `rgba16float` texture baked from the reference by
//       createBlackbodyLut (src/gpu/emission/blackbody-lut.ts). `smp` must be linear, clamp-to-edge.
//       The axis is linear in 1/t, which gives the red end most of the texels. Same error measure:
//       64 texels (512 bytes) max 0.0011 (0.3/255), mean 0.0004; 32 texels 0.0048; 16 texels 0.016;
//       beyond 128 texels only half-float rounding is left (0.0005). Do not go below 16: the range
//       above 5000 K then falls between two texels. A table baked `withIntensity` holds radiance.
//   blackbody_lut_coord(t) -> f32      the LUT axis: 0 at 800 K, 1 at 12000 K, linear in 1/t
//   blackbody_tint(t) -> vec3f         blackbody_fit rescaled so the largest channel is 1 (each
//                                      channel in 0..1): the form to multiply an existing colour by
//
// Brightness. Stefan-Boltzmann (total power ~ t^4) understates how fast a hot body brightens to the
// eye, and the true visible luminance is unusable as it stands: it rises by 5.8e7 between 800 K and
// 2000 K. Relative to 2000 K:
//       t (K)                    800      1000     1200     1500    2000   3000   6500    12000
//       physical luminance       1.7e-8   5.8e-6   3.0e-4   0.017   1      65     6600    46000
//       (t / 2000)^4             0.026    0.063    0.13     0.32    1      5.1    112     1296
//       tamed, gamma 0.4         0.0008   0.008    0.039    0.19    1      5.3    34      73
//   blackbody_log_luminance(t) -> f32
//       Natural log of the photometric luminance (the Y of blackbody_xyz) for any t > 0. A fit:
//       cubic in 1000/t on top of a single-wavelength Planck term; within 0.2% of the integral over
//       800-12000 K (max 0.14%), monotonic and finite everywhere (falls smoothly to black as
//       t -> 0, so cold cells of a simulation need no special case).
//   blackbody_luminance(t, t_ref) -> f32
//       Physical luminance relative to the body at t_ref: 1 at t == t_ref. 2 exp, 2 log.
//   blackbody_intensity(t, t_ref, gamma) -> f32
//       The tamed mapping: blackbody_luminance(t, t_ref) ^ gamma. gamma 1 is physical; gamma
//       BLACKBODY_GAMMA = 0.4 keeps the shape of the physical curve (steep at the red end, slower
//       above t_ref, black when cold) at 40% of its dynamic range in stops: a flame between 1000 K
//       and 2200 K spans about 200:1 instead of 540000:1, close to the contrast of the authored
//       ramps in ramp.wgsl. Lower gamma (0.25: 27:1) gives a flatter, thicker-looking flame. Not
//       clamped: it has no upper bound, so choose t_ref near the hottest temperature you expect.
//   blackbody_stefan(t, t_ref) -> f32  (t / t_ref)^4, for comparison and for total radiated power
//   blackbody_radiance(t, t_ref, gamma) -> vec3f
//       blackbody_fit(t) * blackbody_intensity(t, t_ref, gamma): luminance(result) is the intensity,
//       1 at t_ref. Multiply by the radiance you want at t_ref (flame bodies 3-15, see the authoring
//       guide). Below 800 K the colour stays at the 800 K red while the intensity keeps falling.
//
// Building blocks
//   blackbody_cmf(nm) -> vec3f         CIE 1931 2-degree x, y, z colour-matching functions at a
//                                      wavelength in nanometres (analytic fit, see below)
//   blackbody_xyz(t) -> vec3f          unnormalised CIE XYZ of the Planck spectrum (t clamped to
//                                      >= 400 K). Units are arbitrary but fixed: Y(2000 K) = 5.70e-3
//   blackbody_from_xyz(xyz) -> vec3f   XYZ to linear Rec.709, clipped at 0, scaled to luminance 1
//
// Accuracy of the reference itself. The colour-matching functions are the multi-lobe Gaussian fit of
// Wyman, Sloan and Shirley (JCGT 2013) plus two small far-red lobes added here. Without them the
// published fit underestimates x-bar beyond 660 nm (by half at 700 nm), which hardly matters for
// daylight but pulls every colour below 2000 K toward orange, exactly where fire lives: at 1000 K
// the chromaticity is off by 0.011 in x. With them the Planckian locus agrees with Krystek's (1985)
// independent fit of the tabulated locus to within 0.0007 in CIE xy from 1000 K to 12000 K.
// Planck's law uses c2 = 1.438777e-2 m K.
#include "color.wgsl"

const BLACKBODY_T_MIN: f32 = 800.0;
const BLACKBODY_T_MAX: f32 = 12000.0;
const BLACKBODY_PLANCK_STEPS: i32 = 80;
const BLACKBODY_GAMMA: f32 = 0.4;

// Second radiation constant hc/k in micrometre kelvin.
const _BLACKBODY_C2: f32 = 14387.77;
// 1000/t at the two ends of the valid range: the axis the fit and the LUT work in.
const _BLACKBODY_M_COLD: f32 = 1.25;
const _BLACKBODY_M_HOT: f32 = 0.0833333333;

// One asymmetric Gaussian lobe: standard deviation s_lo below the centre, s_hi above it.
fn _blackbody_lobe(x: f32, centre: f32, s_lo: f32, s_hi: f32) -> f32 {
  let d = (x - centre) / select(s_hi, s_lo, x < centre);
  return exp(-0.5 * d * d);
}

fn blackbody_cmf(nm: f32) -> vec3f {
  let x =
    1.056 * _blackbody_lobe(nm, 599.8, 37.9, 31.0) +
    0.362 * _blackbody_lobe(nm, 442.0, 16.0, 26.7) -
    0.065 * _blackbody_lobe(nm, 501.1, 20.4, 26.2) +
    0.0068 * _blackbody_lobe(nm, 681.8, 8.0, 26.7); // far-red correction (this file)
  let y =
    0.821 * _blackbody_lobe(nm, 568.8, 46.9, 40.5) +
    0.286 * _blackbody_lobe(nm, 530.9, 16.3, 31.1) -
    0.0039 * _blackbody_lobe(nm, 671.4, 8.0, 11.7); // far-red correction (this file)
  let z =
    1.217 * _blackbody_lobe(nm, 437.0, 11.8, 36.0) +
    0.681 * _blackbody_lobe(nm, 459.0, 26.0, 13.8);
  return vec3f(x, y, z);
}

fn blackbody_xyz(t: f32) -> vec3f {
  let kelvin = max(t, 400.0);
  let step_nm = 400.0 / f32(BLACKBODY_PLANCK_STEPS);
  var sum = vec3f(0.0);
  for (var i = 0; i < BLACKBODY_PLANCK_STEPS; i++) {
    let nm = 380.0 + (f32(i) + 0.5) * step_nm;
    let um = nm * 0.001;
    // Spectral radiance up to a constant: 1 / (lambda^5 (exp(c2 / (lambda t)) - 1)).
    let um2 = um * um;
    let planck = 1.0 / (um2 * um2 * um * (exp(min(_BLACKBODY_C2 / (um * kelvin), 80.0)) - 1.0));
    sum += planck * blackbody_cmf(nm);
  }
  return sum * step_nm;
}

fn blackbody_from_xyz(xyz: vec3f) -> vec3f {
  // CIE XYZ (D65 white) to linear Rec.709, written as rows.
  let rgb = vec3f(
    dot(xyz, vec3f(3.2404542, -1.5371385, -0.4985314)),
    dot(xyz, vec3f(-0.9692660, 1.8760108, 0.0415560)),
    dot(xyz, vec3f(0.0556434, -0.2040259, 1.0572252)),
  );
  let clipped = max(rgb, vec3f(0.0));
  return clipped / max(luminance(clipped), 1e-30);
}

fn blackbody_planck(t: f32) -> vec3f {
  return blackbody_from_xyz(blackbody_xyz(clamp(t, BLACKBODY_T_MIN, BLACKBODY_T_MAX)));
}

fn blackbody_fit(t: f32) -> vec3f {
  let m = 1000.0 / clamp(t, BLACKBODY_T_MIN, BLACKBODY_T_MAX);
  // Unclipped red and blue at luminance 1, least-squares fits to blackbody_planck over 800-12000 K.
  let r =
    0.6434261 + m * (1.67628 + m * (7.788649 + m * (-9.540567 + m * (5.157015 - m * 1.133003))));
  let b =
    2.477916 + m * (-12.89438 + m * (26.70504 + m * (-28.27291 + m * (15.14288 - m * 3.250489))));
  let g = (1.0 - 0.2126 * r - 0.0722 * b) / 0.7152;
  let clipped = max(vec3f(r, g, b), vec3f(0.0));
  return clipped / luminance(clipped);
}

fn blackbody_tint(t: f32) -> vec3f {
  let c = blackbody_fit(t);
  return c / max(c.r, max(c.g, c.b));
}

fn blackbody_lut_coord(t: f32) -> f32 {
  let m = 1000.0 / clamp(t, BLACKBODY_T_MIN, BLACKBODY_T_MAX);
  return (_BLACKBODY_M_COLD - m) / (_BLACKBODY_M_COLD - _BLACKBODY_M_HOT);
}

fn blackbody_lookup(lut: texture_2d<f32>, smp: sampler, t: f32) -> vec3f {
  // Texel centres sit at the ends of the axis, so the two end temperatures are stored exactly.
  let width = f32(textureDimensions(lut).x);
  let u = (blackbody_lut_coord(t) * (width - 1.0) + 0.5) / width;
  return textureSampleLevel(lut, smp, vec2f(u, 0.5), 0.0).rgb;
}

fn blackbody_log_luminance(t: f32) -> f32 {
  let m = 1000.0 / max(t, 1.0);
  // ln Y = cubic(m) - ln(exp(25.5 m) - 1); the last term is written so that it cannot overflow.
  let x = 25.5 * m;
  let log_expm1 = x + log(max(1.0 - exp(-x), 1e-30));
  return 7.64362 + m * (-1.00193 + m * (1.89476 - m * 0.264759)) - log_expm1;
}

fn blackbody_luminance(t: f32, t_ref: f32) -> f32 {
  return exp(blackbody_log_luminance(t) - blackbody_log_luminance(t_ref));
}

fn blackbody_intensity(t: f32, t_ref: f32, gamma: f32) -> f32 {
  return exp(gamma * (blackbody_log_luminance(t) - blackbody_log_luminance(t_ref)));
}

fn blackbody_stefan(t: f32, t_ref: f32) -> f32 {
  let x = max(t, 0.0) / t_ref;
  let x2 = x * x;
  return x2 * x2;
}

fn blackbody_radiance(t: f32, t_ref: f32, gamma: f32) -> vec3f {
  return blackbody_fit(t) * blackbody_intensity(t, t_ref, gamma);
}
