// Hooks of the particle flame (index.ts), spliced into the particle framework's kernels
// (src/gpu/particles/kernels.wgsl lists the hook contract). Kinds: 0 a flame particle from the base,
// 2 a flame particle from a pointer fire, 1 an ember thrown off a flame tip (GPU spawned).
//
// ps_step.user[0]  x converge (1/s^2), y ember chance per flame particle that dies of age,
//                  z flame cooling (1/s), w ember cooling (1/s)
// ps_step.user[1]  x share of the flame's buoyancy an ember keeps, y how local the taper is (0 every
//                  particle is pulled to the base's centre, 1 to the point it was born above),
//                  z half-width of the base (canvas heights), w how much cooler the ends of the base
//                  are born (kelvin)
// ps_step.user[2]  turbulence: x rise of the noise (canvas heights / s), y noise cells per canvas
//                  height, z acceleration scale, w flame height (canvas heights)
// ps_step.user[3]  x evolution of the noise (cells / s)
// ps_draw.user[0]  x temperature of heat 1 (K), y temperature of heat 0 (K), z palette (0 the fire
//                  ramp, 1 the black body), w flame radiance gain
// ps_draw.user[1]  x ember radiance gain
//
// Per particle (`userData`): user.x the x the taper pulls towards, user.y the birth height.
#include "ramp.wgsl"

const PF_FLAME: u32 = 0u;
const PF_EMBER: u32 = 1u;
const PF_POINTER: u32 = 2u;
// Emitter index of the ember template (index.ts adds it second).
const PF_EMBER_TEMPLATE: u32 = 1u;

fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (source.spawned) {
    return;
  }
  // The centre of the emitter during this step: the middle of its sweep.
  let centre = 0.5 * (ps_emitter(source.emitter, 0u).x + ps_emitter(source.emitter, 1u).x);
  let pointer = (*p).kind == PF_POINTER;
  let local = select(ps_step.user[1].y, 0.0, pointer);
  (*p).user = vec4f(mix(centre, (*p).position.x, local), (*p).position.y, 0.0, 0.0);
  if (!pointer && local < 0.5) {
    // The ends of a log line burn cooler than its middle, which rounds the base of the flame.
    let across = ((*p).position.x - centre) / max(ps_step.user[1].z, 1e-4);
    (*p).temperature -= ps_step.user[1].w * min(across * across, 1.0);
  }
}

fn hook_force(p: Particle, time: f32) -> vec3f {
  let heat = max(p.temperature - ps_step.ambient, 0.0) * 0.001;
  if (p.kind == PF_EMBER) {
    // An ember keeps only a share of the lift the flame gets from the same temperature.
    return -ps_step.up * (ps_step.buoyancy * heat * (1.0 - ps_step.user[1].x));
  }
  // The taper: a spring towards the axis, which the wind carries along as the particle ages.
  let axis = p.user.x + ps_step.wind.x * p.age;
  var a = vec3f(-ps_step.user[0].x * (p.position.x - axis), 0.0, 0.0);
  // Turbulence: curl noise that rises with the flame, so eddies travel up with the particles and
  // tongues form and climb; calm at the base, growing with height.
  let t = ps_step.user[2];
  if (t.z > 0.0) {
    let up = clamp((p.position.y - p.user.y) / max(t.w, 1e-3), 0.0, 1.0);
    let q = vec2f(p.position.x, p.position.y - t.x * time) * t.y;
    let curl = curl_2d_anim(q, time * ps_step.user[3].x, 2, 2.0, 0.5);
    a += vec3f(curl * (t.z * (0.2 + up)), 0.0);
  }
  return a;
}

fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32) {
  // Newtonian cooling at a rate per kind (the system's own cooling is off).
  let rate = select(ps_step.user[0].z, ps_step.user[0].w, (*p).kind == PF_EMBER);
  (*p).temperature = particle_cool_newton((*p).temperature, ps_step.ambient, rate, dt);
}

fn hook_die(p: Particle) {
  // Now and then a flame particle that burns out at a tip throws off an ember.
  if (p.kind != PF_EMBER && p.age >= p.life) {
    let r = particle_random(p.seed, ps_step.step_index ^ 0x5bd1e995u);
    if (r.x < ps_step.user[0].y) {
      ps_spawn_with(p.position, p.velocity, 1u, PF_EMBER_TEMPLATE, vec4f(0.0), 0.0, 1.0, PF_EMBER);
    }
  }
}

fn hook_sprite(p: Particle, s: ptr<function, ParticleSprite>, time: f32) {
  let x = clamp(p.age / max(p.life, 1e-6), 0.0, 1.0);
  // The renderer is in tint mode with a white tint: color.r is intensity * twinkle * fades.
  let level = (*s).color.r;
  if (p.kind == PF_EMBER) {
    (*s).color = blackbody_radiance(p.temperature, 1800.0, BLACKBODY_GAMMA) * (level * ps_draw.user[1].x);
    // Embers keep their size: the flame's size-over-life curve is not theirs.
    (*s).size = p.size * ps_draw.size_scale;
    (*s).param = 2.0 + x;
    return;
  }
  let u = ps_draw.user[0];
  var colour: vec3f;
  if (u.z > 0.5) {
    colour = blackbody_radiance(p.temperature, 1800.0, BLACKBODY_GAMMA) * 0.25;
  } else {
    let heat = clamp((p.temperature - u.y) / max(u.x - u.y, 1.0), 0.0, 1.0);
    // ramp_fire peaks at 16: one sprite's core is at most 1, and the overlap makes the body.
    colour = ramp_fire(heat) * (1.0 / 16.0);
  }
  (*s).color = colour * (level * u.w);
  (*s).param = x;
}
