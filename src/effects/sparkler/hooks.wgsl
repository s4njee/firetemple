// Hooks for the sparkler's particle system (src/gpu/particles/kernels.wgsl splices them into its
// kernels; sparkler.ts says what goes into ps_step.user). Space: the 2D overlay (canvas heights, y up).
//
// FORKING (hook_update). The look of a sparkler is sparks that branch: a burning fleck of metal
// bursts mid-flight into two or three smaller ones, which may burst again. Each spark decides once,
// from its own seed, whether it will fork (probability `chance`) and when (a share of its life
// between `at min` and `at max`); in the step whose end its age crosses that moment it asks for two
// children (three, one time in `three`) of generation kind + 1 through ps_spawn and dies. A spark of
// generation `generations` never forks, so the tree is finite: at most 3^generations leaves.
//
// THE CHILDREN (hook_emit). Born where the parent died (the request's position), heading off either
// side of its direction (the request's velocity; the third straight on) by about `fan`, at `speed`
// times its speed and a little hotter (the burst flares), living a share (`life min` to `life max`)
// of what the parent had left: children are always shorter-lived than their parent.
//
//   ps_step.user[0] = (chance, generations, fan (rad), speed factor)
//   ps_step.user[1] = (at min, at max, life min, life max)       shares, 0..1
//   ps_step.user[2] = (share of forks with three children, 0, 0, 0)
// The request's user (and so a child's `user` when the system stores it) is
// (parent's remaining life, parent's life, 0, 0), which the tests read.

const SPARKLER_FORK_TEMPLATE: u32 = 1u;

fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32) {
  let fork = ps_step.user[0];
  if (!(*p).alive || f32((*p).kind) >= fork.y) {
    return;
  }
  let r = particle_random((*p).seed, 0x7f4a7c15u);
  if (r.x >= fork.x) {
    return;
  }
  let timing = ps_step.user[1];
  let at = (*p).life * mix(timing.x, timing.y, r.y);
  if ((*p).age < at || (*p).age - dt >= at) {
    return;
  }
  let n = select(2u, 3u, r.z < ps_step.user[2].x);
  let remaining = max((*p).life - (*p).age, 0.0);
  let ok = ps_spawn_with(
    (*p).position,
    (*p).velocity,
    n,
    SPARKLER_FORK_TEMPLATE,
    vec4f(remaining, (*p).life, 0.0, 0.0),
    (*p).temperature * 1.05,
    0.85,
    (*p).kind + 1u,
  );
  if (ok) {
    (*p).alive = false;
  }
}

fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (!source.spawned) {
    return;
  }
  let fork = ps_step.user[0];
  let timing = ps_step.user[1];
  let r = particle_random((*p).seed, 0x2c1b3c6du);
  // Born where the parent forked (the request's position), off the parent's velocity.
  let base = source.position;
  let v = source.velocity.xy;
  let len = length(v);
  let dir = select(vec2f(0.0, 1.0), v / max(len, 1e-6), len > 1e-5);
  // Child 0 to one side, child 1 to the other, child 2 straight on; each a little off.
  var side = 0.0;
  if (source.index == 0u) {
    side = -1.0;
  } else if (source.index == 1u) {
    side = 1.0;
  }
  let angle = fork.z * (side * mix(0.55, 1.25, r.x) + (r.y - 0.5) * 0.35);
  let cs = cos(angle);
  let sn = sin(angle);
  let turned = vec2f(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs);
  let speed = max(len, 0.05) * fork.w * mix(0.75, 1.15, r.z);
  (*p).velocity = vec3f(turned * speed, 0.0);
  (*p).position = base + (*p).velocity * (*p).age;
  (*p).life = source.user.x * mix(timing.z, timing.w, r.w);
}
