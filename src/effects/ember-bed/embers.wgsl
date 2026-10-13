// The ember bed, one pass: a coal layout read from the baked texture, a heat field read from the
// shared noise tile, and a temperature turned into colour by the blackbody fit. Three texture
// fetches and no procedural noise per pixel. Writes linear radiance, opaque.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "bed-space.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var coal_map: texture_2d<f32>;
@group(0) @binding(2) var noise_tex: texture_2d<f32>;
@group(0) @binding(3) var noise_smp: sampler;

// Below this a coal gives no visible light; `temperature` is what the hottest cracks reach.
const EMB_T_COLD: f32 = 720.0;
// A body at this temperature has luminance `intensity`.
const EMB_T_REF: f32 = 1500.0;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let coal = textureLoad(coal_map, vec2i(in.position.xy), 0);
  let gap_distance = coal.r;
  let id = coal.g;
  let plate_distance = coal.b;
  let plate = coal.a;

  let bed = bed_point(in.uv, params.aspect, params.tilt);

  // Heat drifting across the bed: two layers of the noise tile at different scales, moving in
  // different directions, the second bent by the first. Where they agree the bed is hot; the
  // pattern never repeats a second later and no two regions move together.
  let wide = noisetex_sample(noise_tex, noise_smp, bed.xy * params.region_scale + params.drift_a);
  let fine = noisetex_sample(
    noise_tex,
    noise_smp,
    bed.xy * params.region_scale * 2.3 + params.drift_b + (wide.gb - 0.5) * 0.7,
  );
  let field = clamp((0.62 * wide.r + 0.38 * fine.g - 0.5) * 3.0 + 0.5, 0.0, 1.0);
  // A fire pit is hottest in the middle.
  let from_centre = length((in.uv - 0.5) * vec2f(min(params.aspect, 1.6), 1.0)) * 2.0;
  let pit = 1.0 - params.falloff * smoothstep(0.35, 1.1, from_centre);
  let region = clamp(field * 1.4 + params.heat - 0.95, 0.0, 1.0) * pit;

  // Each coal is a little hotter or cooler than its surroundings and breathes at its own slow
  // rate. The gap between two coals belongs to neither, so it follows the region alone. Gaps are
  // wide open where the bed is hot and choked with ash where it is not.
  let breath = sin(params.time * (0.35 + 0.9 * fract(id * 7.31)) + id * 50.0);
  let own = (id - 0.5) * 0.5 + params.breath * 0.14 * breath;
  let gap = 1.0 - smoothstep(0.0, params.crack * (0.45 + 0.9 * region), gap_distance);
  let coal_heat = clamp(region + own * (1.0 - gap), 0.0, 1.0);

  // The coal as a lump: 0 where it meets the gap, 1 on top. Crust is thickest on top, differs
  // from coal to coal and from plate to plate, and some plates have gone to pale ash.
  let dome = smoothstep(0.0, 0.5, gap_distance);
  let crust = clamp(dome * (0.5 + 0.5 * fract(id * 3.71)) + (plate - 0.5) * 0.3, 0.0, 1.0);
  let ash = smoothstep(params.ash * 0.5, params.ash * 0.5 - 0.12, plate) *
    smoothstep(0.02, 0.2, plate_distance) * dome;

  // What glows, as a fraction of the way to `temperature`. The gap looks down into the bed and
  // is the hottest thing (past 1 are the few yellow-white spots). A coal glows through its
  // sides, where the crust is thin, through the fracture lines of its crust, and, when it is
  // hot enough, dully all over.
  let deep = gap * (0.1 + 1.15 * region * sqrt(region));
  let side = (1.0 - dome) * (1.0 - dome) * (0.12 + 0.8 * coal_heat);
  let top = coal_heat * coal_heat * (0.85 - 0.6 * crust);
  let fracture = (1.0 - smoothstep(0.0, 0.1, plate_distance)) * coal_heat * 0.6 * dome;
  let surface = max(max(side, top), fracture) * (1.0 - 0.8 * ash);
  let glow = max(surface, deep) * mix(1.0, 1.0 / bed.z, 0.5);

  let temperature = EMB_T_COLD + (params.temperature - EMB_T_COLD) * glow;
  var color = blackbody_radiance(temperature, EMB_T_REF, BLACKBODY_GAMMA) * params.intensity;
  // The hottest spots go pale instead of lemon yellow under the per-channel tonemap.
  color = ramp_whiten(color, 6.0);

  // What does not glow: char, lit a little by the embers around it, and pale ash on top.
  let warm = vec3f(1.0, 0.3, 0.07) * (0.3 * region * params.intensity);
  let char_color = vec3f(0.02, 0.017, 0.015) * (0.4 + 0.6 * plate + 0.6 * dome);
  let crust_color = mix(char_color, vec3f(0.2, 0.19, 0.18), ash);
  let lit = crust_color * (vec3f(0.035, 0.04, 0.05) + warm) * (1.0 - gap) / bed.z;
  return vec4f(color + lit, 1.0);
}
