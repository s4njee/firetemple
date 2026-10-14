// fire3d-react.wgsl -- the combustion step of the 3D fire (src/gpu/sim/fire3d.ts), run by the solver
// (fluid3d.ts) on its scalar field once per step, right after the field is advected.
//
// THE FIELD. One rgba16float texel per scalar cell:
//   r  T   temperature above ambient, in units of 1000 K (T = 1 is 1300 K over a 300 K room)
//   g  F   fuel: unburnt gas (wood volatiles, propane), dimensionless, 1 is "rich"
//   b  S   smoke: soot, dimensionless optical amount (the renderer turns it into extinction)
//   a  R   burn rate: fuel consumed per second in this cell during the last step
//
// ONE STEP of length dt, per texel, in this order:
//   1. sources   fuel injected where a source capsule is (logs, a burner), torn by a rising noise so the
//                flames come off in tongues; the bed (glowing logs, a pilot) holds T at a floor
//   2. reaction  above the ignition temperature fuel burns at `burn` per second (smoothly switched on over
//                `soft`):  burnt = F (1 - exp(-burn g(T) dt));  F -= burnt;  T += heat * burnt;
//                S += soot * burnt;  R = burnt / dt.  Exact for the step, so no rate can overshoot.
//   3. losses    T cools by convection-like loss growing with height, exp(-(cool + cool_height y) dt), and
//                by radiation, dT/dt = -radiate T^4, integrated exactly: T / cbrt(1 + 3 radiate dt T^3).
//                Smoke and leftover fuel thin out at their own rates; everything fades in a sponge layer
//                under the open top so nothing piles up against it.
//   4. storage   rounded stochastically to a half float (Apple GPUs truncate half-float writes, which would
//                bleed slow quantities away; see "Simulations" in docs/effect-authoring.md) and clamped:
//                0 <= T <= t_max, 0 <= F <= f_max, 0 <= S <= s_max, 0 <= R <= r_max, all finite.
//
// The solver reads the result for buoyancy (dot(buoyancyWeights, field): T lifts, S weighs) and for
// expansion (divergenceWeights on R): burning gas takes up room, which the pressure solve turns into
// outward flow.
//
// Bindings: 0 the step's uniforms (one buffer per step index, see fire3d.ts), 1 the advected field,
// 2 the next field (storage).

#include "noise.wgsl"
#include "hash.wgsl"
#include "fire3d-params.wgsl"

@group(0) @binding(0) var<uniform> R: Fire3dReact;
@group(0) @binding(1) var src: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;

// A value a half float holds exactly: v rounded up or down at random with the odds of its remainder
// (combust_quantise in combustion-step.wgsl, for the same reason). `u` is uniform in [0, 1).
fn fire3d_quantise(v: f32, u: f32) -> f32 {
  let exponent = max((bitcast<u32>(max(v, 0.0)) >> 23u) & 0xffu, 113u);
  let ulp = bitcast<f32>((exponent - 10u) << 23u);
  // Round up with probability equal to the remainder. Comparing u with the remainder, rather than
  // flooring v / ulp + u, keeps a value that is already a half float exactly where it is: the sum
  // rounds up to the next integer when u is within a float step of 1.
  let x = v / ulp;
  let below = floor(x);
  return (below + select(0.0, 1.0, u < x - below)) * ulp;
}

fn fire3d_finite(x: f32) -> f32 {
  return select(x, 0.0, (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u);
}

// Weight of the capsule a -> b (radius r) at p: a Gaussian of the distance to the segment.
fn fire3d_capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  let x = length(p - (a + ab * t)) / max(r, 1e-5);
  return select(0.0, exp(-x * x), x < 3.0);
}

@compute @workgroup_size(4, 4, 4)
fn cs_react(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= R.scalar_size)) {
    return;
  }
  let t = vec3i(id);
  let p = (vec3f(id) + 0.5) / vec3f(R.scalar_size) * R.size;   // length units, y up
  let c = textureLoad(src, t, 0);
  var temp = fire3d_finite(c.r);
  var fuel = fire3d_finite(c.g);
  var smoke = fire3d_finite(c.b);
  let dt = R.dt;

  // 1. Sources. The noise rises through the source so the fuel arrives in lumps, not as a steady sheet.
  var supply = 0.0;
  var bed = 0.0;
  for (var i = 0u; i < R.source_count; i++) {
    let a = R.source_a[i];
    let b = R.source_b[i];
    let w = fire3d_capsule(p, a.xyz, b.xyz, a.w);
    supply += w * b.w;
    bed = max(bed, w);
  }
  if (supply > 0.0 || bed > 0.0) {
    let q = p * R.noise_scale;
    let n = gnoise_3d(vec3f(q.x, q.y - R.time * R.noise_rise, q.z + R.time * 0.3));
    let lumps = clamp(0.55 + R.noise_amount * n, 0.0, 2.0);
    fuel += R.fuel_rate * supply * lumps * dt;
    temp = max(temp, R.bed_temperature * smoothstep(0.25, 0.8, bed) * (0.8 + 0.4 * n));
  }

  // 2. Reaction: fuel burns where it is hot enough.
  let gate = smoothstep(R.ignition, R.ignition + R.soft, temp);
  let burnt = fuel * (1.0 - exp(-R.burn * gate * dt));
  fuel -= burnt;
  temp += R.heat * burnt;
  smoke += R.soot * burnt;
  let rate = burnt / max(dt, 1e-6);

  // 3. Losses.
  let height = p.y / max(R.size.y, 1e-6);
  temp *= exp(-(R.cool + R.cool_height * height) * dt);
  temp /= pow(1.0 + 3.0 * R.radiate * dt * temp * temp * temp, 1.0 / 3.0);
  smoke *= exp(-R.smoke_decay * dt);
  fuel *= exp(-R.fuel_decay * dt);
  let sponge = exp(-R.sponge * smoothstep(1.0 - R.sponge_depth, 1.0, height) * dt);
  temp *= sponge;
  smoke *= sponge;
  fuel *= sponge;

  // 4. Storage.
  let u = ihash_3to3(vec3i(t.x + i32(R.seed) * 7919, t.y, t.z - i32(R.seed) * 104729));
  let out = vec4f(
    clamp(fire3d_quantise(fire3d_finite(temp), u.x), 0.0, R.t_max),
    clamp(fire3d_quantise(fire3d_finite(fuel), u.y), 0.0, R.f_max),
    clamp(fire3d_quantise(fire3d_finite(smoke), u.z), 0.0, R.s_max),
    clamp(fire3d_finite(rate), 0.0, R.r_max),
  );
  textureStore(dst, t, out);
}
