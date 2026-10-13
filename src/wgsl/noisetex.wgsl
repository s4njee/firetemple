// noisetex.wgsl -- reading the shared baked noise texture instead of computing noise per pixel.
//
// Per-pixel procedural noise is what a fragment effect costs: four octaves of gradient noise is
// about 4 x 30 ALU operations and several hashes, and a warped flame wants ten or more of them.
// One bilinear fetch of a baked tile replaces a whole fractal sum. The tile comes from
// `getNoiseTexture(device)` in src/gpu/emission/noise-texture.ts (baked once per device, shared by
// every effect); bind its `view` and `sampler` and pass them in.
//
// The tile is 256 x 256 `rgba16float`, mipmapped, seamless in both directions (use the repeat
// sampler that comes with it). Channels, each 0..1 with mean 0.5:
//   r, g   two independent 4-octave fractal gradient noises, NOISETEX_CELLS cells across the tile
//   b      a finer 3-octave one, twice the frequency
//   a      single-octave value noise, 64 cells across: grain, sparkle, per-cell randomness
//
// Coordinates: `p` is in NOISE CELLS, the same unit as gnoise_2d / fbm_2d in noise.wgsl, so a
// procedural call can be swapped for a fetch without rescaling. The pattern repeats every
// NOISETEX_CELLS cells; hide that by sampling two layers at different scales or offsets
// (noisetex_flame does) rather than by scaling one layer up.
//
//   NOISETEX_CELLS                              8.0
//   noisetex_uv(p: vec2f) -> vec2f              cells -> texture coordinate
//   noisetex_sample(tex, smp, p) -> vec4f       all four channels, 0..1. One fetch.
//   noisetex_sample_lod(tex, smp, p, lod) -> vec4f   the same at an explicit mip level (0 = full detail)
//   noisetex_fbm(tex, smp, p) -> f32            [-1, 1], the r channel: a stand-in for fbm_2d(p, 4, 2, 0.5)
//   noisetex_fbm2(tex, smp, p) -> vec2f         [-1, 1] each, r and g: two fields in one fetch, for a warp
//   noisetex_flame(tex, smp, p, rise) -> f32    [-1, 1]. Two fetches: the coarse field scrolled by `rise`
//                                               (cells, upward = +y of p), displaced by a second layer
//                                               that rises at 0.6 of the speed, so features shear and
//                                               change instead of sliding as one sheet.
//
// Level of detail: the fetches use textureSampleLevel at level 0, so they are legal inside
// non-uniform control flow (after an early-out). Level 0 aliases into crawling jitter once one
// tile covers fewer than about 256 pixels (a small canvas, or a fine `p` scale): there, work out
// the level on the CPU as log2(256 / pixels per tile) and use noisetex_sample_lod. The other way,
// the tile is 32 texels per cell, so it goes soft once a cell is wider than about 300 pixels.
//
// Cost: one fetch per call (noisetex_flame: two), no arithmetic worth counting.

const NOISETEX_CELLS: f32 = 8.0;

fn noisetex_uv(p: vec2f) -> vec2f {
  return p / NOISETEX_CELLS;
}

fn noisetex_sample(tex: texture_2d<f32>, smp: sampler, p: vec2f) -> vec4f {
  return textureSampleLevel(tex, smp, noisetex_uv(p), 0.0);
}

fn noisetex_sample_lod(tex: texture_2d<f32>, smp: sampler, p: vec2f, lod: f32) -> vec4f {
  return textureSampleLevel(tex, smp, noisetex_uv(p), lod);
}

fn noisetex_fbm(tex: texture_2d<f32>, smp: sampler, p: vec2f) -> f32 {
  return noisetex_sample(tex, smp, p).r * 2.0 - 1.0;
}

fn noisetex_fbm2(tex: texture_2d<f32>, smp: sampler, p: vec2f) -> vec2f {
  return noisetex_sample(tex, smp, p).rg * 2.0 - 1.0;
}

fn noisetex_flame(tex: texture_2d<f32>, smp: sampler, p: vec2f, rise: f32) -> f32 {
  // The second layer: a different part of the tile, a different scale, a slower climb.
  let warp = noisetex_fbm2(tex, smp, p * 0.71 + vec2f(3.7, -0.6 * rise));
  let q = p + vec2f(0.0, -rise) + 0.45 * warp;
  let s = noisetex_sample(tex, smp, q);
  return clamp((s.r * 2.0 - 1.0) * 0.8 + (s.b * 2.0 - 1.0) * 0.35, -1.0, 1.0);
}
