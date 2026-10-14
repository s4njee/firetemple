// forest-land.wgsl -- the ground a forest-fire automaton grows on (src/gpu/sim/forest.ts).
//
// Nothing here is state: the land is a function of position read from the shared noise tile, so the
// step shader (per cell) and a display shader (per pixel) agree on where the lakes are without a
// texture of their own.
//
//   FOREST_LAND_SCALE                       noise cells per canvas height
//   forest_land(tex, smp, uv, aspect, terrain, offset) -> vec2f
//       x  how much fuel the ground can carry, 0..1: 0 in water, low on thin soil, 1 on good soil
//       y  water, 0..1 (a soft shoreline about a twentieth of a noise cell wide)
//       `uv` is canvas uv (top-left origin), `terrain` 0..1 is how much the land varies (0: good
//       soil everywhere, no water) and `offset` moves the map (one per seed). One fetch.
#include "noisetex.wgsl"

const FOREST_LAND_SCALE: f32 = 2.3;

fn forest_land(
  tex: texture_2d<f32>,
  smp: sampler,
  uv: vec2f,
  aspect: f32,
  terrain: f32,
  offset: vec2f,
) -> vec2f {
  let p = vec2f(uv.x * aspect, uv.y) * FOREST_LAND_SCALE + offset;
  let n = noisetex_sample(tex, smp, p);
  // The red channel is the height of the land: its low end is under water.
  let shore = 0.24 + 0.14 * terrain;
  let water = (1.0 - smoothstep(shore - 0.012, shore + 0.012, n.r)) * step(0.001, terrain);
  // The green channel is the soil: thin on the high ground, where little grows.
  let soil = smoothstep(0.26, 0.5, n.g + 0.25 * (0.75 - n.r));
  let capacity = mix(1.0, 0.3 + 0.7 * soil, terrain);
  return vec2f(capacity * (1.0 - water), water);
}
