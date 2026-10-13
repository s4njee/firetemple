#include "fullscreen.wgsl"
#include "math.wgsl"
#include "fbm.wgsl"
#include "voronoi.wgsl"
#include "ground_params.wgsl"

// Bakes the page's surface once per resize: a flagstone floor as a height field. The light pass
// then reads one texel per pixel instead of evaluating any of this noise.
//
// Output (rgba16float, one texel per canvas pixel):
//   rg  gradient of the height in page space (dh/dx, dh/dy); height is in "relief units", the
//       light pass scales it by the relief depth, so the relief control needs no re-bake
//   b   shade: albedo multiplier (grout is darker, slabs differ)
//   a   per-slab random value in 0..1, for a slight hue difference between slabs

@group(0) @binding(0) var<uniform> bake: GroundParams;

/// Slabs per image height.
const SLABS: f32 = 4.2;

struct Ground {
  height: f32,
  shade: f32,
  slab: f32,
}

fn ground_at(p: vec2f) -> Ground {
  let q = p * (SLABS / bake.unit);
  // Bend the lattice a little so the joints are not ruler lines.
  let bent = q + 0.09 * vec2f(gnoise_2d(q * 1.3 + vec2f(11.0, 3.0)), gnoise_2d(q * 1.3 + vec2f(47.0, 29.0)));
  let v = voronoi_2d(bent, 0.82);
  let border = v.f2 - v.f1;
  // 0 in the joint between slabs, 1 on top of a slab, with a rounded shoulder.
  let top = smoothstep(0.015, 0.13, border);
  let dome = 0.86 + 0.14 * smoothstep(0.1, 0.55, border);
  // Each slab sits at its own level and leans its own way.
  let lean = rotate_2d(vec2f(1.0, 0.0), v.id * 41.0);
  let level = (v.id - 0.5) * 0.28 + dot(bent - v.site, lean) * 0.16;
  let worn = fbm_2d(q * 2.1 + vec2f(5.0), 4, 2.0, 0.5);
  let grain = fbm_2d(q * 9.0, 4, 2.0, 0.55);
  // Chips: sparse shallow pits where a mid-frequency noise peaks.
  let chips = smoothstep(0.32, 0.6, gnoise_2d(q * 5.3 + vec2f(1.7, 8.1)));

  var out: Ground;
  out.height = top * (0.8 * dome + level + 0.22 * worn - 0.09 * chips) + 0.1 * grain;
  out.shade = (0.5 + 0.5 * top) * (0.78 + 0.44 * v.id) * (1.0 + 0.3 * worn) * (1.0 - 0.12 * chips);
  out.slab = fract(v.id * 7.13);
  return out;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = in.uv * vec2f(bake.aspect, 1.0);
  let e = bake.texel;
  let here = ground_at(p);
  let dx = ground_at(p + vec2f(e, 0.0)).height - ground_at(p - vec2f(e, 0.0)).height;
  let dy = ground_at(p + vec2f(0.0, e)).height - ground_at(p - vec2f(0.0, e)).height;
  return vec4f(vec2f(dx, dy) / (2.0 * e), here.shade, here.slab);
}
