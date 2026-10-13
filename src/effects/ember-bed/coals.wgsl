// The coal layout, drawn ONCE into an rgba8unorm texture the size of the canvas (and again when
// the canvas, the coal size or the tilt changes). Nothing here moves, so the frame pass reads it
// back with one textureLoad instead of running two Voronoi searches per pixel per frame.
//
//   r  distance to the nearest gap between coals (f2 - f1 of the coal cells): 0 in the gap
//   g  a random number per coal
//   b  distance to the nearest fracture line in the coal's crust (a finer cell pattern)
//   a  a random number per crust plate
#include "fullscreen.wgsl"
#include "noise.wgsl"
#include "voronoi.wgsl"
#include "bed-space.wgsl"
#include "coal-params.wgsl"

@group(0) @binding(0) var<uniform> coal_params: CoalParams;

// Fracture cells per coal cell.
const COAL_PLATES: f32 = 4.2;

fn coal_at(uv: vec2f) -> vec4f {
  let bed = bed_point(uv, coal_params.aspect, coal_params.tilt);
  let p = bed.xy * coal_params.scale + vec2f(17.3, 5.1);
  // Bent, so the coals are lumps with curved sides and not a tiling of polygons.
  let bend = vec2f(gnoise_2d(p * 0.85 + vec2f(3.0, 0.0)), gnoise_2d(p * 0.85 + vec2f(0.0, 5.0)));
  let fine = vec2f(gnoise_2d(p * 3.7 + vec2f(1.0, 9.0)), gnoise_2d(p * 3.7 + vec2f(8.0, 2.0)));
  let coal = voronoi_2d(p + 0.3 * bend + 0.05 * fine, 0.9);
  // Each coal gets its own piece of the fracture pattern, so the lines stop at its edge.
  let plates = voronoi_2d(p * COAL_PLATES + 0.5 * bend + coal.id * 31.0, 1.0);
  return vec4f(
    clamp(coal.f2 - coal.f1, 0.0, 1.0),
    coal.id,
    clamp(plates.f2 - plates.f1, 0.0, 1.0),
    plates.id,
  );
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Distances are averaged over four taps (a rotated grid) so thin gaps far up a tilted bed do
  // not alias. The two random numbers must not be averaged: they come from the centre.
  let px = vec2f(coal_params.pixel / coal_params.aspect, coal_params.pixel);
  let centre = coal_at(in.uv);
  let taps =
    coal_at(in.uv + px * vec2f(0.125, 0.375)) +
    coal_at(in.uv + px * vec2f(-0.375, 0.125)) +
    coal_at(in.uv + px * vec2f(-0.125, -0.375)) +
    coal_at(in.uv + px * vec2f(0.375, -0.125));
  return vec4f(0.25 * taps.r, centre.g, 0.25 * taps.b, centre.a);
}
