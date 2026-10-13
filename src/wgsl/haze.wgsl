// haze.wgsl -- heat haze: hot air refracting whatever is behind it. A noise-driven offset for the
// texture coordinate of a backdrop, masked by a heat field, drifting upward, with optional colour
// fringing and softening where it is hottest.
//
// The model: hot air is a lumpy, rising field of slightly lower refractive index, and light bends
// along the GRADIENT of that field. So the offset here is the gradient of two octaves of gradient
// noise whose features are HAZE_STRETCH times taller than wide (rising air smears into vertical
// streaks). That makes the displacement mostly sideways and very nearly curl-free: edges waver,
// thin and thicken as through a weak moving lens; they do not swirl.
//
// Conventions
//  * `p` is the pixel's position in the BACKDROP'S uv orientation: y grows DOWNWARD, up is -y. Make
//    it isotropic first: `p = uv * vec2f(aspect, 1.0)`, so one unit is the height of the picture.
//  * `rise` is how far the air has travelled upward, in p units: accumulate `speed * delta` on
//    the CPU (0.2 to 1.0 heights per second reads as heat). The whole pattern is a function of
//    `p.y + rise`, exactly: haze_*(p, rise + d, ..) == haze_*(p + vec2f(0.0, d), rise, ..), i.e.
//    what is at a pixel now was `d` lower down a moment ago.
//  * `boil` is the phase of the churn in place, in noise cells: accumulate `rate * delta` (rate 1
//    to 3 per second). It stops the pattern reading as one sliding sheet. Any f32; a constant
//    freezes the churn.
//  * `heat` is the temperature mask, 0 = ambient air, 1 = hottest. It is clamped to [0, 1]. Where
//    it is 0 the offset is exactly zero, so the samplers return the backdrop untouched.
//  * `strength` is the largest displacement, in p units (so a fraction of the picture height); a
//    typical pixel moves 0.4 times as far. 0.002 to 0.004 is a hot road or a radiator, 0.006 a
//    furnace mouth. Real haze is small and fine.
//  * `scale` is the number of streaks per p unit across (25 to 80). Along y they are HAZE_STRETCH
//    times longer. Keep strength * scale below about 0.2: past that neighbouring pixels are thrown
//    past each other and the picture stops wavering and starts to look like frosted glass.
//  * Offsets come back in p units. If p was aspect-corrected, convert before adding to a uv:
//    `uv + offset / vec2f(aspect, 1.0)`.
//
// Constants
//   HAZE_STRETCH: f32 = 3.0        height / width of a streak
//
// The offset field
//   haze_direction(p: vec2f, rise: f32, boil: f32, scale: f32) -> vec2f
//       the refraction direction before masking: a smooth vector field with length < 1 (mean
//       0.42; four fifths of it between 0.16 and 0.69), x about HAZE_STRETCH times larger than y,
//       zero mean. Use it directly to weight the haze yourself, or to show the field.
//       2 gnoise_3d_d evaluations, no texture taps.
//   haze_offset(p: vec2f, rise: f32, boil: f32, heat: f32, strength: f32, scale: f32) -> vec2f
//       strength * clamp(heat, 0, 1) * haze_direction(..). Length < strength; exactly vec2f(0)
//       where heat <= 0 (and it skips the noise there). 2 gnoise_3d_d evaluations.
//
// Sampling the backdrop. `uv` is the undistorted texture coordinate and `offset` the displacement
// IN UV UNITS (see the aspect note above). All of them use textureSampleLevel, so they may be
// called from any control flow. The sampler's address mode decides what an offset does at the edge
// of the picture: use clamp-to-edge.
//   haze_sample(backdrop: texture_2d<f32>, samp: sampler, uv: vec2f, offset: vec2f) -> vec4f
//       the backdrop at uv + offset, mip 0. 1 tap.
//   haze_sample_chroma(backdrop, samp, uv: vec2f, offset: vec2f, split: f32) -> vec4f
//       red is displaced (1 + split) times as far and blue (1 - split) times; green and alpha are
//       the plain sample. split 0 is identical to haze_sample; 0.1 to 0.4 gives a faint fringe
//       on edges inside the haze. Not physical (air barely disperses) but it reads as "glassy".
//       3 taps.
//   haze_sample_soft(backdrop, samp, uv: vec2f, offset: vec2f, heat: f32, split: f32, blur: f32)
//       -> vec4f. haze_sample_chroma read from mip level blur * clamp(heat, 0, 1): `blur` is the
//       softening at full heat, in mip levels (0.5 to 2; each level doubles the blur radius). The
//       backdrop needs a mip chain and the sampler mipmapFilter 'linear'; without mips this is
//       haze_sample_chroma. At heat 0 it reads mip 0, so with the zero offset that haze_offset
//       gives there the unheated backdrop is unchanged. 3 taps.
//
// Cost: the offset is 2 gradient-noise evaluations with derivatives (about 3 plain gnoise_3d);
// the samplers are 1 or 3 bilinear/trilinear taps. No loops, and no branch but the early out.

#include "noise.wgsl"

const HAZE_STRETCH: f32 = 3.0;

// The second octave: finer and churning faster, shifted so its lattice does not sit on the first.
const _HAZE_FINE_FREQUENCY: f32 = 2.37;
const _HAZE_FINE_WEIGHT: f32 = 0.7;
const _HAZE_FINE_BOIL: f32 = 1.83;
const _HAZE_FINE_SHIFT = vec3f(17.3, 5.9, 41.7);
// Brings the summed gradient to a typical length of about 0.45 before it is squashed below 1.
const _HAZE_GAIN: f32 = 0.7;

fn haze_direction(p: vec2f, rise: f32, boil: f32, scale: f32) -> vec2f {
  let q = vec3f(p.x * scale, (p.y + rise) * scale / HAZE_STRETCH, boil);
  let coarse = gnoise_3d_d(q).yz;
  let fine = gnoise_3d_d(
    vec3f(q.xy * _HAZE_FINE_FREQUENCY, boil * _HAZE_FINE_BOIL) + _HAZE_FINE_SHIFT,
  ).yz;
  // Gradient in lattice units. Back in p the streaks are HAZE_STRETCH times longer along y, so
  // the index changes that much more slowly along y and bends light that much less.
  let g = (coarse + fine * _HAZE_FINE_WEIGHT) * vec2f(1.0, 1.0 / HAZE_STRETCH) * _HAZE_GAIN;
  // Smooth saturation: the direction is unchanged, the length maps [0, inf) onto [0, 1).
  return g * inverseSqrt(1.0 + dot(g, g));
}

fn haze_offset(p: vec2f, rise: f32, boil: f32, heat: f32, strength: f32, scale: f32) -> vec2f {
  if (heat <= 0.0) {
    return vec2f(0.0);
  }
  return haze_direction(p, rise, boil, scale) * (strength * min(heat, 1.0));
}

fn haze_sample(backdrop: texture_2d<f32>, samp: sampler, uv: vec2f, offset: vec2f) -> vec4f {
  return textureSampleLevel(backdrop, samp, uv + offset, 0.0);
}

fn _haze_sample_split(
  backdrop: texture_2d<f32>,
  samp: sampler,
  uv: vec2f,
  offset: vec2f,
  split: f32,
  level: f32,
) -> vec4f {
  let middle = textureSampleLevel(backdrop, samp, uv + offset, level);
  let red = textureSampleLevel(backdrop, samp, uv + offset * (1.0 + split), level).r;
  let blue = textureSampleLevel(backdrop, samp, uv + offset * (1.0 - split), level).b;
  return vec4f(red, middle.g, blue, middle.a);
}

fn haze_sample_chroma(
  backdrop: texture_2d<f32>,
  samp: sampler,
  uv: vec2f,
  offset: vec2f,
  split: f32,
) -> vec4f {
  return _haze_sample_split(backdrop, samp, uv, offset, split, 0.0);
}

fn haze_sample_soft(
  backdrop: texture_2d<f32>,
  samp: sampler,
  uv: vec2f,
  offset: vec2f,
  heat: f32,
  split: f32,
  blur: f32,
) -> vec4f {
  return _haze_sample_split(backdrop, samp, uv, offset, split, blur * clamp(heat, 0.0, 1.0));
}
