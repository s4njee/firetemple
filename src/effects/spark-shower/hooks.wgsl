// Hooks for the spark shower's particle system (src/gpu/particles/kernels.wgsl splices them into its
// kernels; shower.ts says what goes into ps_step.user). Space: the 2D overlay (canvas heights, y up).
//
// SPLIT ON IMPACT (hook_collide). A spark of generation `kind` that hits any collider faster than
// `min impact` splits, with probability `chance`, into exactly `children` sparks of generation
// kind + 1, born at the contact point; the parent dies. A generation equal to `generations` never
// splits, so a shower can never cascade: every spark descends from at most `generations` splits.
// The children are cooler (`heat` times the parent's temperature) and smaller (`size`), and fly off
// in a fan of half-angle `fan` around the parent's rebound, at `speed` times its rebound speed, never
// into the surface (hook_emit).
//
//   ps_step.user[0] = (children, chance, generations, min impact speed)
//   ps_step.user[1] = (heat factor, speed factor, fan half-angle (rad), size factor)
//   ps_step.user[2] = (anvil x, anvil y, anvil scale, 0)      the 'sdf' collider, when there is one
//
// THE ANVIL (hook_sdf). A blacksmith's anvil as a union of exact distances (a face, a waist, feet
// and a tapering horn), so the sphere tracing in the kernel never overshoots it. Origin at the middle
// of the top of the face; one unit is `scale` canvas heights.

const SHOWER_CHILD_TEMPLATE: u32 = 2u;

fn shower_box(p: vec2f, half: vec2f) -> f32 {
  let d = abs(p) - half;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

// Inigo Quilez's uneven capsule: a segment from a (radius ra) to b (radius rb), exact.
fn shower_uneven_capsule(p_in: vec2f, a: vec2f, b_in: vec2f, ra: f32, rb: f32) -> f32 {
  let p = p_in - a;
  let b = b_in - a;
  let h = dot(b, b);
  var q = vec2f(dot(p, vec2f(b.y, -b.x)), dot(p, b)) / h;
  q.x = abs(q.x);
  let k = ra - rb;
  let c = vec2f(sqrt(h - k * k), k);
  let side = c.x * q.y - c.y * q.x;
  let m = dot(c, q);
  let n = dot(q, q);
  if (side < 0.0) {
    return sqrt(h * n) - ra;
  }
  if (side > c.x) {
    return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
  }
  return m - ra;
}

fn shower_anvil(q: vec2f) -> f32 {
  var d = shower_box(q - vec2f(0.0, -0.05), vec2f(0.2, 0.05));
  d = min(d, shower_box(q - vec2f(-0.01, -0.155), vec2f(0.08, 0.06)));
  d = min(d, shower_box(q - vec2f(-0.01, -0.24), vec2f(0.15, 0.028)));
  d = min(d, shower_uneven_capsule(q, vec2f(0.19, -0.035), vec2f(0.36, -0.004), 0.034, 0.006));
  return d;
}

fn hook_sdf(q: vec3f) -> f32 {
  let anvil = ps_step.user[2];
  let scale = max(anvil.z, 1e-4);
  return shower_anvil((q.xy - anvil.xy) / scale) * scale;
}

fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {
  let split = ps_step.user[0];
  // A spark already split by an earlier collider in this sub-step is gone: no second split.
  if (!(*p).alive || f32((*p).kind) >= split.z || hit.impact < split.w) {
    return;
  }
  if (ps_random((*p).seed, 0x51ed270bu).x >= split.y) {
    return;
  }
  let child = ps_step.user[1];
  let n = u32(split.x + 0.5);
  // The rebound and the surface normal go to the children through the request's `user`.
  let ok = ps_spawn_with(
    (*p).position,
    (*p).velocity,
    n,
    SHOWER_CHILD_TEMPLATE,
    vec4f(hit.normal.xy, 0.0, 0.0),
    (*p).temperature * child.x,
    child.w,
    (*p).kind + 1u,
  );
  if (ok && n > 0u) {
    (*p).alive = false;
  }
}

fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (!source.spawned) {
    return;
  }
  let child = ps_step.user[1];
  let r = particle_random((*p).seed, 0x2c1b3c6du);
  // The template has no speed of its own and inherits the whole rebound.
  let base = (*p).position - (*p).velocity * (*p).age;
  let rebound = (*p).velocity.xy;
  let normal = source.user.xy;
  let len = length(rebound);
  var dir = select(normal, rebound / max(len, 1e-6), len > 1e-4);
  let angle = (r.x * 2.0 - 1.0) * child.z;
  let cs = cos(angle);
  let sn = sin(angle);
  dir = vec2f(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs);
  // Never into the surface: mirror a direction that points into it.
  let into = dot(dir, normal);
  if (into < 0.05) {
    dir = normalize(dir - (into - 0.05) * 2.0 * normal);
  }
  let speed = max(len * child.y * mix(0.45, 1.0, r.y), 0.12 * mix(0.6, 1.2, r.z));
  (*p).velocity = vec3f(dir * speed, 0.0);
  (*p).position = base + (*p).velocity * (*p).age;
}
