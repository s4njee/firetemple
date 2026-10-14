// One sub-step of the fuel-temperature combustion model (story 5.6). src/gpu/sim/combustion.ts
// drives it and explains the model; this is the arithmetic.
//
// State texel: r = temperature T above ambient (0 = cold, about 1 = everything burnt with no
// loss), g = fuel F, b = fuel capacity F0 (what F regrows to; laid once by combustion-lay.wgsl),
// a = the reaction rate of this sub-step as burnt / (k dt), for display and diagnostics.
//
//   dT/dt = D lap(T) + Q R - C T        dF/dt = -R + regrow F0 [cold, F < F0]        R = k F g(T)
//
// The step is split. Diffusion is explicit Euler, the only part with a stability limit
// (alpha = D dt / dx^2; the caller keeps it at or below 1/4). Reaction, cooling and regrowth are
// integrated exactly over dt with g frozen, so no value of k, C or regrow can overshoot: fuel
// never goes below 0 and never burns more than there is.
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "ignite.wgsl"
#include "combustion-step-params.wgsl"

@group(0) @binding(0) var<uniform> sim: CombustionStep;
@group(0) @binding(1) var<uniform> ig: Igniters;
@group(0) @binding(2) var state: texture_2d<f32>;

// Fuel regrows only on ground that has cooled: nothing between these temperatures and above.
const COMBUST_REGROW_COLD: f32 = 0.04;
const COMBUST_REGROW_HOT: f32 = 0.16;

// The walls are insulated: a neighbour outside the grid is the edge cell itself.
fn combust_t(p: vec2i, size: vec2i) -> f32 {
  return textureLoad(state, clamp(p, vec2i(0), size - vec2i(1)), 0).r;
}

// Half floats hold 11 bits. A change smaller than one unit in the last place (slow regrowth, weak
// cooling: anything below about 0.1 per second at 240 sub-steps a second) would be lost, and the
// value would either never move or, where the GPU truncates on writing a half float (Apple's
// does), drift down however it was dithered. So the rounding is done here, to a value a half
// float holds exactly: up or down at random with the odds given by the remainder, which is right
// on average whatever the hardware does afterwards. `u` is uniform in [0, 1).
fn combust_quantise(v: f32, u: f32) -> f32 {
  // The spacing of half floats around v: 2^(e - 10) in the binade [2^e, 2^(e+1)), and 2^-24
  // below 2^-14. Built from the exponent bits, so it is an exact power of two.
  let exponent = max((bitcast<u32>(max(v, 0.0)) >> 23u) & 0xffu, 113u);
  let ulp = bitcast<f32>((exponent - 10u) << 23u);
  return floor(v / ulp + u) * ulp;
}

// How fast fuel reacts at temperature t, as a multiple of k.
fn combust_gate(t: f32) -> f32 {
  if (sim.kinetics < 0.5) {
    // Ignition-temperature kinetics: exactly nothing below the threshold, everything above it.
    return smoothstep(sim.ignition, sim.ignition + sim.soft, t);
  }
  // Arrhenius: exp(-Ea / theta), scaled to 1 at the adiabatic flame temperature. theta is
  // absolute (ambient is theta0), so the cold rate is tiny but not zero.
  let theta = sim.theta0 + max(t, 0.0);
  return exp(min(sim.activation * (sim.inv_theta_b - 1.0 / theta), 30.0));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(state));
  let p = vec2i(in.position.xy);
  let c = textureLoad(state, p, 0);

  // Diffusion. The 9-point stencil [1 4 1; 4 -20 4; 1 4 1] / 6 has an error term that is the
  // same in every direction, so a front stays round; the 5-point one is kept for comparison.
  let edges = combust_t(p + vec2i(1, 0), size) + combust_t(p + vec2i(-1, 0), size)
            + combust_t(p + vec2i(0, 1), size) + combust_t(p + vec2i(0, -1), size);
  var lap = edges - 4.0 * c.r;
  if (sim.stencil > 0.5) {
    let corners = combust_t(p + vec2i(1, 1), size) + combust_t(p + vec2i(-1, 1), size)
                + combust_t(p + vec2i(1, -1), size) + combust_t(p + vec2i(-1, -1), size);
    lap = (4.0 * edges + corners - 20.0 * c.r) / 6.0;
  }
  var t = c.r + sim.alpha * lap;

  // Reaction: dF/dt = -k g F has the exact solution F exp(-k g dt).
  let burnt = c.g * (1.0 - exp(-sim.k_dt * combust_gate(t)));
  var f = c.g - burnt;
  // Heat release, then cooling toward ambient (again exact).
  t = (t + sim.release * burnt) * sim.cool;

  // Regrowth at a steady rate up to the capacity, on cold ground only: `regrow` is the share of
  // the capacity that returns in this sub-step, so bare ground is full again after 1 / regrow s.
  let cold = 1.0 - smoothstep(COMBUST_REGROW_COLD, COMBUST_REGROW_HOT, t);
  f = min(f + c.b * sim.regrow * cold, max(f, c.b));

  // Igniters hold what they touch at their own temperature: a hot contact, not an impulse, so a
  // pointer held still cannot pile heat up without limit.
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  var heat = 0.0;
  for (var i = 0u; i < ig.count; i++) {
    heat = max(heat, ignite_one(uv, ig.aspect, ig.segments[i], ig.shapes[i]));
  }
  t = max(t, heat);

  let u = ihash_3to3(vec3i(p, sim.seed));
  t = clamp(combust_quantise(t, u.x), 0.0, sim.t_max);
  f = clamp(combust_quantise(f, u.y), 0.0, 1.0);
  let rate = clamp(burnt / max(sim.k_dt, 1e-6), 0.0, 8.0);
  return vec4f(t, f, c.b, rate);
}
