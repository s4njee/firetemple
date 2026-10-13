// The procedural noise sources of the scrolling-noise flame, behind one call shape so the scene can
// swap them. The baked texture (noisetex_flame in noisetex.wgsl) is the fifth source and the
// default; it needs a texture binding, so it is called from scene.wgsl.
//
//   nf_fractal(kind, p, rise, octaves) -> f32     [-1, 1], zero mean
//       A fractal sum (lacunarity 2, gain 0.5) of one noise at p (noise cells, y up), scrolled
//       upward by `rise` cells. Octave i rises NF_SHEAR * i faster than octave 0, so fine detail
//       overtakes the large shapes and the pattern changes as it climbs instead of sliding as
//       one sheet. That is the classic cheap answer to "it looks like a scrolling texture", and
//       it keeps every source 2D.
//   nf_flame(kind, p, rise, octaves, warp) -> f32     [-1, 1], zero mean
//       The same construction as noisetex_flame, computed instead of fetched: nf_fractal looked
//       up at a position displaced by two more fractal sums that rise at 0.6 of the speed. Three
//       sums, so 3 x octaves noise evaluations. With warp = false it is nf_fractal alone, the
//       plain classic: a third of the price, and flatter (hills, where the warp makes tongues).
//   kind      NF_VALUE     value noise        4 hashed corners per octave
//             NF_SIMPLEX   simplex noise      3 corners per octave
//             NF_VORONOI   Voronoi F1         9 hashed sites per octave
//             NF_GRADIENT  gradient noise     4 corners per octave (anything else selects it)
//   octaves   clamped to [1, 6]
//
// Each source is scaled to the spread of the baked texture's flame noise (standard deviation
// NF_SPREAD at four octaves), so switching source changes the character of the flame and not how
// much of it there is. tests/epic4-a.test.ts measures that.
#include "noise.wgsl"
#include "simplex.wgsl"
#include "voronoi.wgsl"

const NF_TEXTURE: i32 = 0;
const NF_VALUE: i32 = 1;
const NF_SIMPLEX: i32 = 2;
const NF_VORONOI: i32 = 3;
const NF_GRADIENT: i32 = 4;

// Standard deviation every source is scaled to: that of noisetex_flame over the baked tile.
const NF_SPREAD: f32 = 0.214;
// The warp of nf_flame, in cells per unit of noise: noisetex_flame's 0.45, corrected for the
// spread of the channels it warps with (0.245 against NF_SPREAD).
const NF_WARP: f32 = 0.515;
// How much faster each finer octave rises than the one before it.
const NF_SHEAR: f32 = 0.3;

// Gains that bring a four-octave sum of each noise to NF_SPREAD, and the mean of Voronoi's F1
// (jitter 1), which unlike the lattice noises is not centred on zero.
const NF_GAIN_VALUE: f32 = 0.768;
const NF_GAIN_SIMPLEX: f32 = 0.648;
const NF_GAIN_VORONOI: f32 = 0.917;
const NF_GAIN_GRADIENT: f32 = 1.141;
const NF_VORONOI_MEAN: f32 = 0.428;

// One octave of the chosen noise, signed, nominally zero mean.
fn nf_octave(kind: i32, q: vec2f) -> f32 {
  switch kind {
    case 1 { return vnoise_2d(q); }
    case 2 { return snoise_2d(q); }
    // Bright at the cell's seed, dark on its border: round blobs with creases between them.
    case 3 { return (NF_VORONOI_MEAN - voronoi_2d(q, 1.0).f1) * 2.0; }
    default { return gnoise_2d(q); }
  }
}

fn nf_gain(kind: i32) -> f32 {
  switch kind {
    case 1 { return NF_GAIN_VALUE; }
    case 2 { return NF_GAIN_SIMPLEX; }
    case 3 { return NF_GAIN_VORONOI; }
    default { return NF_GAIN_GRADIENT; }
  }
}

fn nf_fractal(kind: i32, p: vec2f, rise: f32, octaves: i32) -> f32 {
  var sum = 0.0;
  var total = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  let count = clamp(octaves, 1, 6);
  for (var i = 0; i < count; i++) {
    let climb = rise * (1.0 + NF_SHEAR * f32(i));
    // A different offset per octave so their lattices never line up.
    let q = (p - vec2f(0.0, climb)) * frequency + vec2f(17.3, 5.9) * f32(i);
    sum += amplitude * nf_octave(kind, q);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return clamp(sum / total * nf_gain(kind), -1.0, 1.0);
}

fn nf_flame(kind: i32, p: vec2f, rise: f32, octaves: i32, warp: bool) -> f32 {
  var q = p;
  if (warp) {
    // The second layer: another part of the plane, a different scale, a slower climb.
    let w = p * 0.71 + vec2f(3.7, 0.0);
    q += NF_WARP * vec2f(
      nf_fractal(kind, w, 0.6 * rise, octaves),
      nf_fractal(kind, w + vec2f(31.4, 12.7), 0.6 * rise, octaves),
    );
  }
  return nf_fractal(kind, q, rise, octaves);
}
