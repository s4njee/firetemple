// particle-blending: the particle state, one compute invocation per slot. Stateless: every slot
// replays a fixed life cycle (a flame puff of FLAME_LIFE seconds or a smoke puff of SMOKE_LIFE)
// from its own phase, and each cycle's randomness is a hash of (slot, cycle), so a slot is a pool
// entry that is recycled as soon as its puff dies, exactly like a GPU particle system's, without
// any state to carry. Runs repeat, and the picture at a time does not depend on the frame rate.
//
// Writes, per slot:
//   positions[i]   xyz world position, w the puff's radius (0 = nothing to draw)
//   looks[2i]      rgb lit smoke colour (linear, not premultiplied), a peak opacity 0..1
//   looks[2i + 1]  rgb peak emission (linear radiance), a a per-puff random number for the shape
//
// Flame puffs start on a disc at the base, accelerate upwards, pull in towards the axis and cool
// along the blackbody curve from 2000 to 1150 K. Smoke puffs start above the flame (with a little
// glow left in them), rise fast then slowly, spread out, lean with a breeze, grow from 0.28 to
// about 1.5 units, and thin out as they grow. Smoke is lit by a dim sky from above and by the
// fire below, through smoke.wgsl's falloff from a disc-shaped source; there is no self-shadowing
// (the comparison is about blending, and every mode gets the same colours).

#include "hash.wgsl"
#include "blackbody.wgsl"
#include "smoke.wgsl"
#include "puff-params.wgsl"

@group(0) @binding(0) var<uniform> sim: PuffParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> looks: array<vec4f>;

const FLAME_LIFE: f32 = 1.0;
const SMOKE_LIFE: f32 = 7.0;
// Cycles hashed before the pattern repeats; the clock wraps at SMOKE_LIFE * CYCLES (a multiple of
// FLAME_LIFE too), so the wrap is seamless.
const CYCLES: u32 = 1024u;
const FIRE_CENTRE: vec3f = vec3f(0.0, 0.7, 0.0);

// Slots 0..13: a ring of fixed lights at radius 4.4 around the fire, alternately cool and warm,
// at heights from 0.5 to 5. Pure emitters (alpha 0), so they hide nothing but are hidden by smoke in
// front of them, which is the occlusion every mode has to get right. Seed -1 tells the draw to give
// them a plain round core.
fn lantern(i: u32) {
  let angle = f32(i) / 14.0 * TAU + 0.2;
  let height = 0.5 + f32((i * 5u) % 11u) * 0.45;
  let cool = (i & 1u) == 0u;
  let colour = select(vec3f(3.0, 2.2, 1.2), vec3f(1.1, 1.6, 3.2), cool);
  let on = i < sim.lanterns;
  positions[i] = vec4f(4.4 * cos(angle), height, 4.4 * sin(angle), select(0.0, 0.16, on));
  looks[2u * i] = vec4f(0.0);
  looks[2u * i + 1u] = vec4f(colour, -1.0);
}

@compute @workgroup_size(64)
fn puffs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.count) {
    return;
  }
  if (i < 14u) {
    lantern(i);
    return;
  }
  let h = pcg_1d(i * 0x9e3779b9u + 0x5bd1e995u);
  let flame = to_unorm_1d(h) < sim.flame_share;
  let life = select(SMOKE_LIFE, FLAME_LIFE, flame);
  let cycles = sim.time / life + to_unorm_1d(pcg_1d(h ^ 0x68e31da4u));
  let cycle = u32(floor(cycles)) % CYCLES;
  let u = fract(cycles);
  let t = u * life;
  let r = to_unorm_4d(pcg_4d(vec4u(i, cycle, 0x1b873593u, h)));
  let q = to_unorm_4d(pcg_4d(vec4u(cycle, i, h, 0xcc9e2d51u)));
  let seed = q.w;

  var position: vec3f;
  var radius: f32;
  var colour = vec3f(0.0);
  var alpha = 0.0;
  var emission = vec3f(0.0);

  // When this puff was born, on the wrapped clock: puffs born together move together, which is
  // what turns a uniform spray into tongues of flame and billows of smoke.
  let born = sim.time - t;

  if (flame) {
    let angle = r.x * TAU;
    let start = sqrt(r.y) * 0.45 * vec2f(cos(angle), sin(angle));
    let rise = (1.0 + 0.5 * r.z) * t + 0.9 * t * t;
    let lick = 0.16 * vec2f(sin(1.9 * born + 0.8 * sin(0.7 * born)), sin(1.3 * born + 2.0));
    let xz = start * (1.0 - 0.75 * u) + lick * u * u;
    position = vec3f(xz.x, 0.05 + rise, xz.y);
    radius = 0.19 * (0.75 + 0.5 * r.w) * (1.0 - 0.55 * u);
    let fade = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.45, 1.0, u));
    let kelvin = mix(2000.0, 1150.0, u);
    emission = blackbody_radiance(kelvin, 2000.0, BLACKBODY_GAMMA) * (1.1 * sim.fire * fade * sim.coverage);
    // A trace of soot: flames hide a little of what is behind them.
    alpha = 0.05 * fade;
    colour = vec3f(0.02, 0.015, 0.01);
  } else {
    // Billows: puffs born at the same time leave in a similar direction, which turns slowly.
    let gust = 0.5 * sin(0.31 * born) + 0.3 * sin(0.73 * born + 1.3) + 0.2 * sin(1.37 * born + 4.0);
    let billow = 0.45 * born + 1.7 * sin(0.21 * born);
    let angle = mix(r.x * TAU, billow, 0.55) + 0.2 * t;
    let direction = vec2f(cos(angle), sin(angle));
    let spread = 0.15 * sqrt(r.y) + 0.5 * sqrt(t) * (0.4 + r.w);
    let y0 = 1.35 + 0.35 * r.z;
    let y = y0 + 1.3 * 1.6 * (1.0 - exp(-t / 1.6)) + 0.3 * t;
    let wobble = 0.1 * vec2f(sin(0.9 * t + q.x * TAU), sin(0.7 * t + q.y * TAU));
    let source = 0.12 * vec2f(cos(0.9 * born), sin(1.1 * born));
    let lean = (sim.lean + 0.1 * gust) * (y - y0);
    let xz = source + direction * spread + wobble + vec2f(lean, 0.3 * lean * gust);
    position = vec3f(xz.x, y, xz.y);
    radius = (0.3 + 0.11 * t) * (0.75 + 0.5 * q.z);
    // Puffs fade in as they leave the flame, thin out as they grow, and fade away at the top.
    let fade = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.3, 1.0, u));
    let thinning = clamp(pow(0.45 / radius, 0.6), 0.3, 1.0);
    // The fire breathes: puffs born in a surge are dense, those in a lull thin, so the column
    // rises as billows with gaps between them rather than as one smooth cone.
    let surge = smoothstep(-0.4, 0.7, sin(1.3 * born + 2.0 * sin(0.37 * born)));
    let opacity = clamp(sim.smoke * fade * thinning * (0.25 + 0.75 * surge) * (0.7 + 0.6 * q.x), 0.0, 1.0);
    // The same coverage from more, smaller puffs: 1 - (1 - a)^coverage.
    alpha = 1.0 - pow(1.0 - min(opacity, 0.999), sim.coverage);
    // Lit by the sky and by the fire below.
    let albedo = smoke_albedo(sim.soot);
    let fire_colour = blackbody_radiance(1500.0, 2000.0, BLACKBODY_GAMMA) * (20.0 * sim.fire);
    let to_fire = distance(position, FIRE_CENTRE);
    let light = sim.sky * vec3f(0.62, 0.6, 0.6) + fire_colour * smoke_fire_falloff(to_fire, 0.6);
    colour = albedo * light * (0.75 + 0.5 * q.y);
    // What is left of the flame's heat in a new puff.
    let glow = 1.0 - smoothstep(0.0, 0.6, t);
    emission = blackbody_radiance(mix(1250.0, 900.0, t / 0.6), 2000.0, BLACKBODY_GAMMA) * (0.5 * sim.fire * glow * sim.coverage);
  }

  radius *= sim.size;
  // Puffs too faint to see are not drawn: the oldest are the biggest, and drawing them at an
  // opacity of a percent or two was a fifth of the fill for nothing visible.
  let visible = alpha > 0.015 * min(sim.coverage, 1.0) || max(emission.r, max(emission.g, emission.b)) > 0.01;
  positions[i] = vec4f(position, select(0.0, radius, visible));
  looks[2u * i] = vec4f(colour, alpha);
  looks[2u * i + 1u] = vec4f(emission, seed);
}
