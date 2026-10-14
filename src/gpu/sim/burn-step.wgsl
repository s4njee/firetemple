// One step of the burn-front solver (src/gpu/sim/burn.ts): a fire front crossing a fuel map.
//
// State, one rgba16float texel per cell:
//   r  fuel     1 = untouched, 0 = burnt through. Only ever falls while a cell burns; rises again
//               only while the cell regrows.
//   g  heat     0..1, the glow. Peaks where a cell is half burnt, then cools.
//   b  char     what the fire left: rises by exactly what the fuel lost, then crumbles away.
//   a  clock    > 0   seconds until the front arrives here (BURN_INF: nothing is on its way)
//               <= 0  the cell is alight, and this is minus its age in seconds
//               <= -BURN_CODE  burnt out; the value encodes WHEN it burnt out (see below)
//
// The front is not diffused heat. Every unlit cell works out when the fire will reach it from the
// clocks of its eight neighbours and the local travel time (cell size / speed), by solving the
// eikonal equation |grad T| = 1 / speed with the upwind scheme of the fast marching method, on
// the axis neighbours and again on the diagonal ones (the multistencil variant), taking the
// earlier answer. That is Huygens' principle on a grid: the front moves at the speed it is given,
// in every direction alike, and an irregular speed field bends it the way uneven paper does.
// Clocks are recomputed from the neighbours every step and never from the cell's own old value,
// so a change of speed takes effect at once and a front that is cut off stops.
//
// Map, one texel per cell (burn-map.wgsl): r signed distance to the nearest fuel in canvas
// heights (negative inside), g speed noise, b burn-rate noise, a crumble noise; noises in -1..1.
// A cell is FUEL where the distance is negative and a BRIDGE where it is positive but below half
// the jump distance. Bridges carry the front and burn nothing, so the fire crosses a gap exactly
// when the gap is narrower than the jump distance.
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "ignite.wgsl"
#include "burn-step-uniforms.wgsl"

@group(0) @binding(0) var<uniform> sim: BurnStep;
@group(0) @binding(1) var<uniform> ig: Igniters;
@group(0) @binding(2) var state_tex: texture_2d<f32>;
@group(0) @binding(3) var map_tex: texture_2d<f32>;
@group(0) @binding(4) var world_tex: texture_2d<f32>;

// "Never": no front is on its way. Anything above BURN_FAR counts as never.
const BURN_INF: f32 = 10000.0;
const BURN_FAR: f32 = 5000.0;
// A burnt-out cell stores -BURN_CODE * (1 + phase), where phase in [0, 1) is the simulation time
// at which it burnt out, as a share of a 128-second period. One octave of a half float holds 1024
// steps, so the time is kept to an eighth of a second for as long as it takes; counting seconds
// down in the same channel would stop working after 32 of them (the step is below half an ulp).
const BURN_CODE: f32 = 32.0;
// Ages stop here, safely short of the coded range.
const BURN_AGE_CAP: f32 = 24.0;
// A touch lights the cells where an igniter is at least this strong.
const BURN_LIGHT: f32 = 0.5;

// Rounds an amount of fuel or char to a half float at random, up or down in proportion to how
// near each neighbour is. Half floats near 1 are 1/2048 apart, and a slow burn or a long crumble
// takes steps not much bigger than that: rounded to nearest, a smooth rate becomes a staircase
// (contour rings in the char) and a rate below half a step never happens at all.
fn burn_round(value: f32, chance: f32) -> f32 {
  if (value <= 0.0) { return 0.0; }
  let ulp = exp2(floor(log2(value)) - 10.0);
  return value + (chance - 0.5) * 0.98 * ulp;
}

// A neighbour's clock as a place the fire can come from: a front on its way, or a cell that has
// been alight for less than `window` seconds. Burnt-out cells and the outside give nothing.
fn burn_source(c: vec2i, dims: vec2i) -> f32 {
  if (any(c < vec2i(0)) || any(c >= dims)) { return BURN_INF; }
  let v = textureLoad(state_tex, c, 0).a;
  return select(BURN_INF, v, v > -sim.window && v < BURN_FAR);
}

// Arrival time from two neighbours on perpendicular axes, `a` and `b`, with travel times `ta` and
// `tb` along them: the upwind solution of ((T - a) / ta)^2 + ((T - b) / tb)^2 = 1, falling back
// to the nearer neighbour alone where the two-sided solution does not exist or is not causal.
fn burn_arrival(a: f32, b: f32, ta: f32, tb: f32) -> f32 {
  let single = min(a + ta, b + tb);
  if (max(a, b) >= BURN_FAR) { return single; }
  // Relative to the earlier neighbour, so large clocks lose no precision.
  let base = min(a, b);
  let da = a - base;
  let db = b - base;
  let ia = 1.0 / (ta * ta);
  let ib = 1.0 / (tb * tb);
  let disc = ia + ib - ia * ib * (da - db) * (da - db);
  if (disc <= 0.0) { return single; }
  let t = (da * ia + db * ib + sqrt(disc)) / (ia + ib);
  return select(single, min(base + t, single), t >= max(da, db));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(state_tex));
  let c = vec2i(in.position.xy);
  let s = textureLoad(state_tex, c, 0);
  let m = textureLoad(map_tex, c, 0);
  let world = textureLoad(world_tex, vec2i(0), 0);
  var fuel = s.r;
  var heat = s.g;
  var charred = s.b;
  var clock = s.a;

  let solid = m.r < 0.0;
  let bridge = !solid && m.r < sim.bridge_reach;
  let was_lit = clock <= 0.0;

  if (!was_lit) {
    if (fuel < 1.0) {
      // Regrowing: fuel fades back in, what is left of the char fades out, and the cell cannot
      // light until it is whole again.
      fuel = min(fuel + sim.regrow_step, 1.0);
      charred = max(charred - sim.regrow_step, 0.0);
      clock = BURN_INF;
    } else if (solid || bridge) {
      // Local speed: the noise field for fuel, a fixed share of the speed across a gap.
      let factor = select(sim.bridge_speed, clamp(1.0 + sim.irregular * m.g, 0.3, 2.2), solid);
      let tau = clamp(sim.cell / (sim.speed * factor), sim.tau_min, sim.tau_max);
      // Fire climbs: coming from below it is `climb` times faster, from above as much slower.
      let tau_up = clamp(tau / sim.climb, sim.tau_min, sim.tau_max);
      let tau_down = clamp(tau * sim.climb, sim.tau_min, sim.tau_max);

      let west = burn_source(c + vec2i(-1, 0), dims);
      let east = burn_source(c + vec2i(1, 0), dims);
      let north = burn_source(c + vec2i(0, -1), dims);
      let south = burn_source(c + vec2i(0, 1), dims);
      let nw = burn_source(c + vec2i(-1, -1), dims);
      let ne = burn_source(c + vec2i(1, -1), dims);
      let sw = burn_source(c + vec2i(-1, 1), dims);
      let se = burn_source(c + vec2i(1, 1), dims);

      let side = min(west, east);
      // Axis stencil. uv grows downwards, so the southern neighbour is the one below.
      var arrival = min(burn_arrival(side, south, tau, tau_up), burn_arrival(side, north, tau, tau_down));
      // Diagonal steps on their own are always a valid (never early) path.
      arrival = min(arrival, min(sw, se) + sqrt(tau * tau + tau_up * tau_up));
      arrival = min(arrival, min(nw, ne) + sqrt(tau * tau + tau_down * tau_down));
      // The diagonal stencil, which is what takes the last few percent of grid bias out of a
      // round front. Its simple form only holds when the speed is the same in every direction.
      if (sim.isotropic > 0.5) {
        let d = tau * 1.41421356;
        arrival = min(arrival, burn_arrival(min(nw, se), min(ne, sw), d, d));
      }

      // Taps, drags and embers light what they touch at once.
      let uv = (vec2f(c) + 0.5) / vec2f(dims);
      var touch = 0.0;
      for (var i = 0u; i < ig.count; i++) {
        touch = max(touch, ignite_one(uv, ig.aspect, ig.segments[i], ig.shapes[i]));
      }
      if (touch >= BURN_LIGHT) { arrival = 0.0; }

      // The same instant, one step later.
      clock = select(BURN_INF, arrival - sim.dt, arrival < BURN_FAR);
    } else {
      clock = BURN_INF;
    }
  } else if (clock > -BURN_CODE) {
    clock = max(clock - sim.dt, -BURN_AGE_CAP);
    // Burnt through and too old to light a neighbour: remember when, and stop counting.
    if (fuel <= 0.0 && clock <= -sim.window) {
      clock = -BURN_CODE * (1.0 + sim.phase);
    }
  }

  if (was_lit) {
    // Burn: fuel becomes char at a rate the second noise field varies.
    let rate = sim.burn_rate * clamp(1.0 + 0.6 * sim.irregular * m.b, 0.4, 1.8);
    let burnt = min(fuel, rate * sim.dt);
    let chance = ihash_3to3(vec3i(c, i32(sim.tick)));
    if (burnt > 0.0) {
      fuel = burn_round(fuel - burnt, chance.x);
      charred = min(charred + burnt, 1.0);
    } else if (sim.crumble_rate > 0.0) {
      // Once nothing is left to burn the char falls away, unevenly.
      charred = burn_round(charred - sim.crumble_rate * sim.dt * (1.0 + 0.5 * m.a), chance.y);
    }

    // Regrowth. Everywhere at once when the whole map has been burnt out for long enough...
    var again = sim.regrow_all >= 0.0 && world.g + world.b >= sim.regrow_all;
    // ...or cell by cell, a fixed time after each one burnt out.
    if (clock <= -BURN_CODE && sim.regrow_each >= 0.0) {
      // Share of the period since it burnt out. The stored time is rounded to a half float and can
      // land a hair after now: only a clearly negative difference means the period wrapped.
      var since = sim.phase - (-clock / BURN_CODE - 1.0);
      if (since < -0.01) { since += 1.0; }
      again = again || since >= sim.regrow_each;
    }
    if (again && fuel <= 0.0) { clock = BURN_INF; }
  }

  // Glow: brightest where the cell is half burnt, which is the line between paper and char.
  let burning = was_lit && fuel > 0.0;
  let goal = select(0.0, 4.0 * fuel * (1.0 - fuel), burning);
  heat += (goal - heat) * select(sim.heat_fall, sim.heat_rise, goal > heat);

  return vec4f(fuel, max(heat, 0.0), charred, clock);
}
