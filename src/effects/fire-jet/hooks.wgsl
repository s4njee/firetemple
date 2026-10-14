// Hooks of the directed jet (index.ts), spliced into the particle framework's kernels
// (src/gpu/particles/kernels.wgsl lists the hook contract). The system runs in field 'drag' mode: every
// particle is dragged towards the fire fluid's velocity at the system's coupling (the droplets' rate);
// these hooks add what differs by kind.
//
// Kinds: 0 a burning fuel droplet (heavy: falls, outruns the gas), 1 a flame sprite (light: rides the
// gas), 2 an ember (GPU spawned from droplets as they burn and when they splash on a wall).
//
// ps_step.user[0]  x droplet gravity (canvas heights / s^2), y extra coupling of flame sprites to the
//                  gas (1/s, on top of the system's), z embers a droplet sheds per second, w ember lift
//                  per 1000 K
// ps_step.user[1]  cooling (1/s) of x droplets, y flames, z embers; w flame sprites a droplet sheds
//                  per second
// ps_step.user[2]  x flame sprites' own lift per 1000 K above ambient (canvas heights / s^2)
// ps_draw.user[0]  x temperature of heat 1 (K), y temperature of heat 0 (K), z flame gain, w droplet gain
// ps_draw.user[1]  x ember gain, y share of their speed flame sprites are stretched by
// ps_draw.user[2]  the flame sprites' size over life (particle_size_over_life curve)
#include "ramp.wgsl"

const FJ_DROPLET: u32 = 0u;
const FJ_FLAME: u32 = 1u;
const FJ_EMBER: u32 = 2u;
// Emitter indices of the templates GPU-spawned children are sampled from (index.ts adds them third
// and fourth).
const FJ_EMBER_TEMPLATE: u32 = 2u;
const FJ_FLAME_TEMPLATE: u32 = 3u;

fn hook_force(p: Particle, time: f32) -> vec3f {
  if (p.kind == FJ_DROPLET) {
    return vec3f(0.0, -ps_step.user[0].x, 0.0);
  }
  if (p.kind == FJ_FLAME) {
    // Flame is the gas itself: a much tighter coupling than a droplet's, plus the lift of its own heat,
    // which the fluid cannot give it where it was shed by a droplet into air the jet never heated.
    let lift = max(p.temperature - ps_step.ambient, 0.0) * 0.001 * ps_step.user[2].x;
    return (ps_field(p.position) - p.velocity) * ps_step.user[0].y + vec3f(0.0, lift, 0.0);
  }
  let heat = max(p.temperature - ps_step.ambient, 0.0) * 0.001;
  return vec3f(0.0, ps_step.user[0].w * heat - 0.12, 0.0);
}

fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32) {
  let c = ps_step.user[1];
  let kind = (*p).kind;
  let rate = select(select(c.z, c.y, kind == FJ_FLAME), c.x, kind == FJ_DROPLET);
  (*p).temperature = particle_cool_newton((*p).temperature, ps_step.ambient, rate, dt);
  if (kind == FJ_DROPLET) {
    // A burning droplet sheds flame along its path, which the gas then carries off, and the odd ember.
    let r = particle_random((*p).seed, ps_step.step_index ^ 0x27d4eb2fu);
    if (r.x < ps_step.user[0].z * dt) {
      ps_spawn_with((*p).position, (*p).velocity, 1u, FJ_EMBER_TEMPLATE, vec4f(0.0), 0.0, 1.0, FJ_EMBER);
    }
    // The flame it sheds is as hot as the droplet, and dies down with it.
    let burning = clamp(1.0 - (*p).age / max((*p).life, 1e-6), 0.0, 1.0);
    if (r.y < c.w * dt * burning) {
      ps_spawn_with((*p).position, (*p).velocity, 1u, FJ_FLAME_TEMPLATE, vec4f(0.0), (*p).temperature, 1.0, FJ_FLAME);
    }
  }
}

fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {
  // A droplet that hits a wall hard splashes: it breaks up into embers thrown back off the surface.
  if ((*p).kind == FJ_DROPLET && hit.impact > 0.25) {
    let off = hit.position + hit.normal * 0.004;
    let back = hit.normal * (0.35 * hit.impact);
    ps_spawn_with(off, back, 3u, FJ_EMBER_TEMPLATE, vec4f(0.0), 0.0, 1.0, FJ_EMBER);
    (*p).alive = false;
  }
}

fn hook_sprite(p: Particle, s: ptr<function, ParticleSprite>, time: f32) {
  let x = clamp(p.age / max(p.life, 1e-6), 0.0, 1.0);
  // The renderer is in tint mode with a white tint: color.r is intensity * twinkle * fades.
  let level = (*s).color.r;
  let u = ps_draw.user[0];
  let heat = clamp((p.temperature - u.y) / max(u.x - u.y, 1.0), 0.0, 1.0);
  if (p.kind == FJ_FLAME) {
    (*s).color = ramp_fire(heat) * (level * u.z / 16.0);
    (*s).size = p.size * ps_draw.size_scale * particle_size_over_life(x, ps_draw.user[2]);
    // Stretch only by part of the speed: a puff of flame is blurred by its motion, not a streak.
    (*s).velocity = p.velocity * ps_draw.user[1].y;
    (*s).param = x;
    return;
  }
  (*s).size = p.size * ps_draw.size_scale;
  if (p.kind == FJ_DROPLET) {
    (*s).color = ramp_fire(heat) * (level * u.w / 16.0);
    (*s).param = 2.0 + x;
    return;
  }
  (*s).color = blackbody_radiance(p.temperature, 1800.0, BLACKBODY_GAMMA) * (level * ps_draw.user[1].x);
  (*s).param = 2.0 + x;
}
