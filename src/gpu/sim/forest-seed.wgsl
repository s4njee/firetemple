// The starting state of the forest-fire automaton (src/gpu/sim/forest.ts): a landscape that is
// already in the middle of its life, so the first frame is not a uniform green sheet waiting for
// lightning. Channels as in forest-step.wgsl: fuel, burning, scorch, smoke.
//
// start 0  landscape: fuel in patches of different ages, a few old burn scars, and a couple of
//           fires already under way (a ring of burning cells round a scorched middle)
// start 1  full: fuel 1 everywhere the land can carry it, nothing burning (for measurements)
// start 2  empty: nothing at all
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "forest-land.wgsl"
#include "forest-seed-params.wgsl"

@group(0) @binding(0) var<uniform> seed: ForestSeed;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

const FOREST_SEED_QUANTUM: f32 = 0.1;
const FOREST_SEED_FIRES: i32 = 3;
// Patches of the starting mosaic per canvas height.
const FOREST_SEED_PATCHES: f32 = 4.5;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let cell = vec2i(in.position.xy);
  let uv = (vec2f(cell) + 0.5) / seed.size;
  let land = forest_land(noise_tex, noise_smp, uv, seed.aspect, seed.terrain, seed.land_offset);
  if (seed.start == 2u) { return vec4f(0.0); }
  if (seed.start == 1u) { return vec4f(land.x, 0.0, 0.0, 0.0); }

  let random = to_unorm_3d(pcg_3d(vec3u(vec2u(cell), seed.seed * 7919u + 104729u)));
  // A mosaic of patches that last burnt at different times: cells of a grid whose lines are bent
  // by the noise tile, each with an age of its own between 0 (just burnt) and 1 (old growth).
  let p = vec2f(uv.x * seed.aspect, uv.y);
  let bend = noisetex_sample(noise_tex, noise_smp, p * 2.9 + seed.land_offset.yx + 3.1);
  let patch_id = vec2i(floor(p * FOREST_SEED_PATCHES + (bend.rg - 0.5) * 2.6 + (bend.b - 0.5) * 1.2));
  // Blended with the smooth noise, so a patch is not flat from edge to edge.
  let years = clamp(
    mix(ihash_2to1(patch_id + vec2i(i32(seed.seed) * 31, 17)), bend.b, 0.3) * 1.15 - 0.05,
    0.0,
    1.0,
  );
  // Fuel as a number of quanta drawn round the age of the patch, so neighbours differ.
  let quanta = floor(clamp(years * 11.0 - 0.8 + (random.x - 0.5) * 4.0, 0.0, 10.0) + 0.5);
  var fuel = min(land.x, quanta * FOREST_SEED_QUANTUM);
  var scorch = (1.0 - smoothstep(0.0, 0.22, years)) * (1.0 - land.y);
  var burning = 0.0;
  var smoke = 0.0;

  // Fires under way. Each is a disc of burnt ground with a burning rim, placed by the seed.
  for (var i = 0; i < FOREST_SEED_FIRES; i++) {
    let place = to_unorm_3d(pcg_3d(vec3u(u32(i) + 1u, seed.seed, 15485863u)));
    let centre = vec2f(0.15 + 0.7 * place.x, 0.2 + 0.6 * place.y) * seed.size;
    let radius = (0.035 + 0.045 * place.z) * min(seed.size.x, seed.size.y);
    // A ragged edge, so the fire does not start as a compass-drawn circle.
    let ragged = (bend.a - 0.5) * 0.5 * radius + (random.y - 0.5) * 1.5;
    let d = distance(vec2f(cell) + 0.5, centre) + ragged;
    if (d < radius - 1.0) {
      let depth = clamp((radius - d) / radius, 0.0, 1.0);
      fuel = min(fuel, floor(random.z * 3.0) * FOREST_SEED_QUANTUM);
      scorch = max(scorch, 0.7 + 0.3 * random.y - 0.2 * depth);
    } else if (d < radius + 1.0 && fuel > 0.65) {
      burning = 0.2 + 0.3 * random.z;
      fuel *= 0.5;
      scorch = 0.6;
      smoke = 0.15;
    }
  }
  return vec4f(fuel, burning, scorch, smoke);
}
