// Draws the fluid fire (index.ts; physics in src/gpu/sim/fire-fluid.ts) as linear HDR radiance over
// the page, or one of its fields as a diagnostic. One pass at canvas size.
//
// THE DYE: r temperature T (above ambient), g fuel F, b soot S, a burn rate R (the reaction zone).
//
// LIGHT. The hot gas glows as a black body: T maps to kelvin (ambient + T * kelvin_per_unit), and
// blackbody_radiance gives the colour and a tamed brightness (gamma 0.4: 1 at kelvin_ref, times `flame`).
// A real temperature field below 1900 K is red to orange with a zero blue channel, which the tail's
// per-channel tonemapper would push to lemon yellow, so ramp_whiten pales the bright cores toward white
// as a camera does. Gas and chemical palettes map T through the authored ramps instead (ramp_select:
// ramp_gas is a violet-blue mantle to an azure cone, never white). The reaction zone can add its own
// light, saturating with the burn rate: the bright inner cone of a gas flame (and, faintly, its dense
// premixed fuel). `emissivity` scales the black body (soot is what glows in a wood fire).
//
// SOOT absorbs (Beer-Lambert, smoke.wgsl): its transmittance dims the flame behind it by half its depth
// and its coverage hides the page. It is lit by the fire below (smoke_fire_light from the burners'
// centre, shadowed by the soot between, the one-tap gradient trick, smoke_shadow_gradient), by a dim
// ambient, and from inside by its own heat. Written premultiplied, coverage in alpha.
#include "fullscreen.wgsl"
#include "blackbody.wgsl"
#include "ramp.wgsl"
#include "smoke.wgsl"
#include "fluid.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dye_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var fields_tex: texture_2d<f32>;
@group(0) @binding(4) var source_tex: texture_2d<f32>;

const VIEW_FIRE: i32 = 0;
const VIEW_TEMPERATURE: i32 = 1;
const VIEW_FUEL: i32 = 2;
const VIEW_SOOT: i32 = 3;
const VIEW_REACTION: i32 = 4;
const VIEW_EXPANSION: i32 = 5;
const VIEW_VELOCITY: i32 = 6;
const VIEW_VORTICITY: i32 = 7;

const AMBIENT_KELVIN: f32 = 300.0;
// Light that reaches the smoke from nowhere in particular: a dim, slightly cool room.
const SMOKE_AMBIENT = vec3f(0.10, 0.11, 0.13);

// Radiance of the hot gas at temperature t (dye units).
fn gas_glow(t: f32) -> vec3f {
  if (t <= 0.02) {
    return vec3f(0.0);
  }
  // Fades in over the first unit: a body at the ambient end of the map would still glow a little.
  let fade = smoothstep(0.5, 1.6, t);
  if (params.palette < 0.5) {
    let kelvin = AMBIENT_KELVIN + t * params.kelvin_per_unit;
    let body = blackbody_radiance(kelvin, params.kelvin_ref, BLACKBODY_GAMMA) * (params.flame * params.emissivity * fade);
    return ramp_whiten(body, params.knee);
  }
  // Gas or a chemical colour: the authored ramp over a shaped heat (0.5 at t = 2.2, 0.8 at t = 5).
  let heat = 1.0 - exp(-0.32 * t);
  return ramp_select(i32(params.palette + 0.5), heat) * (params.flame / 8.0) * fade;
}

// The dye reconstructed by a cubic B-spline (four bilinear taps, Sigg and Hadwiger's trick). At 1080p a
// dye texel covers about four pixels, and plain bilinear magnification of a sharp field (the reaction
// zone is one or two texels thick) shows the texel grid as stair-steps along every edge; the B-spline is
// C2, so edges stay smooth, at the price of a slight blur.
fn dye_smooth(uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(dye_tex));
  let coord = uv * size - 0.5;
  let base = floor(coord);
  let f = coord - base;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let p0 = (base - 1.0 + w1 / g0 + 0.5) / size;
  let p1 = (base + 1.0 + w3 / g1 + 0.5) / size;
  let t00 = textureSampleLevel(dye_tex, samp, vec2f(p0.x, p0.y), 0.0);
  let t10 = textureSampleLevel(dye_tex, samp, vec2f(p1.x, p0.y), 0.0);
  let t01 = textureSampleLevel(dye_tex, samp, vec2f(p0.x, p1.y), 0.0);
  let t11 = textureSampleLevel(dye_tex, samp, vec2f(p1.x, p1.y), 0.0);
  return g0.y * (g0.x * t00 + g1.x * t10) + g1.y * (g0.x * t01 + g1.x * t11);
}

fn fire_scene(uv: vec2f) -> vec4f {
  let d = dye_smooth(uv);
  let temp = max(d.r, 0.0);
  let fuel = max(d.g, 0.0);
  let soot = max(d.b, 0.0);
  let rate = max(d.a, 0.0);

  var emission = gas_glow(temp);
  // The reaction zone's own light, saturating: the blue of a gas flame is dim beside a black body,
  // and a zone one texel thick drawn at full contrast would show the dye grid along its edges.
  emission += params.reaction_tint * (params.reaction_glow * 4.0 * (1.0 - exp(-0.25 * rate)));
  // Premixed gas glows faintly only where it is dense (at the burner), not as a haze of what escaped.
  emission += vec3f(0.06, 0.16, 0.6) * (params.premix * fuel * smoothstep(0.1, 0.5, fuel));

  if (soot < 1e-4) {
    return vec4f(emission, 0.0);
  }
  // Soot: Beer-Lambert per channel, over a path of one unit of the field.
  let tau = smoke_extinction(soot, params.opacity, params.sootiness);
  let trans = smoke_transmittance_rgb(tau);
  let coverage = smoke_coverage(trans);
  let albedo = smoke_albedo(params.sootiness);
  // Light from the fire: the burners' centre, falling off like a disc of `light_radius`, shadowed by
  // the soot halfway toward it.
  let k = vec2f(params.aspect, 1.0);
  let to_light = (params.light_pos - uv) * k;
  let dist = length(to_light);
  var occlusion = vec3f(1.0);
  if (dist > 1e-3) {
    let tap = min(0.5 * dist, 0.25);
    let toward = textureSampleLevel(dye_tex, samp, uv + to_light / dist * tap / k, 0.0).b;
    occlusion = vec3f(smoke_shadow_gradient(soot, max(toward, 0.0), tap, params.opacity, dist));
  }
  let direct = smoke_fire_light(params.light_colour, dist, params.light_radius, occlusion);
  // Hot soot is lit from inside by the gas it is in.
  let inner = 0.25 * gas_glow(temp);
  let lit = smoke_multi_albedo(albedo) * (direct + SMOKE_AMBIENT + inner);
  // Half the soot is taken to lie in front of the glow in the same texel.
  let shown = emission * sqrt(trans) + lit * coverage;
  return vec4f(shown, coverage);
}

fn debug_view(uv: vec2f, view: i32) -> vec3f {
  let d = textureSampleLevel(dye_tex, samp, uv, 0.0);
  let gain = params.debug_gain;
  if (view == VIEW_TEMPERATURE) {
    return ramp_fire(clamp(d.r * 0.22 * gain, 0.0, 1.0)) * 0.3;
  }
  if (view == VIEW_FUEL) {
    return vec3f(0.1, 0.8, 0.3) * clamp(d.g * gain, 0.0, 4.0);
  }
  if (view == VIEW_SOOT) {
    return vec3f(1.0 - exp(-d.b * gain * 2.0));
  }
  if (view == VIEW_REACTION) {
    return vec3f(0.2, 0.45, 1.0) * (d.a * 0.25 * gain);
  }
  if (view == VIEW_EXPANSION) {
    // r32float, one texel per velocity cell: a load, not a filtered tap.
    let cell = min(vec2i(uv * params.grid), vec2i(params.grid) - vec2i(1));
    return fluid_diverging(textureLoad(source_tex, cell, 0).x * 0.25 * gain);
  }
  let s = fluid_sample_fields(fields_tex, samp, uv);
  if (view == VIEW_VELOCITY) {
    return fluid_flow_color(fluid_velocity(s), 2.0 * gain);
  }
  return fluid_diverging(fluid_vorticity(s) * 0.04 * gain);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let view = i32(params.view + 0.5);
  if (view == VIEW_FIRE) {
    return fire_scene(in.uv);
  }
  return vec4f(vec3f(0.01) + debug_view(in.uv, view), 1.0);
}
