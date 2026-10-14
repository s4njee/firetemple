// One step of the forest-fire automaton (src/gpu/sim/forest.ts). A render pass over the grid:
// reads the previous state with textureLoad, writes the next.
//
// State, one rgba16float texel per cell, every channel in 0..1:
//   r  fuel     how much there is to burn (tree density). Grows in quanta, by chance.
//   g  burning  how hard the cell burns. 0 when it does not.
//   b  scorch   freshly burnt ground; fades as growth returns
//   a  smoke    drifts downwind and thins
//
// The classic model (Drossel and Schwabl 1992) has three states and flips between them in one
// step. Here a burning cell eats its fuel over several steps:
//
//   eaten   = BURN * fuel * burning
//   fuel    = fuel - eaten
//   burning = burning * (1 - COOL) + eaten
//
// so the intensity rises while BURN * fuel > COOL, peaks, and decays geometrically once the fuel
// is gone: a pulse about fifteen steps long whose height depends on how much fuel there was. Below
// FOREST_CUTOFF it is set to exactly 0, so every fire ends. Thin fuel (under COOL / BURN) cannot
// sustain a fire at all, which is what makes young growth a firebreak.
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "ignite.wgsl"
#include "forest-land.wgsl"
#include "forest-step-params.wgsl"

@group(0) @binding(0) var<uniform> sim: ForestStep;
@group(0) @binding(1) var<uniform> ig: Igniters;
@group(0) @binding(2) var state_tex: texture_2d<f32>;
@group(0) @binding(3) var state_smp: sampler;
@group(0) @binding(4) var noise_tex: texture_2d<f32>;
@group(0) @binding(5) var noise_smp: sampler;

// Share of a burning cell's fuel eaten per step, per unit of intensity.
const FOREST_BURN: f32 = 1.5;
// Share of the intensity lost per step.
const FOREST_COOL: f32 = 0.25;
// Intensity a cell starts with when it catches.
const FOREST_SPARK: f32 = 0.1;
// Below this a fire is out.
const FOREST_CUTOFF: f32 = 0.012;
// Fuel below LO never catches; above HI it catches as readily as it can.
const FOREST_FLAMMABLE_LO: f32 = 0.6;
const FOREST_FLAMMABLE_HI: f32 = 0.95;
// Fuel grows in steps of this size.
const FOREST_QUANTUM: f32 = 0.1;
// Weight of a diagonal neighbour against an edge neighbour: measured, not derived. With edge
// neighbours alone a windless fire is a diamond, with all eight equal a square; this value makes
// it round (tests/epic5-d.test.ts measures it).
const FOREST_DIAGONAL: f32 = 0.42;

// How much full wind holds back spread across it, as a share of how much it holds back spread
// against it.
const FOREST_FLANK: f32 = 0.4;

fn forest_flammable(fuel: f32) -> f32 {
  return smoothstep(FOREST_FLAMMABLE_LO, FOREST_FLAMMABLE_HI, fuel);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let cell = vec2i(in.position.xy);
  let dims = vec2i(sim.size);
  let uv = (vec2f(cell) + 0.5) / sim.size;
  let old = textureLoad(state_tex, cell, 0);
  var fuel = old.r;
  var burning = old.g;
  var scorch = old.b;

  // Three random numbers per cell per step, repeatable from the seed.
  let random = to_unorm_3d(pcg_3d(vec3u(vec2u(cell), sim.step + sim.seed * 7919u)));
  let land = forest_land(noise_tex, noise_smp, uv, sim.aspect, sim.terrain, sim.land_offset);

  // --- Fire arriving from the neighbours ------------------------------------------------------
  // Each burning neighbour is an independent chance to catch; `miss` is the chance that none does.
  // `along` is +1 when the neighbour is straight upwind, so its fire is blown this way.
  var miss = 1.0;
  let reach = select(1, 2, sim.spot > 0.0);
  for (var dy = -reach; dy <= reach; dy++) {
    for (var dx = -reach; dx <= reach; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let q = cell + vec2i(dx, dy);
      if (any(q < vec2i(0)) || any(q >= dims)) { continue; }
      let theirs = textureLoad(state_tex, q, 0).g;
      if (theirs <= 0.0) { continue; }
      let offset = vec2f(f32(dx), f32(dy));
      let along = dot(-normalize(offset), sim.wind_dir);
      var weight = 0.0;
      if (max(abs(dx), abs(dy)) == 1) {
        // Wind: more likely from upwind, less from downwind, and a little less across it, so the
        // flanks of a wind-driven fire do not fan out.
        let bias = along * along * along - FOREST_FLANK * (1.0 - along * along);
        weight = select(1.0, FOREST_DIAGONAL, dx != 0 && dy != 0) * exp(sim.wind_gain * bias);
      } else {
        // Spotting: embers carried two cells, in a narrow cone downwind only.
        let cone = max(along, 0.0);
        let cone4 = cone * cone * cone * cone;
        let cone16 = cone4 * cone4 * cone4 * cone4;
        weight = sim.spot * cone16;
      }
      miss *= 1.0 - min(1.0, sim.spread * weight * theirs);
    }
  }

  // --- Burning ----------------------------------------------------------------------------------
  let eaten = min(fuel, FOREST_BURN * fuel * burning);
  fuel -= eaten;
  burning = min(1.0, burning * (1.0 - FOREST_COOL) + eaten);
  scorch = min(1.0, scorch + 1.6 * eaten);

  let flammable = forest_flammable(fuel);
  if (random.x < flammable * (1.0 - miss)) {
    burning = max(burning, FOREST_SPARK);
  }

  // --- Taps, drags and lightning -----------------------------------------------------------------
  var heat = 0.0;
  for (var i = 0u; i < ig.count; i++) {
    heat += ignite_one(uv, ig.aspect, ig.segments[i], ig.shapes[i]);
  }
  // They only catch where there is something to burn.
  if (heat > 0.08 && fuel > FOREST_FLAMMABLE_LO) {
    burning = max(burning, FOREST_SPARK * min(1.0, 0.5 + heat));
  }

  if (burning < FOREST_CUTOFF) { burning = 0.0; }

  // --- Growth -----------------------------------------------------------------------------------
  if (burning == 0.0) {
    // Scorched ground recovers first, then things grow on it.
    let bare = 1.0 - smoothstep(0.3, 0.9, scorch);
    let chance = sim.growth * bare / FOREST_QUANTUM;
    if (random.y < chance && fuel + 0.5 * FOREST_QUANTUM < land.x) {
      fuel = min(land.x, fuel + FOREST_QUANTUM);
    }
    scorch = max(0.0, scorch - 1.5 * sim.growth);
  }
  fuel = min(fuel, max(land.x, 0.0));

  // --- Smoke ------------------------------------------------------------------------------------
  // Carried downwind (a backward lookup, so any drift is stable), spread by four half-cell taps,
  // and thinned. The lookup wobbles with a slowly moving noise field so plumes meander.
  let texel = 1.0 / sim.size;
  let wobble = noisetex_sample(noise_tex, noise_smp, vec2f(uv.x * sim.aspect, uv.y) * 5.0 + sim.plume_phase).rg - 0.5;
  let source = uv - (sim.wind_dir * sim.plume_drift + wobble * sim.plume_wobble) * texel;
  let blur = 1.0 * texel;
  let plume_old = 0.25 * (
    textureSampleLevel(state_tex, state_smp, source + blur * vec2f(1.0, 1.0), 0.0).a +
    textureSampleLevel(state_tex, state_smp, source + blur * vec2f(-1.0, 1.0), 0.0).a +
    textureSampleLevel(state_tex, state_smp, source + blur * vec2f(1.0, -1.0), 0.0).a +
    textureSampleLevel(state_tex, state_smp, source + blur * vec2f(-1.0, -1.0), 0.0).a);
  // Nothing blows in from outside the map.
  let inside = step(0.0, source.x) * step(source.x, 1.0) * step(0.0, source.y) * step(source.y, 1.0);
  let smoke = clamp(plume_old * inside * sim.plume_keep + 0.22 * burning, 0.0, 1.0);

  return vec4f(clamp(fuel, 0.0, 1.0), burning, scorch, smoke);
}
