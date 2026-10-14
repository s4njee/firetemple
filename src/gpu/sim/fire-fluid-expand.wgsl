// fire-fluid-expand.wgsl -- gas expansion at the flame front (src/gpu/sim/fire-fluid.ts), run as the
// solver's `hooks.divergence` once per step, before the pressure solve. Nguyen, Fedkiw and Jensen (2002)
// put the expansion of burning gas into the projection as a jump in normal velocity across the reaction
// front; on a grid that is a divergence source where fuel turns into hot products:
//
//     S = expansion * R      (1 / s)     R = fuel burnt per second (dye a, written by the reaction)
//
// so S is zero wherever nothing burns and the projection then targets div u = S, which pushes the gas
// outward from the reaction zone. S is clamped to `source_max` so a burst of burning cannot ask for
// more than the speed cap can deliver.
//
// The dye is finer than the velocity grid (4 x by default): each cell averages the burn rate over its
// footprint with four bilinear taps at the quarter points, which for a 4 x 4 block is exactly the mean
// of its sixteen texels (each tap lands on the corner of four).
//
// Bindings: 0 the step's uniforms, 1 the current dye, 2 a linear clamp sampler, 3 the solver's source
// (r32float storage, grid sized, every texel written), 4 the module's own copy of it (for display and tests).

#include "fire-fluid-params.wgsl"

@group(0) @binding(0) var<uniform> F: FireFluidStep;
@group(0) @binding(1) var dye_tex: texture_2d<f32>;
@group(0) @binding(2) var dye_smp: sampler;
@group(0) @binding(3) var source_dst: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var copy_dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(16, 16)
fn cs_expand(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= F.grid)) {
    return;
  }
  let cell = vec2f(F.grid);
  let centre = (vec2f(id.xy) + 0.5) / cell;
  let q = 0.25 / cell;
  let rate = textureSampleLevel(dye_tex, dye_smp, centre + vec2f(-q.x, -q.y), 0.0).a
           + textureSampleLevel(dye_tex, dye_smp, centre + vec2f(q.x, -q.y), 0.0).a
           + textureSampleLevel(dye_tex, dye_smp, centre + vec2f(-q.x, q.y), 0.0).a
           + textureSampleLevel(dye_tex, dye_smp, centre + vec2f(q.x, q.y), 0.0).a;
  let raw = F.expansion * 0.25 * rate;
  // Finite and inside [0, source_max]: max() and min() would pass a NaN through on some drivers.
  let s = select(clamp(raw, 0.0, F.source_max), 0.0, (bitcast<u32>(raw) & 0x7f800000u) == 0x7f800000u);
  let c = vec2i(id.xy);
  textureStore(source_dst, c, vec4f(s, 0.0, 0.0, 0.0));
  textureStore(copy_dst, c, vec4f(s, 0.0, 0.0, 0.0));
}
