// Bakes the shared noise texture (src/gpu/emission/noise-texture.ts): four tileable noise fields
// in one target. Each channel is 0..1 with a mean of 0.5; see noisetex.wgsl for how to read them.
#include "fullscreen.wgsl"
#include "fbm.wgsl"

// Cells of the coarsest octave across the tile. Must match NOISETEX_CELLS in noisetex.wgsl.
const BAKE_CELLS: i32 = 8;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = in.uv * f32(BAKE_CELLS);
  let period = vec2i(BAKE_CELLS);
  // Any real offset keeps a tile function periodic, so offsets give independent fields.
  let a = fbm_2d_tile(p, period, 4, 0.5);
  let b = fbm_2d_tile(p + vec2f(37.3, 11.7), period, 4, 0.5);
  let fine = fbm_2d_tile(p * 2.0 + vec2f(5.1, 71.9), period * 2, 3, 0.55);
  let grain = 0.5 + 0.5 * vnoise_2d_tile(in.uv * 64.0 + vec2f(13.7, 3.1), vec2i(64));
  // The fractal sums are within about +-0.75 in practice; spread them over the unit range.
  return vec4f(
    clamp(0.5 + 0.65 * a, 0.0, 1.0),
    clamp(0.5 + 0.65 * b, 0.0, 1.0),
    clamp(0.5 + 0.65 * fine, 0.0, 1.0),
    grain,
  );
}
