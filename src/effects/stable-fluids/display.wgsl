// Draws the stable-fluids validation scene: the solver's dye as smoke with an ember glow in it, or one
// of the solver's own fields as a diagnostic. Pure shading: the physics is src/gpu/sim/fluid.ts.
//
// THE DYE (index.ts writes it): r is heat (0 = ambient, about 1 in a fresh ember stroke, cooling at
// the `cooling` rate), b is smoke density (thinning slowly), g and a are unused. That is the layout a
// combustion layer would use (r temperature, g fuel, b soot), with no reaction.
//
// Smoke is a surface with real coverage: written premultiplied, coverage 1 - exp(-opacity * smoke) in
// alpha, so over a light page it reads as grey haze. It is lit by a dim ambient and by the glow of the
// bed below it. Heat is emission (linear radiance, 1 = paper white) through ramp_fire, added on top:
// it is what goes above 1 and blooms.
#include "fullscreen.wgsl"
#include "fluid.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dye_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var fields_tex: texture_2d<f32>;
@group(0) @binding(4) var div_tex: texture_2d<f32>;

const VIEW_SMOKE: i32 = 0;
const VIEW_VELOCITY: i32 = 1;
const VIEW_VORTICITY: i32 = 2;
const VIEW_PRESSURE: i32 = 3;
const VIEW_DIVERGENCE: i32 = 4;

// Linear albedo of the smoke: a warm grey, as wood smoke is.
const SMOKE_ALBEDO = vec3f(0.30, 0.28, 0.26);
// Light that reaches the smoke from nowhere in particular (a dim room, a little cool).
const AMBIENT = vec3f(0.16, 0.17, 0.19);
// Colour of the bed's light on the smoke above it.
const EMBER_LIGHT = vec3f(1.0, 0.42, 0.12);

fn smoke_scene(uv: vec2f) -> vec4f {
  let d = textureSampleLevel(dye_tex, samp, uv, 0.0);
  let heat = max(d.r, 0.0);
  let smoke = max(d.b, 0.0);
  let coverage = 1.0 - exp(-smoke * params.opacity);
  // Light from the bed: an inverse-square-ish falloff from its centre (image heights), and the
  // smoke's own heat lights it from inside.
  let p = (uv - params.bed) * vec2f(params.aspect, 1.0);
  let bed = params.bed_light / (1.0 + 12.0 * dot(p, p));
  let lit = SMOKE_ALBEDO * (AMBIENT + EMBER_LIGHT * (bed + 0.6 * heat));
  // Heat glows: ramp_fire is black at 0, deep red by 0.25, orange by 0.5. Hot cores reach about 5.
  let h = clamp(1.0 - exp(-heat * params.heat_scale), 0.0, 1.0);
  let emission = ramp_fire(h) * params.glow;
  return vec4f(lit * coverage + emission, coverage);
}

fn debug_view(uv: vec2f, view: i32) -> vec3f {
  let s = fluid_sample_fields(fields_tex, samp, uv);
  let gain = params.debug_gain;
  if (view == VIEW_VELOCITY) {
    return fluid_flow_color(fluid_velocity(s), 3.0 * gain);
  }
  if (view == VIEW_VORTICITY) {
    return fluid_diverging(fluid_vorticity(s) * 0.05 * gain);
  }
  if (view == VIEW_PRESSURE) {
    return fluid_diverging(fluid_pressure(s) * 30.0 * gain);
  }
  // What the last projection removed (r32float, one texel per cell, so a load, not a filtered tap):
  // the right-hand side div u* - S / cells, near zero over a steady expansion source.
  let cell = min(vec2i(uv * params.grid), vec2i(params.grid) - vec2i(1));
  return fluid_diverging(textureLoad(div_tex, cell, 0).x * 20.0 * gain);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let view = i32(params.view + 0.5);
  if (view == VIEW_SMOKE) {
    return smoke_scene(in.uv);
  }
  return vec4f(vec3f(0.01) + debug_view(in.uv, view), 1.0);
}
