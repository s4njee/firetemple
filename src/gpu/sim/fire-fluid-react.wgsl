// fire-fluid-react.wgsl -- the combustion step of the 2D fluid fire (src/gpu/sim/fire-fluid.ts), run as
// the solver's `hooks.dye` once per step, right after the dye has been advected (and cooled, and its soot
// thinned, by the solver's per-channel `dyeDissipation`).
//
// THE DYE. One rgba16float texel per dye cell (4 x finer than the velocity grid):
//   r  T   temperature above ambient (0 cold; a flame body is about 2-3, a core 4; see the display)
//   g  F   fuel: unburnt gas, dimensionless (1 is rich)
//   b  S   soot: optical amount of smoke
//   a  R   burn rate: fuel consumed per second here in the last step (the reaction zone)
//
// ONE STEP of length dt, per texel, in this order:
//   1. sources   fuel injected inside the burner capsules, lumpy by a rising noise so it comes off in
//                tongues; the burner (glowing logs, a pilot) holds T at a floor of `bed_temperature`.
//                Torches (pointer igniters) add fuel and hold T at `torch_heat`; embers only hold T.
//   2. reaction  above the ignition temperature fuel burns at `burn` per second, switched on smoothly
//                over `soft` and exactly zero at or below `ignition`:
//                    burnt = F (1 - exp(-burn g(T) dt));  F -= burnt;  T += heat burnt;  S += soot burnt
//                Exact for the step with g frozen, so no rate can burn more fuel than there is.
//   3. radiation dT/dt = -radiation T^4, integrated exactly: T / cbrt(1 + 3 radiation dt T^3). It caps
//                the hottest cores without touching the cool body (convective cooling is the solver's).
//   4. storage   rounded stochastically to an exact half float (Apple GPUs truncate half-float writes, so
//                slow changes would leak away; combust_quantise in combustion-step.wgsl) and clamped:
//                0 <= T <= t_max, 0 <= F <= f_max, 0 <= S <= s_max, 0 <= R <= r_max, all finite.
//
// Bindings: 0 the step's uniforms (one buffer per step of a frame), 1 torches, 2 embers (ignite.wgsl
// blocks), 3 the advected dye, 4 the new dye (storage), 5 + 6 the shared noise tile and its sampler.

#include "hash.wgsl"
#include "ignite.wgsl"
#include "noisetex.wgsl"
#include "fire-fluid-params.wgsl"

@group(0) @binding(0) var<uniform> F: FireFluidStep;
@group(0) @binding(1) var<uniform> torch: Igniters;
@group(0) @binding(2) var<uniform> embers: Igniters;
@group(0) @binding(3) var dye_src: texture_2d<f32>;
@group(0) @binding(4) var dye_dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var noise_tex: texture_2d<f32>;
@group(0) @binding(6) var noise_smp: sampler;

fn ff_finite(x: f32) -> f32 {
  return select(x, 0.0, (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u);
}

// v rounded up or down to a neighbouring half float at random, with the odds of the remainder. The
// remainder is compared with u rather than added to it: floor(v / ulp + u) rounds the sum to f32 first,
// so a u within 2^-14 of 1 would bump a value that is already a half float (combust_quantise has that
// flaw; harmless there, but here it lit fuel sitting exactly at the ignition temperature).
fn ff_quantise(v: f32, u: f32) -> f32 {
  let exponent = max((bitcast<u32>(max(v, 0.0)) >> 23u) & 0xffu, 113u);
  let ulp = bitcast<f32>((exponent - 10u) << 23u);
  let x = v / ulp;
  let below = floor(x);
  return (below + select(0.0, 1.0, u < x - below)) * ulp;
}

// Weight of the capsule a -> b (uv) of radius r (image heights) at p (uv): a Gaussian of the distance
// to the segment, measured in image heights, cut at three radii.
fn ff_capsule(p: vec2f, a: vec2f, b: vec2f, r: f32) -> f32 {
  let k = vec2f(F.aspect, 1.0);
  let pa = (p - a) * k;
  let ab = (b - a) * k;
  let t = clamp(dot(pa, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
  let x = length(pa - ab * t) / max(r, 1e-5);
  return select(0.0, exp(-x * x), x < 3.0);
}

@compute @workgroup_size(16, 16)
fn cs_react(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= F.dye_size)) {
    return;
  }
  let t = vec2i(id.xy);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(F.dye_size);
  let c = textureLoad(dye_src, t, 0);
  var temp = max(ff_finite(c.r), 0.0);
  var fuel = max(ff_finite(c.g), 0.0);
  var soot = max(ff_finite(c.b), 0.0);
  let dt = F.dt;

  // 1. Sources.
  var supply = 0.0;
  var bed = 0.0;
  for (var i = 0u; i < F.source_count; i++) {
    let a = F.source_a[i];
    let b = F.source_b[i];
    let w = ff_capsule(uv, a.xy, a.zw, b.x);
    supply += w * b.y;
    bed = max(bed, w * b.z);
  }
  if (supply > 0.0 || bed > 0.0) {
    // Lumps: the baked noise rising through the burner at `lump_rise` image heights a second, in cells
    // `lump_scale` image heights wide, so fuel arrives in tongues rather than as a steady sheet.
    let p = vec2f(uv.x * F.aspect, uv.y) / F.lump_scale;
    let n = noisetex_fbm2(noise_tex, noise_smp, p + vec2f(0.0, F.time * F.lump_rise / F.lump_scale));
    let lumps = clamp(1.0 + F.lumps * 1.6 * (n.x + 0.5 * n.y), 0.0, 2.5);
    fuel += F.fuel_rate * supply * lumps * dt;
    temp = max(temp, F.bed_temperature * smoothstep(0.3, 0.85, bed) * (0.85 + 0.3 * n.y));
  }
  for (var i = 0u; i < torch.count; i++) {
    let w = ignite_one(uv, torch.aspect, torch.segments[i], torch.shapes[i]);
    fuel += F.torch_fuel * w * dt;
    temp = max(temp, F.torch_heat * min(w, 1.0));
  }
  for (var i = 0u; i < embers.count; i++) {
    temp = max(temp, ignite_one(uv, embers.aspect, embers.segments[i], embers.shapes[i]));
  }

  // 2. Reaction.
  let gate = smoothstep(F.ignition, F.ignition + F.soft, temp);
  let burnt = fuel * (1.0 - exp(-F.burn * gate * dt));
  fuel -= burnt;
  temp += F.heat * burnt;
  soot += F.soot * burnt;
  let rate = burnt / max(dt, 1e-6);

  // 3. Radiation.
  temp /= pow(1.0 + 3.0 * F.radiation * dt * temp * temp * temp, 1.0 / 3.0);

  // 4. Storage. The hash differs every step (seed) and for every texel.
  let u = ihash_3to3(vec3i(t.x + i32(F.seed % 65536u) * 7919, t.y, i32(F.seed)));
  let out = vec4f(
    clamp(ff_quantise(ff_finite(temp), u.x), 0.0, F.t_max),
    clamp(ff_quantise(ff_finite(fuel), u.y), 0.0, F.f_max),
    clamp(ff_quantise(ff_finite(soot), u.z), 0.0, F.s_max),
    clamp(ff_finite(rate), 0.0, F.r_max),
  );
  textureStore(dye_dst, t, out);
}
