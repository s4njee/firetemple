// Shows the combustion fields (src/gpu/sim/combustion.ts): temperature as a glowing body,
// burnt ground as char, unburnt fuel as a faint texture. One bilinear fetch of the state, one of
// the shared noise tile for grain.
//
// The fire is emission (linear radiance, 1.0 = paper white). Char and fuel are surfaces: they
// are written premultiplied with their coverage in alpha, which the tail's `luminance` and
// `coverage` modes both keep, so they darken a light page and the flame is added on top.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var state_tex: texture_2d<f32>;
@group(0) @binding(2) var state_smp: sampler;
@group(0) @binding(3) var noise_tex: texture_2d<f32>;
@group(0) @binding(4) var noise_smp: sampler;

const VIEW_FIRE: i32 = 0;
const VIEW_TEMPERATURE: i32 = 1;
const VIEW_FUEL: i32 = 2;
const VIEW_REACTION: i32 = 3;

// T = 0 is the ambient temperature; T = 1 is `params.kelvin`.
const AMBIENT_KELVIN: f32 = 300.0;
// Radiance of a body at `params.kelvin` with glow 1. A free front peaks near T = 0.75, which is
// then about a fifth of this.
const PEAK_RADIANCE: f32 = 26.0;
// Bright colours pale toward white from here (radiance), as an overexposed flame does.
const WHITEN_KNEE: f32 = 7.0;
// Linear colours of the surfaces.
const CHAR_COLOR = vec3f(0.010, 0.008, 0.007);
// Ground that is growing back shows as a brown scorch before it clears.
const SCORCH_COLOR = vec3f(0.05, 0.028, 0.012);
const ASH_COLOR = vec3f(0.035, 0.032, 0.03);
const FUEL_COLOR = vec3f(0.16, 0.115, 0.07);
// Grain: noise cells across the canvas height.
const GRAIN_CELLS: f32 = 22.0;

// Radiance of ground at temperature t whose fuel is reacting at `rate` (0..1).
fn scene_glow(t: f32, rate: f32) -> vec3f {
  // The reaction zone is flame, hotter than the ground under it: it reads as the bright leading
  // edge, and the cooling tail behind it as embers.
  let hot = t + params.flare * rate * 0.5;
  let kelvin = AMBIENT_KELVIN + hot * (params.kelvin - AMBIENT_KELVIN);
  let radiance = blackbody_radiance(kelvin, params.kelvin, BLACKBODY_GAMMA);
  // blackbody_radiance never quite reaches black; ground barely above ambient must.
  let lit = smoothstep(0.02, 0.2, hot);
  return ramp_whiten(radiance * (PEAK_RADIANCE * params.glow * lit), WHITEN_KNEE);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let cell = textureSampleLevel(state_tex, state_smp, in.uv, 0.0);
  let t = cell.r;
  let fuel = cell.g;
  let capacity = cell.b;
  let rate = cell.a;

  let view = i32(params.view);
  if (view == VIEW_TEMPERATURE) { return vec4f(vec3f(clamp(t, 0.0, 1.0) * 0.9), 1.0); }
  if (view == VIEW_FUEL) { return vec4f(vec3f(clamp(fuel, 0.0, 1.0) * 0.9), 1.0); }
  if (view == VIEW_REACTION) { return vec4f(vec3f(clamp(rate, 0.0, 1.0) * 0.9), 1.0); }

  let grain = noisetex_sample(noise_tex, noise_smp,
    vec2f(in.uv.x * params.aspect, in.uv.y) * GRAIN_CELLS);

  // Unburnt fuel: a faint mottled surface where there is something to burn.
  let fuel_alpha = params.fuel * 0.4 * fuel * (0.55 + 0.9 * grain.b);
  let fuel_color = FUEL_COLOR * (0.7 + 0.6 * grain.r);

  // Char: the share of this ground's fuel that has burnt. Bare ground (no capacity) has none.
  let burnt = clamp(1.0 - fuel / max(capacity, 1e-3), 0.0, 1.0) * smoothstep(0.02, 0.2, capacity);
  let char_alpha = params.char_amount * burnt;
  // Flecks of pale ash where the burn was complete.
  let ash = smoothstep(0.5, 0.8, grain.b) * burnt * burnt;
  let char_color = mix(mix(SCORCH_COLOR, CHAR_COLOR, smoothstep(0.15, 0.85, burnt)), ASH_COLOR, ash * 0.5);

  let surface = fuel_color * fuel_alpha * (1.0 - char_alpha) + char_color * char_alpha;
  let alpha = 1.0 - (1.0 - fuel_alpha) * (1.0 - char_alpha);

  return vec4f(surface + scene_glow(t, rate), alpha);
}
