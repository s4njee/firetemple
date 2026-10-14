// Fireworks as multi-stage emitters, entirely on the GPU (story 7.5). These hooks are spliced into
// the particle framework's kernels (src/gpu/particles/kernels.wgsl) by show.ts; nothing here has
// bindings of its own.
//
// A particle's `kind` packs what it is:
//   bits 0..3   role    shell, tail spark, star, trail ember, crossette sub-star, crackle pop, smoke,
//                       glitter glint, break glow
//   bits 4..7   type    peony, chrysanthemum, willow, ring, palm, crossette, crackle, glitter
//   bits 8..11  colour  the emitter salt (fw_salt below)
//   bits 16..31 count   a shell's burst: how many stars it breaks into
//
// The stages, all GPU events through the spawn queue:
//   shell     rises with no drag (the launch speed is solved on the CPU so it peaks at the target),
//             sheds a tail spark every step (hook_update), and dies at its apogee: the first step
//             whose vertical speed is not positive. hook_die then spawns its `count` stars, one
//             break glow and a few smoke puffs.
//   star      hook_emit gives it its direction: a Fibonacci sphere under a random rotation (every
//             spherical type), a ring in a random plane facing the viewer (ring), or the upper
//             sphere (palm). Trailing types shed embers or glitter glints as they fly (hook_update).
//   crossette stars die after about 0.6 s and each splits into four sub-stars in a cross across its
//             path (hook_die). Sub-stars have their own role, so they never split again.
//   crackle   stars die into six tiny white pops each, which wait a random delay and flash for
//             80 ms (hook_sprite does the flash).
// Uniforms: ps_step.user[0] = (star speed scale, trail density, smoke puffs per burst, break glow on)
//           ps_draw.user[0] = (star radiance, ramp-up seconds, ember radiance, pop radiance)
//           ps_draw.user[1] = (white continuum share, break glow radiance, smoke radiance, unused)

const FW_SHELL: u32 = 0u;
const FW_TAIL: u32 = 1u;
const FW_STAR: u32 = 2u;
const FW_EMBER: u32 = 3u;
const FW_SUB: u32 = 4u;
const FW_POP: u32 = 5u;
const FW_SMOKE: u32 = 6u;
const FW_GLINT: u32 = 7u;
const FW_BREAK: u32 = 8u;

const FW_PEONY: u32 = 0u;
const FW_CHRYSANTHEMUM: u32 = 1u;
const FW_WILLOW: u32 = 2u;
const FW_RING: u32 = 3u;
const FW_PALM: u32 = 4u;
const FW_CROSSETTE: u32 = 5u;
const FW_CRACKLE: u32 = 6u;
const FW_GLITTER: u32 = 7u;

const FW_GOLD: u32 = 5u;
const FW_SILVER: u32 = 7u;

// Emitter index of the template every GPU-spawned child is sampled from (show.ts adds it second).
const FW_TEMPLATE: u32 = 1u;
// Children of a crossette star, and pops of a crackle star.
const FW_CROSS_ARMS: u32 = 4u;
const FW_POPS: u32 = 6u;
// Seconds a crackle pop shines.
const FW_POP_TIME: f32 = 0.08;

fn fw_role(kind: u32) -> u32 {
  return kind & 15u;
}

fn fw_type(kind: u32) -> u32 {
  return (kind >> 4u) & 15u;
}

fn fw_colour(kind: u32) -> u32 {
  return (kind >> 8u) & 15u;
}

fn fw_kind(role: u32, shell_type: u32, colour: u32) -> u32 {
  return role | (shell_type << 4u) | (colour << 8u);
}

fn fw_rand(seed: u32, salt: u32) -> vec4f {
  return to_unorm_4d(pcg_4d(vec4u(seed, salt, 0x51ed270bu, 0x2f6b9c11u)));
}

// A uniformly random unit vector from two uniforms.
fn fw_sphere(r: vec2f) -> vec3f {
  let z = 1.0 - 2.0 * r.x;
  let s = sqrt(max(1.0 - z * z, 0.0));
  let a = TAU * r.y;
  return vec3f(s * cos(a), s * sin(a), z);
}

// Point i of n on the golden-angle (Fibonacci) sphere: evenly spread, no clumps, no pole.
fn fw_fibonacci(i: u32, n: u32) -> vec3f {
  let z = 1.0 - (2.0 * f32(i) + 1.0) / f32(n);
  let s = sqrt(max(1.0 - z * z, 0.0));
  let a = f32(i) * 2.39996323;
  return vec3f(s * cos(a), s * sin(a), z);
}

// Rotates v by the uniformly random rotation of a burst (Shoemake's unit quaternion).
fn fw_rotate(v: vec3f, burst: u32) -> vec3f {
  let r = fw_rand(burst, 0x0b5e55edu);
  let a = sqrt(1.0 - r.x);
  let b = sqrt(r.x);
  let q = vec4f(a * sin(TAU * r.y), a * cos(TAU * r.y), b * sin(TAU * r.z), b * cos(TAU * r.z));
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// The unit normal of a ring burst's plane: random, but within about 40 degrees of the view axis so
// the ring reads as a ring and not as a line.
fn fw_ring_axis(burst: u32) -> vec3f {
  let r = fw_rand(burst, 0x7219a3c1u);
  return normalize(vec3f((r.x - 0.5) * 1.4, (r.y - 0.5) * 1.4, 1.0));
}

fn fw_ring(i: u32, n: u32, burst: u32) -> vec3f {
  let basis = particle_orthonormal(fw_ring_axis(burst));
  let a = TAU * (f32(i) + fw_rand(burst, 0x9d2c5680u).x) / f32(n);
  return basis[0] * cos(a) + basis[1] * sin(a);
}

// Launch speed of a type's stars at size 1, world units (canvas heights) per second.
fn fw_star_speed(t: u32) -> f32 {
  switch (t) {
    case 2u: {
      return 0.48;
    }
    case 3u: {
      return 0.43;
    }
    case 4u: {
      return 0.38;
    }
    case 5u, 6u, 7u: {
      return 0.36;
    }
    default: {
      return 0.41;
    }
  }
}

fn fw_star_life(t: u32) -> f32 {
  switch (t) {
    case 1u: {
      return 1.9;
    }
    case 2u: {
      return 3.4;
    }
    case 4u: {
      return 2.4;
    }
    case 5u: {
      return 0.6;
    }
    case 6u: {
      return 0.9;
    }
    case 7u: {
      return 2.0;
    }
    default: {
      return 1.7;
    }
  }
}

// Linear drag per role and type, 1/s. Shells have none, so the CPU's launch solution is exact.
fn fw_drag(kind: u32) -> f32 {
  let role = fw_role(kind);
  let t = fw_type(kind);
  if (role == FW_SHELL || role == FW_BREAK) {
    return 0.0;
  }
  if (role == FW_STAR || role == FW_SUB) {
    if (t == FW_WILLOW) {
      return 2.0;
    }
    if (t == FW_PALM) {
      return 1.3;
    }
    return 1.6;
  }
  if (role == FW_EMBER) {
    return select(3.0, 4.0, t == FW_WILLOW);
  }
  if (role == FW_SMOKE) {
    return 1.5;
  }
  return 3.0;
}

fn hook_force(p: Particle, time: f32) -> vec3f {
  var a = -fw_drag(p.kind) * p.velocity;
  let role = fw_role(p.kind);
  // The break glow stays where the shell broke; smoke is nearly neutrally buoyant.
  if (role == FW_BREAK) {
    a -= ps_step.gravity;
  } else if (role == FW_SMOKE) {
    a -= ps_step.gravity * 0.92;
  }
  return a;
}

fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32) {
  let kind = (*p).kind;
  let role = fw_role(kind);
  let t = fw_type(kind);
  // Out of the orthographic camera's depth range: gone (it would be clipped anyway).
  if (abs((*p).position.z) > 0.48) {
    (*p).alive = false;
    return;
  }
  // Charcoal cools (Newton, towards 300 K) at a rate per role: tail sparks in a fraction of a
  // second, willow embers over two, stars hardly at all.
  var cool = 0.0;
  if (role == FW_TAIL) {
    cool = 1.6;
  } else if (role == FW_EMBER) {
    cool = 1.0;
    if (t == FW_WILLOW) {
      cool = 0.35;
    } else if (t == FW_PALM) {
      cool = 0.7;
    }
  } else if (role == FW_STAR || role == FW_SUB) {
    cool = 0.12;
  }
  (*p).temperature = 300.0 + ((*p).temperature - 300.0) * exp(-cool * dt);
  if (role == FW_SHELL) {
    // The rising shell's spark tail, thicker for a palm (whose shell carries a comet).
    let tail = select(1u, 3u, t == FW_PALM);
    ps_spawn_with(
      (*p).position,
      (*p).velocity * 0.2,
      tail,
      FW_TEMPLATE,
      vec4f(0.0),
      0.0,
      1.0,
      fw_kind(FW_TAIL, t, FW_GOLD),
    );
    // Apogee: the burst happens in hook_die.
    if ((*p).velocity.y <= 0.0) {
      (*p).alive = false;
    }
    return;
  }
  if (role == FW_STAR && (*p).age > 0.04) {
    // Trailing stars shed embers (glitter: glints) at `chance` per step, scaled by the density.
    var chance = 0.0;
    if (t == FW_CHRYSANTHEMUM) {
      chance = 0.45;
    } else if (t == FW_WILLOW) {
      chance = 0.9;
    } else if (t == FW_PALM) {
      chance = 1.0;
    } else if (t == FW_GLITTER) {
      chance = 0.5;
    }
    let r = fw_rand((*p).seed, ps_step.step_index);
    if (r.x < chance * ps_step.user[0].y) {
      let child = select(FW_EMBER, FW_GLINT, t == FW_GLITTER);
      let count = select(1u, 2u, t == FW_PALM);
      ps_spawn_with(
        (*p).position,
        (*p).velocity * 0.15,
        count,
        FW_TEMPLATE,
        vec4f(0.0),
        0.0,
        1.0,
        fw_kind(child, t, fw_colour(kind)),
      );
    }
  }
}

fn hook_die(p: Particle) {
  let role = fw_role(p.kind);
  let t = fw_type(p.kind);
  let c = fw_colour(p.kind);
  if (role == FW_SHELL) {
    let count = p.kind >> 16u;
    let burst = vec4f(bitcast<f32>(p.seed), f32(count), ps_step.user[0].x, 0.0);
    ps_spawn_with(p.position, p.velocity, count, FW_TEMPLATE, burst, 0.0, 1.0, fw_kind(FW_STAR, t, c));
    if (ps_step.user[0].w > 0.0) {
      ps_spawn_with(p.position, p.velocity, 1u, FW_TEMPLATE, burst, 0.0, 1.0, fw_kind(FW_BREAK, t, c));
    }
    let puffs = u32(ps_step.user[0].z + 0.5);
    ps_spawn_with(p.position, p.velocity, puffs, FW_TEMPLATE, burst, 0.0, 1.0, fw_kind(FW_SMOKE, t, c));
    return;
  }
  if (role == FW_STAR && t == FW_CROSSETTE) {
    ps_spawn_with(p.position, p.velocity, FW_CROSS_ARMS, FW_TEMPLATE, vec4f(0.0), 0.0, 1.0, fw_kind(FW_SUB, t, c));
  } else if (role == FW_STAR && t == FW_CRACKLE) {
    ps_spawn_with(p.position, p.velocity * 0.3, FW_POPS, FW_TEMPLATE, vec4f(0.0), 0.0, 1.0, fw_kind(FW_POP, t, FW_SILVER));
  }
}

fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  let kind = (*p).kind;
  let role = fw_role(kind);
  let t = fw_type(kind);
  let r = fw_rand((*p).seed, 0x1b873593u);
  let q = fw_rand((*p).seed, 0xcc9e2d51u);
  if (!source.spawned) {
    // A shell from the launcher: its velocity came from the emitter; it lives until its apogee.
    (*p).life = 30.0;
    (*p).temperature = 2300.0;
    (*p).size = select(0.0026, 0.0036, t == FW_PALM);
    return;
  }
  // The template has speed 0 and inherit 1: the velocity is the parent's, exactly.
  let parent = (*p).velocity;
  (*p).temperature = 2100.0 + 300.0 * r.w;
  if (role == FW_TAIL) {
    (*p).velocity = parent + fw_sphere(r.xy) * 0.05;
    (*p).life = 0.25 + 0.3 * r.z;
    (*p).size = 0.0017;
  } else if (role == FW_STAR) {
    let n = max(u32(source.user.y), 1u);
    let burst = bitcast<u32>(source.user.x);
    var direction = fw_rotate(fw_fibonacci(source.index, n), burst);
    var speed = fw_star_speed(t) * source.user.z;
    if (t == FW_RING) {
      direction = fw_ring(source.index, n, burst);
    } else {
      speed *= 0.95 + 0.1 * r.x;
    }
    if (t == FW_PALM) {
      direction = normalize(vec3f(direction.x, mix(direction.y, abs(direction.y), 0.75), direction.z));
    }
    (*p).velocity = parent + direction * speed;
    (*p).life = fw_star_life(t) * (0.9 + 0.2 * r.y);
    var size = 0.003;
    if (t == FW_PALM) {
      size = 0.0055;
    } else if (t == FW_WILLOW || t == FW_GLITTER) {
      size = 0.0026;
    }
    (*p).size = size * (0.9 + 0.2 * r.z);
  } else if (role == FW_SUB) {
    let d = parent / max(length(parent), 1e-6);
    let basis = particle_orthonormal(d);
    let arm = select(basis[0], basis[1], source.index >= 2u) * select(1.0, -1.0, (source.index & 1u) == 1u);
    (*p).velocity = parent * 0.45 + arm * 0.24;
    (*p).life = 0.9 + 0.3 * r.y;
    (*p).size = 0.0028;
  } else if (role == FW_EMBER) {
    (*p).velocity = parent + fw_sphere(r.xy) * 0.03;
    var life = 0.5 + 0.4 * r.z;
    if (t == FW_WILLOW) {
      life = 1.6 + 1.0 * r.z;
    } else if (t == FW_PALM) {
      life = 0.8 + 0.5 * r.z;
    }
    (*p).life = life;
    (*p).size = select(0.0016, 0.0022, t == FW_PALM);
  } else if (role == FW_POP) {
    let delay = 0.03 + 0.55 * r.x;
    (*p).user = vec4f(delay, 0.0, 0.0, 0.0);
    (*p).velocity = parent + fw_sphere(q.xy) * (0.03 + 0.05 * r.y);
    (*p).life = delay + FW_POP_TIME;
    (*p).size = 0.0022;
  } else if (role == FW_GLINT) {
    let delay = 0.15 + 0.35 * r.x;
    (*p).user = vec4f(delay, 0.0, 0.0, 0.0);
    (*p).velocity = parent + fw_sphere(q.xy) * 0.02;
    (*p).life = delay + 0.5 + 0.7 * r.y;
    (*p).size = 0.0018;
  } else if (role == FW_SMOKE) {
    (*p).velocity = parent * 0.3 + fw_sphere(r.xy) * vec3f(0.06, 0.06, 0.0);
    (*p).life = 4.0 + 2.0 * r.z;
    (*p).size = 0.05 + 0.04 * r.w;
  } else if (role == FW_BREAK) {
    (*p).velocity = vec3f(0.0);
    (*p).life = 0.5;
    (*p).size = 0.07 * source.user.z;
  }
}

// --- Look ----------------------------------------------------------------------------------------

// Emission colour of a star's salt, linear Rec.709, largest channel 1: the CIE 1931 colour of the
// salt's molecular bands (notes.md has the bands), pulled into the gamut by adding white.
fn fw_salt(c: u32, temperature: f32) -> vec3f {
  switch (c) {
    case 0u: {
      return vec3f(1.0, 0.0, 0.007); // strontium red: SrCl 636 nm, SrOH 606 / 682 nm
    }
    case 1u: {
      return vec3f(0.0, 1.0, 0.4); // barium green: BaCl 507-532 nm
    }
    case 2u: {
      return vec3f(0.21, 0.0, 1.0); // copper blue: CuCl 420-460 nm
    }
    case 3u: {
      return vec3f(1.0, 0.26, 0.0); // sodium yellow: the D lines, 589 nm
    }
    case 4u: {
      return vec3f(1.0, 0.98, 0.95); // magnesium white: hot MgO continuum
    }
    case 6u: {
      return vec3f(1.0, 0.0, 0.72); // purple: strontium and copper together
    }
    case 7u: {
      return blackbody_tint(3300.0); // titanium silver: white-hot metal sparks
    }
    default: {
      // Charcoal gold: incandescent carbon, a blackbody near 2000 K.
      return blackbody_tint(temperature);
    }
  }
}

fn fw_star_colour(c: u32, temperature: f32, white: f32) -> vec3f {
  return mix(fw_salt(c, temperature), vec3f(1.0), white);
}

fn hook_sprite(p: Particle, s: ptr<function, ParticleSprite>, time: f32) {
  let role = fw_role(p.kind);
  let t = fw_type(p.kind);
  let c = fw_colour(p.kind);
  let x = clamp(p.age / max(p.life, 1e-6), 0.0, 1.0);
  let star = ps_draw.user[0].x;
  let ramp = max(ps_draw.user[0].y, 1e-3);
  let ember = ps_draw.user[0].z;
  let pop = ps_draw.user[0].w;
  let white = ps_draw.user[1].x;
  let gold = blackbody_radiance(p.temperature, 2000.0, 0.5);
  var colour = vec3f(0.0);
  var size = p.size;
  if (role == FW_SHELL) {
    colour = gold * ember * 1.5;
  } else if (role == FW_TAIL) {
    colour = gold * ember * (1.0 - x) * (1.0 - x);
  } else if (role == FW_STAR || role == FW_SUB) {
    // Ramp up over `ramp` seconds (no one-frame flash), burn, then die away over the last 30%.
    let on = smoothstep(0.0, ramp, p.age);
    // A crossette star splits at full brightness: its four sub-stars carry on its light.
    let out = select(1.0 - smoothstep(0.7, 1.0, x), 1.0, role == FW_STAR && t == FW_CROSSETTE);
    var level = star;
    if (t == FW_GLITTER) {
      level *= 0.45;
    } else if (t == FW_PALM) {
      level *= 1.2;
    }
    colour = fw_star_colour(c, p.temperature, white) * (level * on * out);
    if (c == FW_GOLD) {
      colour *= 0.8;
    }
  } else if (role == FW_EMBER) {
    let tail = select(1.0 - x, (1.0 - x) * (1.0 - x), t == FW_CHRYSANTHEMUM);
    colour = gold * ember * tail * smoothstep(0.0, 0.05, p.age);
  } else if (role == FW_POP) {
    let a = (p.age - p.user.x) / FW_POP_TIME;
    if (a > 0.0 && a < 1.0) {
      colour = vec3f(1.0, 0.98, 0.95) * pop * sin(PI * a);
    }
  } else if (role == FW_GLINT) {
    // Glitter: each glint strobes at 3 to 4 Hz with its own phase, a sharp peak and a dark gap.
    let a = p.age - p.user.x;
    if (a > 0.0) {
      let h = fw_rand(p.seed, 0x3c6ef372u);
      let w = 0.5 + 0.5 * sin(TAU * ((3.0 + h.x) * time + h.y));
      colour = fw_salt(FW_SILVER, 0.0) * pop * 0.5 * pow(w, 10.0) * (1.0 - x) * smoothstep(0.0, 0.05, a);
    }
  } else if (role == FW_SMOKE) {
    let envelope = smoothstep(0.0, 0.25, x) * (1.0 - smoothstep(0.4, 1.0, x));
    colour = mix(fw_salt(c, 2000.0), vec3f(0.6), 0.6) * ps_draw.user[1].z * envelope;
    size *= 1.0 + 1.5 * x;
    (*s).velocity = vec3f(0.0);
  } else if (role == FW_BREAK) {
    // A soft glow where the shell broke: up over the same ramp as the stars, down in 0.15 s.
    let up = smoothstep(0.0, ramp, p.age);
    let down = exp(-max(p.age - ramp, 0.0) / 0.15);
    colour = mix(fw_salt(c, 2200.0), vec3f(1.0), 0.5) * ps_draw.user[1].y * up * down;
    size *= 0.7 + 0.3 * up;
    (*s).velocity = vec3f(0.0);
  }
  (*s).color = colour;
  (*s).size = size * ps_draw.size_scale;
}
