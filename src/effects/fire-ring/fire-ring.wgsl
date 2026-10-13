#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "ring-math.wgsl"
#include "params.wgsl"

// A flame bent round a circle. One pass into the HDR scene target: linear radiance, alpha 0 (the
// tail turns brightness into alpha), and exactly nothing outside the flames' reach or in the
// middle of the ring, so the page shows through.
//
// The flame is a flame strip in polar coordinates: "along the strip" is the turn round the ring
// and "up" is the distance from the ring line. Its noise is read from the shared baked tile
// (two fetches); the tile repeats, so wrapping it a WHOLE number of times round the ring is what
// makes the full turn seamless (ring-math.wgsl).

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// A flame cell is this many times longer (away from the ring) than it is wide (round the ring).
const FR_STRETCH: f32 = 1.7;
// Fade at the leading end of a partly lit ring, in turns.
const FR_FEATHER: f32 = 0.03;
// The finest level of the noise tile the flames read: the finest octaves are left out, so the
// tongues are tongues and not fur.
const FR_SMOOTH_LOD: f32 = 1.0;
// Texels of the noise tile per noise cell (256 texels, 8 cells).
const FR_TEXELS_PER_CELL: f32 = 32.0;

fn fr_noise(uv: vec2f, lod: f32) -> vec4f {
  return textureSampleLevel(noise_tex, noise_smp, uv, lod);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = (in.uv - vec2f(0.5)) * params.to_ring * vec2f(1.0, -1.0);
  let r = length(p);
  let d = r - params.radius;

  // How far the picture reaches on each side of the ring line. Beyond it: nothing, no fetch.
  let margin = 3.0 * params.thickness + params.pixel;
  let reach_out = select(0.0, params.reach, params.side >= 0.0) + margin;
  let reach_in = select(0.0, params.reach, params.side <= 0.0) + margin;
  if (d > reach_out || r < 1e-5) {
    return vec4f(0.0);
  }

  let turn = ring_turn(p);
  let lit = ring_lit(turn, params.start, params.progress, FR_FEATHER, params.taper);

  var radiance = vec3f(0.0);

  // The faint glow inside: brightest against the ring, gone at the centre.
  if (d < 0.0) {
    let x = r / params.radius;
    let x2 = x * x;
    radiance = ramp_select(params.kind, 0.45) * (0.12 * params.inner * x2 * x2 * x2 * lit);
  }

  if (d > -reach_in) {
    // 0 on the ring line, 1 at the flame tips, negative on the side the flames do not go.
    let outward = select(abs(d), d * params.side, params.side != 0.0);
    let h = outward / params.reach;
    let up = max(h, 0.0);

    // One noise cell round the ring, in ring units, and the same cell in pixels at this radius.
    let cells = NOISETEX_CELLS * params.repeats;
    let cell = RING_TAU * params.radius / cells;
    let across = up * params.reach / (cell * FR_STRETCH * NOISETEX_CELLS);
    // The tile shrinks toward the centre: read a coarser level there instead of aliasing.
    let texels_per_pixel = FR_TEXELS_PER_CELL * params.pixel * cells / (RING_TAU * max(r, 0.02));
    let lod = max(log2(texels_per_pixel), FR_SMOOTH_LOD);

    // Layer two wraps one more time round the ring than layer one, so together they repeat only
    // once per full turn, and it climbs more slowly, so the flames shear instead of sliding.
    let lean = params.lean * up / NOISETEX_CELLS;
    let uv2 = ring_noise_uv(
      turn,
      across * 0.8 - params.rise.y / NOISETEX_CELLS,
      params.repeats + 1.0,
      params.rotation.y - 0.6 * lean,
    );
    let warp = fr_noise(uv2 + vec2f(0.37, 0.61), lod).rg * 2.0 - 1.0;
    let uv1 = ring_noise_uv(
      turn,
      across - params.rise.x / NOISETEX_CELLS,
      params.repeats,
      params.rotation.x - lean,
    );
    let s = fr_noise(uv1 + 0.45 * warp / NOISETEX_CELLS, lod);
    let n = clamp(((s.r * 2.0 - 1.0) * 0.8 + (s.b * 2.0 - 1.0) * 0.35) * 2.2, -1.0, 1.0);

    // Flames shorten toward the ends of a partly lit arc.
    let length_here = max(sqrt(lit), 1e-3);
    let t = up / length_here;
    let body = 1.0 - t;
    // The noise eats the flame, a little at the ring and more with height, so it ends in tongues.
    let eaten = params.roughness * (0.5 - 0.5 * n) * (0.35 + 1.2 * t);
    // What is left is the depth into the flame: 0 on its ragged edge, most at the foot of a
    // tongue. The edge is red, the body orange, and only the thick of a tongue goes yellow.
    let depth = clamp(body - eaten, 0.0, 1.0);
    let flame = smoothstep(0.0, 0.2, depth) * (0.25 + 0.42 * depth) * step(0.0, h);
    // The ring line itself: a hot band `thickness` wide that the flames grow from.
    let across_line = d / params.thickness;
    let line = exp(-across_line * across_line);
    let heat = max(flame, 0.92 * line) * smoothstep(0.0, 0.08, lit);
    radiance += ramp_select(params.kind, heat);

    // The unlit part of a progress ring: a dull track, so the eye can see how far there is to go.
    radiance += ramp_select(params.kind, 0.3) * (0.6 * params.track * (1.0 - lit) * line);
  }

  return vec4f(radiance * params.intensity, 0.0);
}
