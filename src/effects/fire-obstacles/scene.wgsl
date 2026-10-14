// Draws the fire-obstacles scene: the solver's dye as flame and smoke, cut crisply round the solids,
// with the firelight that reaches the solids' edges. Pure shading: the flow is src/gpu/sim/fluid.ts,
// the solids are src/gpu/sim/obstacle-shapes.ts.
//
// THE DYE (index.ts writes it): r is heat (excess temperature, 0 = ambient, about 2 to 3 just above
// the burner, cooling at `cooling`), b is smoke density (thinning slowly), g and a are unused.
//
// Flame is emission (linear radiance, 1 = paper white) through ramp_fire of a shaped heat: it goes
// well above 1 in the hot gas and blooms. Smoke is a surface with real coverage,
// 1 - exp(-opacity * smoke), written premultiplied with that coverage in alpha, lit by a dim ambient
// and by the heat inside it, so over a light page it reads as grey haze with a red core.
//
// THE SOLIDS. The solver sees them as a staircase of cells (its obstacle mask); the viewer sees the
// exact outline, from the same shape table (obstacle-shapes.wgsl). Inside a solid nothing is drawn but
// the firelight on its edge: the heat just outside, along the outward normal, lights a thin band
// inside the outline. Over a page that band lies on the element itself. The shape table is only
// walked near a solid: the mask's bilinear tap is zero more than a cell away from every solid cell.

#include "fullscreen.wgsl"
#include "ramp.wgsl"
#include "obstacle-shapes.wgsl"
#include "obstacle_table.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dye_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var mask_tex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> T: ObstacleTable;

// Linear albedo of the smoke: a warm grey, as wood smoke is.
const FO_SMOKE_ALBEDO = vec3f(0.30, 0.28, 0.26);
// Light that reaches the smoke from nowhere in particular.
const FO_AMBIENT = vec3f(0.12, 0.13, 0.15);
// Colour of firelight falling on smoke and on the solids.
const FO_FIRE_LIGHT = vec3f(1.0, 0.45, 0.14);

struct FoNearest {
  d: f32,
  index: u32,
}

// The nearest solid to p (image heights): its signed distance and its index in the table.
fn fo_nearest(p: vec2f) -> FoNearest {
  var best = FoNearest(1e9, 0u);
  for (var i = 0u; i < T.count; i++) {
    let d = obstacle_sd(T.data[3u * i], T.data[3u * i + 1u], p);
    if (d < best.d) {
      best = FoNearest(d, i);
    }
  }
  return best;
}

// Flame radiance from heat: ramp_fire is black at 0, deep red by 0.25, orange by 0.5, a pale core
// above 0.9; 1 - exp(-heat * scale) keeps hot gas from all reading as the core.
fn fo_flame(heat: f32) -> vec3f {
  let h = clamp(1.0 - exp(-heat * params.heat_scale), 0.0, 1.0);
  return ramp_fire(h) * params.glow;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv;
  let scale = vec2f(T.aspect, 1.0);
  if (T.count > 0u && textureSampleLevel(mask_tex, samp, uv, 0.0).r > 0.0) {
    let p = uv * scale;
    let s = fo_nearest(p);
    if (s.d < 0.0) {
      // Inside a solid: the page element (or nothing) shows through; only firelight on its edge.
      let geo = T.data[3u * s.index];
      let size = T.data[3u * s.index + 1u];
      let n = obstacle_normal(geo, size, p);
      let outside = p + n * (1.5 * params.cell - s.d);
      let heat = max(textureSampleLevel(dye_tex, samp, outside / scale, 0.0).r, 0.0);
      let falloff = exp(s.d / max(params.rim_width, 1e-5));
      let light = FO_FIRE_LIGHT * (1.0 - exp(-heat * params.heat_scale)) * 3.0;
      return vec4f(light * params.rim * falloff, 0.0);
    }
  }
  let d = textureSampleLevel(dye_tex, samp, uv, 0.0);
  let heat = max(d.r, 0.0);
  let smoke = max(d.b, 0.0);
  let coverage = 1.0 - exp(-smoke * params.opacity);
  let lit = FO_SMOKE_ALBEDO * (FO_AMBIENT + FO_FIRE_LIGHT * 1.5 * (1.0 - exp(-heat)));
  return vec4f(lit * coverage + fo_flame(heat), coverage);
}
