// The particle system's kernels (src/gpu/particles/system.ts runs them; read its header first).
//
// One STEP of the simulation is four dispatches, recorded into one compute pass with every other step
// of the frame:
//   update  (indirect, one thread per live particle)  forces, colliders, cooling, ageing, hooks; the
//           survivors are appended to the other alive list, the dead are pushed on the dead stack,
//           and GPU events append spawn requests to the queue (`ps_spawn`)
//   plan    (one workgroup of 256)  sizes this step's emission: an exclusive prefix sum of the
//           requests' child counts (each thread sums a contiguous run of requests, then a
//           workgroup scan of the 256 run totals) gives each request its first child; the
//           children come first, then the CPU emitters' counts, clamped to the free slots; writes
//           the emit dispatch's arguments
//   emit    (indirect, one thread per new particle)  pops a slot off the dead stack, samples the
//           particle from its emitter record or spawn request, appends it to the alive list
//   finish  (one thread)  writes the next step's update arguments, the draw arguments and the
//           statistics, and clears the list that was read and the queue
// and `draw` (indirect, one thread per live particle, once a frame, src/gpu/particles/renderer.ts)
// writes one sprite instance per live particle, compacted, for an indirect instanced draw.
//
// DETERMINISM. Which slot a particle gets and where it lands in the alive list depend on the order
// threads reach the atomics, and so does the order of the spawn queue. Nothing a particle IS may
// depend on either: a CPU-emitted particle's random numbers and seed are a hash of (emitter, index
// among that emitter's particles this step, step, system seed); a request's seed is a hash of its
// parent's seed, the step and how many requests that parent made before it in the step; a child's
// are a hash of (request seed, index in the request). So the same run gives the same particles,
// as a multiset, every time (tests/particles.test.ts checks it), unless the pool or the queue
// overflows: then which births are dropped depends on the order.
//
// Runtime chunks, made by system.ts:
//   particle-step.wgsl   struct ParticleStep (the per-step uniform block, one ring slot per step)
//   particle-draw.wgsl   struct ParticleDraw (the renderer's uniform block)
//   particle-user.wgsl   ps_load_user / ps_store_user: the optional per-particle `user` vec4f
//   particle-hooks.wgsl  the effect's hooks; system.ts supplies a default for each one it lacks:
//     fn hook_force(p: Particle, time: f32) -> vec3f                  extra acceleration
//     fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32)  after the sub-steps of a step
//     fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit)   at every contact (the
//                                                                      colliders after one that
//                                                                      killed it are skipped)
//     fn hook_die(p: Particle)                                         once, as it dies
//     fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) once, as it is born
//     fn hook_sdf(q: vec3f) -> f32                                     the 'sdf' collider's surface
//     fn hook_sprite(p: Particle, s: ptr<function, ParticleSprite>, time: f32)   colour, size, ...
// Hooks may call `ps_spawn` (from update, collide and die; not from emit), `ps_random`, `ps_field`
// (the external field at a point, already mapped to particle velocity), read `ps_step.user[0..3]`
// (update-stage hooks) and `ps_draw.user[0..3]` (hook_sprite), and include library chunks they
// pass in the hook's `chunks`. Names starting with `ps_` and `hook_` are the framework's.

#include "particles.wgsl"
#include "curl.wgsl"
#include "blackbody.wgsl"
#include "particle-step.wgsl"
#include "particle-draw.wgsl"

// --- State ---------------------------------------------------------------------------------------

struct Particle {
  position: vec3f,
  // Seconds since birth.
  age: f32,
  velocity: vec3f,
  // Seconds it lives; it dies when age reaches it.
  life: f32,
  // Kelvin.
  temperature: f32,
  // Sprite half-width, world units, before the renderer's size-over-life curve.
  size: f32,
  // Per-particle random bits, fixed for its life (twinkle, variation).
  seed: u32,
  // The emitter's `kind`, or a spawn request's override.
  kind: u32,
  // Free per-particle data (only stored when the system has `userData`).
  user: vec4f,
  // Set false in a hook to kill the particle at the end of this step.
  alive: bool,
}

struct ParticleHit {
  // Where it touched the surface.
  position: vec3f,
  // Index of the collider.
  collider: u32,
  // Unit normal out of the solid.
  normal: vec3f,
  // Speed into the surface before the contact (>= 0).
  impact: f32,
}

struct ParticleSource {
  // The emitter (template) the particle was sampled from.
  emitter: u32,
  // True for a child of a GPU spawn request.
  spawned: bool,
  // The request's `user` value; for CPU emission the burst's (`burst(n, user)`), zero for the
  // emitter's rate particles.
  user: vec4f,
  // Index of this particle among those its emitter or request made this step.
  index: u32,
  // How many its emitter or request made this step.
  count: u32,
  // A child: the request's position (where its parent asked for it), unmoved. CPU emission: the
  // emitter's centre at the moment of birth (along its sweep), before the shape's offset.
  position: vec3f,
  // A child: the request's velocity (usually its parent's), before the template's `inherit`
  // scales it. CPU emission: the emitter's own (sweep) velocity.
  velocity: vec3f,
}

struct ParticleSprite {
  position: vec3f,
  size: f32,
  velocity: vec3f,
  param: f32,
  color: vec3f,
  alpha: f32,
}

struct ParticleSpawn {
  position: vec3f,
  count: u32,
  velocity: vec3f,
  emitter: u32,
  user: vec4f,
  // > 0 overrides the template's temperature range.
  temperature: f32,
  // Multiplies the template's size range.
  size_scale: f32,
  // 0xffffffff keeps the template's kind.
  kind: u32,
  // Written by `plan`: index of the request's first child among the step's emissions.
  first: u32,
  // From the parent (see DETERMINISM above): what the children's random numbers are drawn from.
  seed: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

struct ParticleLists {
  counters: array<atomic<u32>, 16>,
  // [0, capacity): the dead stack; [capacity, 2 capacity) and [2 capacity, 3 capacity): alive lists.
  data: array<u32>,
}

// Counter slots; keep in step with COUNTER in system.ts.
const PS_ALIVE_0: u32 = 0u;
const PS_DEAD: u32 = 2u;
const PS_QUEUE: u32 = 3u;
const PS_EMIT_TOTAL: u32 = 4u;
const PS_QUEUE_TOTAL: u32 = 5u;
const PS_EMITTED: u32 = 6u;
const PS_DIED: u32 = 7u;
const PS_SPAWNED: u32 = 8u;
const PS_DROPPED_SPAWNS: u32 = 9u;
const PS_DROPPED_EMITS: u32 = 10u;
const PS_HITS: u32 = 11u;
const PS_QUEUE_USED: u32 = 12u;
const PS_STEPS: u32 = 13u;

// Argument words in the args buffer; keep in step with ARGS in system.ts.
const PS_ARGS_UPDATE: u32 = 0u;
const PS_ARGS_EMIT: u32 = 3u;
const PS_ARGS_DRAW: u32 = 6u;
const PS_ARGS_INDIRECT: u32 = 9u;

const PS_EMITTER_VEC4: u32 = 10u;
const PS_COLLIDER_VEC4: u32 = 4u;
const PS_POINT_VEC4: u32 = 3u;
const PS_FLAG_INSIDE: u32 = 1u;
const PS_FLAG_KILL: u32 = 2u;
const PS_FLAG_SPAWN: u32 = 4u;
const PS_GROUP: u32 = 64u;
// Threads of the plan kernel's one workgroup.
const PS_PLAN_GROUP: u32 = 256u;
// Child counts saturate here in the plan's sums: exact below it, never overflowing a u32.
const PS_PLAN_SATURATE: u32 = 0x40000000u;
// Separates a child's random numbers from a CPU-emitted particle's.
const PS_CHILD_SALT: u32 = 0x6a09e667u;

@group(0) @binding(0) var<uniform> ps_step: ParticleStep;
@group(0) @binding(1) var<storage, read_write> ps_position: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> ps_velocity: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> ps_attributes: array<vec4f>;
// Binding 4, `ps_user`, is declared by particle-user.wgsl when the system has user data.
@group(0) @binding(5) var<storage, read_write> lists: ParticleLists;
@group(0) @binding(6) var<storage, read_write> queue: array<ParticleSpawn>;
@group(0) @binding(7) var<storage, read_write> args: array<u32>;
@group(0) @binding(8) var field_texture: texture_2d<f32>;
@group(0) @binding(9) var field_sampler: sampler;
@group(0) @binding(10) var<uniform> ps_draw: ParticleDraw;
@group(0) @binding(11) var<storage, read_write> sprites: array<vec4f>;

#include "particle-user.wgsl"

fn ps_load(i: u32) -> Particle {
  let a = ps_position[i];
  let b = ps_velocity[i];
  let c = ps_attributes[i];
  var p: Particle;
  p.position = a.xyz;
  p.age = a.w;
  p.velocity = b.xyz;
  p.life = b.w;
  p.temperature = c.x;
  p.size = c.y;
  p.seed = bitcast<u32>(c.z);
  p.kind = bitcast<u32>(c.w);
  p.user = ps_load_user(i);
  p.alive = true;
  return p;
}

fn ps_store(i: u32, p: Particle) {
  ps_position[i] = vec4f(p.position, p.age);
  ps_velocity[i] = vec4f(p.velocity, p.life);
  ps_attributes[i] = vec4f(p.temperature, p.size, bitcast<f32>(p.seed), bitcast<f32>(p.kind));
  ps_store_user(i, p.user);
}

/** Four uniform numbers in [0, 1) for (index, salt), different every step and system seed. */
fn ps_random(index: u32, salt: u32) -> vec4f {
  return particle_random(index, salt ^ (ps_step.step_index * 0x9e3779b9u) ^ ps_step.seed);
}

// The particle the update thread is working on, for the seeds of the requests its hooks make: its
// seed, and how many requests it has made so far this step (set by `update`).
var<private> ps_spawn_parent: u32;
var<private> ps_spawn_made: u32;

/** The hash a birth's random numbers come from: (a, b) names the birth (see DETERMINISM). */
fn ps_birth_hash(a: u32, b: u32, salt: u32) -> vec4u {
  return pcg_4d(vec4u(a, b, salt ^ ps_step.seed, ps_step.step_index));
}

/**
 * Appends a spawn request: `count` children of emitter (template) `emitter` at `position`, with the
 * template's velocity plus `velocity` times its `inherit`, and `user` handed to hook_emit. Returns
 * false when the queue is full (counted in ParticleStats.droppedSpawns). Children are born in the
 * emit pass of this same step.
 */
fn ps_spawn(position: vec3f, velocity: vec3f, count: u32, emitter: u32, user: vec4f) -> bool {
  return ps_spawn_with(position, velocity, count, emitter, user, 0.0, 1.0, 0xffffffffu);
}

/** ps_spawn with overrides: temperature (> 0), a size multiplier, and a kind (0xffffffff keeps it). */
fn ps_spawn_with(
  position: vec3f,
  velocity: vec3f,
  count: u32,
  emitter: u32,
  user: vec4f,
  temperature: f32,
  size_scale: f32,
  kind: u32,
) -> bool {
  if (count == 0u) {
    return true;
  }
  // The seed depends on the parent and the order of its own requests, never on the queue position.
  let seed = ps_birth_hash(ps_spawn_parent, ps_spawn_made, 0x3c6ef372u).x;
  ps_spawn_made += 1u;
  let q = atomicAdd(&lists.counters[PS_QUEUE], 1u);
  if (q >= ps_step.queue_capacity) {
    atomicAdd(&lists.counters[PS_DROPPED_SPAWNS], 1u);
    return false;
  }
  queue[q] = ParticleSpawn(
    position,
    count,
    velocity,
    emitter,
    user,
    temperature,
    size_scale,
    kind,
    0u,
    seed,
    0u,
    0u,
    0u,
  );
  return true;
}

#include "particle-hooks.wgsl"

// --- Update --------------------------------------------------------------------------------------

fn ps_emitter(e: u32, k: u32) -> vec4f {
  return ps_step.emitters[e * PS_EMITTER_VEC4 + k];
}

fn ps_sdf_normal(q: vec3f) -> vec3f {
  let h = 1e-3;
  let g = vec3f(
    hook_sdf(q + vec3f(h, 0.0, 0.0)) - hook_sdf(q - vec3f(h, 0.0, 0.0)),
    hook_sdf(q + vec3f(0.0, h, 0.0)) - hook_sdf(q - vec3f(0.0, h, 0.0)),
    hook_sdf(q + vec3f(0.0, 0.0, h)) - hook_sdf(q - vec3f(0.0, 0.0, h)),
  );
  let len = length(g);
  return select(vec3f(0.0, 1.0, 0.0), g / max(len, 1e-20), len > 1e-12);
}

// Sphere tracing along the segment: never steps further than the field says is free.
fn ps_hit_sdf(p0: vec3f, p1: vec3f) -> vec4f {
  let d0 = hook_sdf(p0);
  if (d0 < 0.0) {
    return vec4f(ps_sdf_normal(p0), 0.0);
  }
  let seg = p1 - p0;
  let len = length(seg);
  if (len <= 1e-12) {
    return vec4f(0.0, 0.0, 0.0, -1.0);
  }
  var s = 0.0;
  var d = d0;
  for (var k = 0u; k < 16u; k++) {
    if (d <= 1e-5) {
      return vec4f(ps_sdf_normal(p0 + seg * s), s);
    }
    s += d / len;
    if (s >= 1.0) {
      break;
    }
    d = hook_sdf(p0 + seg * s);
  }
  // Ran out of iterations or reached the end: a hit only if the end is inside.
  if (hook_sdf(p1) < 0.0) {
    let at = min(s, 1.0);
    return vec4f(ps_sdf_normal(p0 + seg * at), at);
  }
  return vec4f(0.0, 0.0, 0.0, -1.0);
}

// The point on the surface where a contact puts the particle (before the skin offset).
fn ps_contact(kind: u32, flags: u32, c1: vec4f, c2: vec4f, p0: vec3f, p1: vec3f, hit: vec4f) -> vec3f {
  let n = hit.xyz;
  if (hit.w > 0.0) {
    return mix(p0, p1, hit.w);
  }
  // Started inside the solid: the nearest surface point along the way out.
  let inside = (flags & PS_FLAG_INSIDE) != 0u;
  if (kind == 1u) {
    return p0 - n * (dot(n, p0) + c1.w);
  }
  if (kind == 2u) {
    return c1.xyz + select(n, -n, inside) * c1.w;
  }
  if (kind == 3u) {
    if (inside) {
      return clamp(p0, c1.xyz - c2.xyz, c1.xyz + c2.xyz);
    }
    var q = p0;
    for (var k = 0u; k < 3u; k++) {
      if (n[k] != 0.0) {
        q[k] = c1[k] + n[k] * c2[k];
      }
    }
    return q;
  }
  return p0 - n * hook_sdf(p0);
}

fn ps_point_forces(p: vec3f) -> vec3f {
  var a = vec3f(0.0);
  for (var k = 0u; k < ps_step.point_count; k++) {
    let f0 = ps_step.points[k * PS_POINT_VEC4];
    let f1 = ps_step.points[k * PS_POINT_VEC4 + 1u];
    let f2 = ps_step.points[k * PS_POINT_VEC4 + 2u];
    a += particle_point_force(p, f0.xyz, f1.xyz, f2.x, f2.y, f0.w);
  }
  return a;
}

fn ps_field(p: vec3f) -> vec3f {
  let uv = particle_field_uv(p, ps_step.field_u, ps_step.field_v);
  let w = particle_field_weight(uv);
  if (w <= 0.0) {
    return vec3f(0.0);
  }
  let f = textureSampleLevel(field_texture, field_sampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  return (ps_step.field_x.xyz * f.x + ps_step.field_y.xyz * f.y) * w;
}

fn ps_turbulence(p: vec3f, time: f32) -> vec3f {
  let strength = ps_step.turbulence.x;
  let frequency = ps_step.turbulence.y;
  let evolve = time * ps_step.turbulence.z;
  if (ps_step.turbulence_mode == 1u) {
    let octaves = clamp(i32(ps_step.turbulence.w), 1, 4);
    return vec3f(curl_2d_anim(p.xy * frequency, evolve, octaves, 2.0, 0.5), 0.0) * strength;
  }
  if (ps_step.turbulence_mode == 2u) {
    return curl_3d(p * frequency + vec3f(0.31, 0.53, 0.79) * evolve) * strength;
  }
  return vec3f(0.0);
}

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let input = ps_step.parity;
  if (i >= atomicLoad(&lists.counters[PS_ALIVE_0 + input])) {
    return;
  }
  let cap = ps_step.capacity;
  let slot = lists.data[cap * (1u + input) + i];
  var p = ps_load(slot);
  ps_spawn_parent = p.seed;
  ps_spawn_made = 0u;

  let substeps = max(ps_step.substeps, 1u);
  let h = ps_step.dt / f32(substeps);
  let field_mode = ps_step.field_mode;
  let flat_space = ps_step.dimension == 2u;
  var turbulence = vec3f(0.0);

  for (var s = 0u; s < substeps; s++) {
    let t = ps_step.time + f32(s) * h;
    let p0 = p.position;
    var v = p.velocity;
    var air = ps_step.wind;

    if (field_mode == 3u) {
      // Advected: the particle is a tracer of the field.
      v = ps_field(p0);
    } else {
      if (ps_step.turbulence_mode != 0u && s % max(ps_step.turbulence_every, 1u) == 0u) {
        turbulence = ps_turbulence(p0, t);
      }
      let heat = max(p.temperature - ps_step.ambient, 0.0) * 0.001;
      var a = ps_step.gravity + ps_step.up * (ps_step.buoyancy * heat) + turbulence + ps_point_forces(p0);
      if (field_mode == 1u) {
        air += ps_field(p0);
      } else if (field_mode == 2u) {
        a += ps_field(p0) * ps_step.field_x.w;
      }
      a += hook_force(p, t);
      v += a * h;
      if (field_mode == 1u) {
        // Drag towards the field at the coupling rate, then the ordinary drag towards the air.
        let k = ps_step.field_x.w;
        v = air + (v - air) * exp(-max(k, 0.0) * h);
      }
      v = air + particle_drag(v - air, ps_step.drag_linear, ps_step.drag_quadratic, h);
    }
    if (flat_space) {
      v.z = 0.0;
    }
    var p1 = p0 + v * h;

    // Colliders, in order, each on the segment that is left.
    for (var c = 0u; c < ps_step.collider_count; c++) {
      let c0 = ps_step.colliders[c * PS_COLLIDER_VEC4];
      let kind = bitcast<u32>(c0.x);
      if (kind == 0u) {
        continue;
      }
      let flags = bitcast<u32>(c0.y);
      let c1 = ps_step.colliders[c * PS_COLLIDER_VEC4 + 1u];
      let c2 = ps_step.colliders[c * PS_COLLIDER_VEC4 + 2u];
      let c3 = ps_step.colliders[c * PS_COLLIDER_VEC4 + 3u];
      let inside = (flags & PS_FLAG_INSIDE) != 0u;
      var hit = vec4f(0.0, 0.0, 0.0, -1.0);
      if (kind == 1u) {
        hit = particle_hit_plane(p0, p1, c1);
      } else if (kind == 2u) {
        hit = particle_hit_sphere(p0, p1, c1.xyz, c1.w, inside);
      } else if (kind == 3u) {
        hit = particle_hit_box(p0, p1, c1.xyz, c2.xyz, inside);
      } else if (kind == 4u) {
        hit = ps_hit_sdf(p0, p1);
      }
      if (hit.w < 0.0) {
        continue;
      }
      var n = hit.xyz;
      if (flat_space) {
        n.z = 0.0;
        n = n / max(length(n), 1e-20);
      }
      let contact = ps_contact(kind, flags, c1, c2, p0, p1, hit);
      let impact = max(-dot(v, n), 0.0);
      p1 = contact + n * c2.w;
      v = particle_respond(v, n, c0.z, c0.w);
      p.temperature *= c3.z;
      atomicAdd(&lists.counters[PS_HITS], 1u);
      if ((flags & PS_FLAG_KILL) != 0u) {
        p.alive = false;
      }
      if ((flags & PS_FLAG_SPAWN) != 0u) {
        ps_spawn(p1, v, bitcast<u32>(c3.y), bitcast<u32>(c3.x), p.user);
      }
      var event: ParticleHit;
      event.position = contact;
      event.collider = c;
      event.normal = n;
      event.impact = impact;
      p.velocity = v;
      p.position = p1;
      hook_collide(&p, event);
      v = p.velocity;
      p1 = p.position;
      // Dead (the collider's `kill` or the hook): the colliders after this one must not see it, or
      // a corner where two meet would split or spawn it twice.
      if (!p.alive) {
        break;
      }
    }

    if (flat_space) {
      p1.z = 0.0;
    }
    p.position = p1;
    p.velocity = v;
    if (ps_step.cool_mode == 1u) {
      p.temperature = particle_cool_newton(p.temperature, ps_step.ambient, ps_step.cool_rate, h);
    } else if (ps_step.cool_mode == 2u) {
      p.temperature = particle_cool_linear(p.temperature, ps_step.ambient, ps_step.cool_rate, h);
    }
    p.age += h;
    if (!p.alive) {
      break;
    }
  }

  hook_update(&p, ps_step.time + ps_step.dt, ps_step.dt);

  let too_cold = ps_step.death_temperature > 0.0 && p.temperature < ps_step.death_temperature;
  if (!p.alive || p.age >= p.life || too_cold) {
    hook_die(p);
    let top = atomicAdd(&lists.counters[PS_DEAD], 1u);
    lists.data[top] = slot;
    return;
  }
  ps_store(slot, p);
  let output = 1u - input;
  let k = atomicAdd(&lists.counters[PS_ALIVE_0 + output], 1u);
  lists.data[cap * (1u + output) + k] = slot;
}

// --- Plan ----------------------------------------------------------------------------------------

// The run totals of the plan's threads, scanned in place (Hillis-Steele, as scan.wgsl does).
var<workgroup> ps_plan_sums: array<u32, 256>;
var<workgroup> ps_plan_used: u32;

/** Child counts add up to at most PS_PLAN_SATURATE (associative, so any grouping agrees). */
fn ps_plan_add(a: u32, b: u32) -> u32 {
  return min(a + b, PS_PLAN_SATURATE);
}

@compute @workgroup_size(256)
fn plan(@builtin(local_invocation_id) lid: vec3u) {
  let i = lid.x;
  if (i == 0u) {
    ps_plan_used = min(atomicLoad(&lists.counters[PS_QUEUE]), ps_step.queue_capacity);
  }
  let used = workgroupUniformLoad(&ps_plan_used);
  // Thread i owns the contiguous run of requests [i * per, (i + 1) * per).
  let per = (used + PS_PLAN_GROUP - 1u) / PS_PLAN_GROUP;
  let begin = i * per;
  var run = 0u;
  for (var k = 0u; k < per; k++) {
    let q = begin + k;
    if (q < used) {
      // A single request cannot ask for more than the pool holds.
      run = ps_plan_add(run, min(queue[q].count, ps_step.capacity));
    }
  }
  ps_plan_sums[i] = run;
  workgroupBarrier();
  for (var offset = 1u; offset < PS_PLAN_GROUP; offset = offset << 1u) {
    var t = ps_plan_sums[i];
    if (i >= offset) {
      t = ps_plan_add(t, ps_plan_sums[i - offset]);
    }
    workgroupBarrier();
    ps_plan_sums[i] = t;
    workgroupBarrier();
  }
  // Exclusive prefix of this thread's run (saturation keeps it monotonic, so emit's search works).
  var first = select(0u, ps_plan_sums[max(i, 1u) - 1u], i > 0u);
  for (var k = 0u; k < per; k++) {
    let q = begin + k;
    if (q < used) {
      queue[q].first = first;
      first = ps_plan_add(first, min(queue[q].count, ps_step.capacity));
    }
  }
  if (i != 0u) {
    return;
  }
  let children = ps_plan_sums[PS_PLAN_GROUP - 1u];
  let wanted = children + ps_step.cpu_emit_total;
  let free_slots = atomicLoad(&lists.counters[PS_DEAD]);
  let total = min(wanted, free_slots);
  atomicStore(&lists.counters[PS_QUEUE_USED], used);
  atomicStore(&lists.counters[PS_QUEUE_TOTAL], min(children, total));
  atomicStore(&lists.counters[PS_EMIT_TOTAL], total);
  atomicAdd(&lists.counters[PS_DROPPED_EMITS], wanted - total);
  args[PS_ARGS_EMIT] = (total + PS_GROUP - 1u) / PS_GROUP;
  args[PS_ARGS_EMIT + 1u] = 1u;
  args[PS_ARGS_EMIT + 2u] = 1u;
}

// --- Emit ----------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x;
  if (t >= atomicLoad(&lists.counters[PS_EMIT_TOTAL])) {
    return;
  }
  // plan() clamped the total to the free slots, so the stack cannot run dry.
  let top = atomicSub(&lists.counters[PS_DEAD], 1u) - 1u;
  let slot = lists.data[top];
  let queue_total = atomicLoad(&lists.counters[PS_QUEUE_TOTAL]);

  var source: ParticleSource;
  var e = 0u;
  var base_from = vec3f(0.0);
  var base_to = vec3f(0.0);
  var base_velocity = vec3f(0.0);
  var u = 1.0;
  var temperature_override = 0.0;
  var size_scale = 1.0;
  var kind_override = 0xffffffffu;
  // What names this birth, whatever slot it gets (see DETERMINISM): (emitter, index) for CPU
  // emission, (request seed, index) for a child, whose salts differ by PS_CHILD_SALT.
  var key_a = 0u;
  var key_b = 0u;
  var domain = 0u;

  if (t < queue_total) {
    // The request whose children cover t: the last one whose `first` is <= t.
    let used = atomicLoad(&lists.counters[PS_QUEUE_USED]);
    var lo = 0u;
    var hi = used;
    while (hi - lo > 1u) {
      let mid = (lo + hi) / 2u;
      if (queue[mid].first <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    let q = queue[lo];
    e = min(q.emitter, max(ps_step.emitter_count, 1u) - 1u);
    base_from = q.position;
    base_to = q.position;
    base_velocity = q.velocity;
    temperature_override = q.temperature;
    size_scale = q.size_scale;
    kind_override = q.kind;
    source.spawned = true;
    source.user = q.user;
    source.index = t - q.first;
    source.count = min(q.count, ps_step.capacity);
    key_a = q.seed;
    key_b = source.index;
    domain = PS_CHILD_SALT;
  } else {
    let k = t - queue_total;
    var count = 1u;
    var j = 0u;
    for (var c = 0u; c < ps_step.emitter_count; c++) {
      let first = bitcast<u32>(ps_emitter(c, 3u).w);
      let n = bitcast<u32>(ps_emitter(c, 1u).w);
      if (k >= first && k < first + n) {
        e = c;
        j = k - first;
        count = n;
        break;
      }
    }
    base_from = ps_emitter(e, 0u).xyz;
    base_to = ps_emitter(e, 1u).xyz;
    base_velocity = ps_emitter(e, 8u).xyz;
    key_a = e;
    key_b = j;
    // Rate particles are spread over the step (stratified); burst particles are born at its end
    // and carry the burst's user value.
    let rate_count = count - min(bitcast<u32>(ps_emitter(e, 7u).w), count);
    source.user = select(ps_emitter(e, 9u), vec4f(0.0), j < rate_count);
    if (j < rate_count) {
      u = (f32(j) + to_unorm_4d(ps_birth_hash(key_a, key_b, 0x2545f491u)).x) / f32(rate_count);
    }
    source.spawned = false;
    source.index = j;
    source.count = count;
  }
  source.emitter = e;
  source.position = mix(base_from, base_to, u);
  source.velocity = base_velocity;
  let r3 = to_unorm_4d(ps_birth_hash(key_a, key_b, 0x2545f491u ^ domain));

  let e0 = ps_emitter(e, 0u);
  let e2 = ps_emitter(e, 2u);
  let e3 = ps_emitter(e, 3u);
  let e4 = ps_emitter(e, 4u);
  let e5 = ps_emitter(e, 5u);
  let e6 = ps_emitter(e, 6u);
  let e7 = ps_emitter(e, 7u);
  let r0 = to_unorm_4d(ps_birth_hash(key_a, key_b, 0x68e31da4u ^ domain));
  let r1 = to_unorm_4d(ps_birth_hash(key_a, key_b, 0xb5297a4du ^ domain));
  let dimension = ps_step.dimension;

  let offset = particle_shape_offset(bitcast<u32>(e0.w), e2, e3.xyz, r0.xyz, dimension);
  let direction = particle_cone(e4.xyz, e4.w, r1.xy, dimension);
  var velocity = direction * mix(e5.x, e5.y, r1.z) + base_velocity * e5.w;
  let offset_len = length(offset);
  velocity += select(direction, offset / max(offset_len, 1e-20), offset_len > 1e-9) * e5.z;
  if (dimension == 2u) {
    velocity.z = 0.0;
  }

  var p: Particle;
  // Born at fraction u of the step and moved on for the rest of it.
  p.age = (1.0 - u) * ps_step.dt;
  p.position = mix(base_from, base_to, u) + offset + velocity * p.age;
  if (dimension == 2u) {
    p.position.z = 0.0;
  }
  p.velocity = velocity;
  p.life = mix(e6.x, e6.y, r0.w);
  p.temperature = select(mix(e6.z, e6.w, r1.w), temperature_override, temperature_override > 0.0);
  p.size = mix(e7.x, e7.y, r3.y) * size_scale;
  p.seed = ps_birth_hash(key_a, key_b, 0x1b873593u ^ domain).x;
  p.kind = select(bitcast<u32>(e7.z), kind_override, kind_override != 0xffffffffu);
  p.user = source.user;
  p.alive = true;
  hook_emit(&p, source);

  ps_store(slot, p);
  let output = 1u - ps_step.parity;
  let k = atomicAdd(&lists.counters[PS_ALIVE_0 + output], 1u);
  lists.data[ps_step.capacity * (1u + output) + k] = slot;
}

// --- Finish --------------------------------------------------------------------------------------

@compute @workgroup_size(1)
fn finish() {
  let input = ps_step.parity;
  let output = 1u - input;
  let before = atomicLoad(&lists.counters[PS_ALIVE_0 + input]);
  let alive = atomicLoad(&lists.counters[PS_ALIVE_0 + output]);
  let emitted = atomicLoad(&lists.counters[PS_EMIT_TOTAL]);
  let survivors = alive - emitted;
  atomicAdd(&lists.counters[PS_DIED], before - survivors);
  atomicAdd(&lists.counters[PS_EMITTED], emitted);
  atomicAdd(&lists.counters[PS_SPAWNED], atomicLoad(&lists.counters[PS_QUEUE_TOTAL]));
  atomicAdd(&lists.counters[PS_STEPS], 1u);
  atomicStore(&lists.counters[PS_ALIVE_0 + input], 0u);
  atomicStore(&lists.counters[PS_QUEUE], 0u);
  atomicStore(&lists.counters[PS_EMIT_TOTAL], 0u);
  atomicStore(&lists.counters[PS_QUEUE_TOTAL], 0u);
  let groups = (alive + PS_GROUP - 1u) / PS_GROUP;
  args[PS_ARGS_UPDATE] = groups;
  args[PS_ARGS_UPDATE + 1u] = 1u;
  args[PS_ARGS_UPDATE + 2u] = 1u;
  args[PS_ARGS_DRAW] = groups;
  args[PS_ARGS_DRAW + 1u] = 1u;
  args[PS_ARGS_DRAW + 2u] = 1u;
  args[PS_ARGS_INDIRECT] = 6u;
  args[PS_ARGS_INDIRECT + 1u] = alive;
  args[PS_ARGS_INDIRECT + 2u] = 0u;
  args[PS_ARGS_INDIRECT + 3u] = 0u;
}

// --- Draw ----------------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn draw_sprites(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let list = ps_draw.list;
  if (i >= atomicLoad(&lists.counters[PS_ALIVE_0 + list])) {
    return;
  }
  let slot = lists.data[ps_draw.capacity * (1u + list) + i];
  let p = ps_load(slot);
  let x = clamp(p.age / max(p.life, 1e-6), 0.0, 1.0);

  var s: ParticleSprite;
  s.position = p.position + p.velocity * ps_draw.ahead;
  if (ps_draw.dimension == 2u) {
    s.position.z = 0.0;
  }
  s.size = p.size * ps_draw.size_scale * particle_size_over_life(x, ps_draw.size_curve);
  s.velocity = p.velocity;
  s.param = x;
  var color = ps_draw.tint;
  if (ps_draw.color_mode == 0u) {
    color = blackbody_radiance(p.temperature, ps_draw.t_ref, ps_draw.gamma) * ps_draw.tint;
  }
  // Fade in over the first seconds of life and out over the last share of it: no pops.
  let fade_in = clamp(p.age / max(ps_draw.fade_in, 1e-6), 0.0, 1.0);
  let fade_out = clamp((1.0 - x) / max(ps_draw.fade_out, 1e-6), 0.0, 1.0);
  let twinkle = particle_twinkle(p.seed, ps_draw.time, ps_draw.twinkle, ps_draw.twinkle_rate);
  s.color = color * (ps_draw.intensity * twinkle * fade_in * fade_out);
  s.alpha = 1.0;
  hook_sprite(p, &s, ps_draw.time);

  sprites[i * 3u] = vec4f(s.position, s.size);
  sprites[i * 3u + 1u] = vec4f(s.velocity, s.param);
  sprites[i * 3u + 2u] = vec4f(s.color, s.alpha);
}
