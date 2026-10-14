// The directed jet's fluid pass (index.ts): the fire fluid's heat and soot as linear HDR radiance over
// the page, plus the solid things the jet meets (its nozzle, a wall). The particles are added on top
// by the sprite renderer afterwards. One pass at canvas size.
//
// THE DYE (src/gpu/sim/fire-fluid.ts): r temperature T above ambient, g fuel, b soot, a burn rate.
// Hot gas glows as a black body (T to kelvin, blackbody_radiance, whitened cores) scaled by
// `fluid_glow` (0 when the particles alone carry the look); soot absorbs (Beer-Lambert, smoke.wgsl),
// is lit by the jet and writes real coverage, so the smoke reads over a light page. The dye is read
// through a cubic B-spline, as in the fire-fluid effect, so its texels do not show as steps.
#include "fullscreen.wgsl"
#include "blackbody.wgsl"
#include "ramp.wgsl"
#include "smoke.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var dye_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const AMBIENT_KELVIN: f32 = 300.0;
const SMOKE_AMBIENT = vec3f(0.10, 0.11, 0.13);

fn jet_glow(t: f32) -> vec3f {
  if (t <= 0.02) {
    return vec3f(0.0);
  }
  let fade = smoothstep(1.0, 2.2, t);
  let kelvin = AMBIENT_KELVIN + t * params.kelvin_per_unit;
  let body = blackbody_radiance(kelvin, 1800.0, BLACKBODY_GAMMA) * (params.flame * fade);
  return ramp_whiten(body, 9.0);
}

fn jet_dye(uv: vec2f) -> vec4f {
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

// Distance in image heights from uv p to the segment a..b (uv).
fn jet_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let k = vec2f(params.aspect, 1.0);
  let pa = (p - a) * k;
  let ab = (b - a) * k;
  let h = clamp(dot(pa, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
  return length(pa - ab * h);
}

// Firelight on a solid at uv: the heat of the gas around it, as a dim warm glow.
fn jet_firelight(uv: vec2f) -> vec3f {
  let near = max(textureSampleLevel(dye_tex, samp, uv, 0.0).r, 0.0);
  let around = max(textureSampleLevel(dye_tex, samp, uv + vec2f(-0.03 / params.aspect, 0.0), 0.0).r, 0.0);
  return vec3f(1.0, 0.45, 0.15) * (0.25 * (near + around));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let uv = in.uv;
  // Solids first: they hide the gas behind them.
  if (params.wall.z > params.wall.x && all(uv >= params.wall.xy) && all(uv <= params.wall.zw)) {
    // Brick courses, faintly, so it reads as a wall rather than a hole in the page.
    let local = (uv - params.wall.xy) * vec2f(params.aspect, 1.0);
    let row = floor(local.y / 0.035);
    let joint = min(fract(local.y / 0.035), fract(local.x / 0.07 + 0.5 * row));
    let mortar = 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.08, joint));
    let lit = vec3f(0.035, 0.03, 0.028) + jet_firelight(uv) * 0.6;
    return vec4f(lit * mortar, 1.0);
  }
  if (params.nozzle_on > 0.5) {
    let d = jet_segment(uv, params.nozzle.zw, params.nozzle.xy);
    if (d < 0.011) {
      let shade = 0.5 + 0.5 * (1.0 - d / 0.011);
      let lit = vec3f(0.05, 0.05, 0.055) * shade + jet_firelight(params.nozzle.xy) * 0.3 * shade;
      return vec4f(lit, 1.0);
    }
  }

  let d = jet_dye(uv);
  let temp = max(d.r, 0.0);
  let soot = max(d.b, 0.0) * params.soot_gain;
  let emission = jet_glow(temp) * params.fluid_glow;
  if (soot < 1e-4) {
    return vec4f(emission, 0.0);
  }
  let tau = smoke_extinction(soot, params.opacity, 0.75);
  let trans = smoke_transmittance_rgb(tau);
  let coverage = smoke_coverage(trans);
  let albedo = smoke_albedo(0.75);
  let k = vec2f(params.aspect, 1.0);
  let dist = length((params.light_pos - uv) * k);
  let direct = smoke_fire_light(params.light_colour, dist, 0.18, vec3f(1.0));
  let inner = 0.25 * jet_glow(temp);
  let lit = smoke_multi_albedo(albedo) * (direct + SMOKE_AMBIENT + inner);
  return vec4f(emission * sqrt(trans) + lit * coverage, coverage);
}
