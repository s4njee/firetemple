// particles.wgsl -- pure helpers for GPU particle systems (story 7.1): emitter shapes, launch cones,
// drag, cooling, size over life, twinkle, colliders and point forces. The framework in
// src/gpu/particles/ (kernels.wgsl) uses all of it; a custom particle kernel can pick what it needs.
// No bindings, no state: everything a function needs is an argument.
//
// Random numbers
//   particle_random(index: u32, salt: u32) -> vec4f     four independent uniforms in [0, 1) from one
//                                                       pcg_4d: the same index and salt give the same
//                                                       numbers on every device
//
// Emitter shapes (offsets from the emitter centre; r is uniform in [0, 1)^3)
//   PARTICLE_SHAPE_POINT, _SEGMENT, _BOX, _SPHERE, _DISC  u32 codes, in step with src/gpu/particles/emitter.ts
//   particle_shape_offset(shape, extent: vec4f, axis: vec3f, r: vec3f, dimension: u32) -> vec3f
//       POINT 0; SEGMENT uniformly along -extent.xyz .. +extent.xyz (extent is the half-vector);
//       BOX uniformly in the box of half-size extent.xyz; SPHERE uniformly in the shell between
//       radius extent.w (inner) and extent.x (outer), a ball for inner 0 (in 2D: an annulus in xy);
//       DISC uniformly in the annulus between extent.w and extent.x in the plane normal to `axis`
//       (a ring when the two radii are equal; in 2D the plane is xy whatever `axis` is). In 2D
//       (dimension 2u) z is always 0.
//   particle_orthonormal(n: vec3f) -> mat2x3f          two unit vectors perpendicular to unit n and to
//                                                       each other (columns), continuous except near +-y
//   particle_cone(direction: vec3f, spread: f32, r: vec2f, dimension: u32) -> vec3f
//       a unit vector at most `spread` radians from unit `direction`, uniform over the cap of the
//       sphere (3D) or the arc of the circle (2D: direction.xy, rotated in the plane)
//
// Motion
//   particle_drag(v_rel: vec3f, linear: f32, quadratic: f32, dt: f32) -> vec3f
//       the exact solution of dv/dt = -(linear + quadratic |v|) v after dt seconds (v relative to the
//       air). Unconditionally stable for any dt >= 0 and non-negative coefficients: the speed only
//       ever shrinks and the direction is kept. linear in 1/s, quadratic in 1/(world unit).
//   particle_point_force(p: vec3f, center: vec3f, axis: vec3f, attract: f32, swirl: f32, radius: f32) -> vec3f
//       acceleration towards `center` of size attract * radius^2 / (d^2 + radius^2) (positive pulls,
//       negative pushes) plus a swirl of size swirl * the same falloff around unit `axis` (counter-
//       clockwise seen from +axis). Finite at the centre (zero there), ~1/d^2 far away.
//
// Temperature (kelvin)
//   particle_cool_newton(t: f32, ambient: f32, rate: f32, dt: f32) -> f32
//       exact Newtonian cooling: ambient + (t - ambient) exp(-rate dt); rate in 1/s
//   particle_cool_linear(t: f32, ambient: f32, rate: f32, dt: f32) -> f32
//       t falls by rate * dt (kelvin per second) but never below ambient
//
// Look
//   particle_size_over_life(x: f32, curve: vec4f) -> f32
//       size multiplier at life fraction x (clamped to 0..1): curve.x at birth, rising (or falling)
//       smoothly to curve.y at x = curve.w, then smoothly to curve.z at death. (1, 1, 1, w) is 1.
//   particle_twinkle(seed: u32, time: f32, amount: f32, rate: f32) -> f32
//       a per-particle brightness factor in [1 - amount, 1]: two sines with frequencies between
//       0.5 and 1 times `rate` Hz and phases from `seed`. The rate is capped at
//       PARTICLE_TWINKLE_MAX_HZ (4 Hz) and amount is clamped to 0..1, so no particle can flicker
//       faster than the flash guidance allows whatever the caller asks for.
//
// Colliders. Each `particle_hit_*` takes the segment a particle moved along in one step (p0 -> p1)
// and returns vec4f(normal, t): t in [0, 1] is where along the segment it first touched the
// surface, the normal points away from the solid at that point; t < 0 means no contact. A particle
// that starts inside the solid gets t = 0 and the normal towards the nearest way out, so it is
// pushed out rather than let through.
//   particle_hit_plane(p0, p1, plane: vec4f) -> vec4f   solid on the side where dot(n, p) + w < 0
//   particle_hit_sphere(p0, p1, center, radius, inside: bool) -> vec4f
//       inside false: a solid ball; inside true: a hollow container the particle must stay in
//   particle_hit_box(p0, p1, center, half: vec3f, inside: bool) -> vec4f
//       axis-aligned. inside false: a solid box; inside true: a container
//   particle_respond(v: vec3f, n: vec3f, restitution: f32, friction: f32) -> vec3f
//       velocity after a contact with unit normal n: the normal part reversed and scaled by
//       restitution (0 sticks, 1 is elastic) only if it was moving into the surface, the tangential
//       part scaled by 1 - friction
//
// External fields
//   particle_field_uv(p: vec3f, row_u: vec4f, row_v: vec4f) -> vec2f
//       texture uv of a particle position through an affine map: (dot(row_u, (p, 1)), dot(row_v, (p, 1)))
//   particle_field_weight(uv: vec2f) -> f32             1 inside [0, 1]^2, falling linearly to 0 two
//                                                       percent of the texture outside it
//
// Cost: every function is a few ALU ops (particle_drag: one exp, one divide; particle_twinkle: two
// sin; particle_random one pcg_4d, about 25 integer ops). Nothing loops or samples.

#include "hash.wgsl"
#include "math.wgsl"

const PARTICLE_SHAPE_POINT: u32 = 0u;
const PARTICLE_SHAPE_SEGMENT: u32 = 1u;
const PARTICLE_SHAPE_BOX: u32 = 2u;
const PARTICLE_SHAPE_SPHERE: u32 = 3u;
const PARTICLE_SHAPE_DISC: u32 = 4u;
const PARTICLE_TWINKLE_MAX_HZ: f32 = 4.0;

fn particle_random(index: u32, salt: u32) -> vec4f {
  return to_unorm_4d(pcg_4d(vec4u(index, salt, 0x9e3779b9u, 0x85ebca6bu)));
}

fn particle_orthonormal(n: vec3f) -> mat2x3f {
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.99);
  let t1 = normalize(cross(n, up));
  let t2 = cross(n, t1);
  return mat2x3f(t1, t2);
}

fn particle_shape_offset(shape: u32, extent: vec4f, axis: vec3f, r: vec3f, dimension: u32) -> vec3f {
  var offset = vec3f(0.0);
  let outer = extent.x;
  let inner = clamp(extent.w, 0.0, outer);
  if (shape == PARTICLE_SHAPE_SEGMENT) {
    offset = extent.xyz * (r.x * 2.0 - 1.0);
  } else if (shape == PARTICLE_SHAPE_BOX) {
    offset = extent.xyz * (r * 2.0 - 1.0);
  } else if (shape == PARTICLE_SHAPE_SPHERE || shape == PARTICLE_SHAPE_DISC) {
    let flat_shape = dimension == 2u || shape == PARTICLE_SHAPE_DISC;
    if (flat_shape) {
      // Uniform in the annulus: r^2 uniform between inner^2 and outer^2.
      let rho = sqrt(mix(inner * inner, outer * outer, r.y));
      let a = r.x * TAU;
      var basis = mat2x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0));
      if (dimension != 2u) {
        basis = particle_orthonormal(normalize(axis));
      }
      offset = (basis[0] * cos(a) + basis[1] * sin(a)) * rho;
    } else {
      // Uniform in the shell: r^3 uniform between inner^3 and outer^3, direction uniform.
      let z = r.x * 2.0 - 1.0;
      let a = r.y * TAU;
      let s = sqrt(max(1.0 - z * z, 0.0));
      let rho = pow(mix(inner * inner * inner, outer * outer * outer, r.z), 1.0 / 3.0);
      offset = vec3f(s * cos(a), z, s * sin(a)) * rho;
    }
  }
  if (dimension == 2u) {
    offset.z = 0.0;
  }
  return offset;
}

fn particle_cone(direction: vec3f, spread: f32, r: vec2f, dimension: u32) -> vec3f {
  if (dimension == 2u) {
    let d = direction.xy / max(length(direction.xy), 1e-20);
    return vec3f(rotate_2d(d, (r.x * 2.0 - 1.0) * spread), 0.0);
  }
  let cos_theta = mix(1.0, cos(clamp(spread, 0.0, PI)), r.x);
  let sin_theta = sqrt(max(1.0 - cos_theta * cos_theta, 0.0));
  let phi = r.y * TAU;
  let basis = particle_orthonormal(direction);
  return direction * cos_theta + (basis[0] * cos(phi) + basis[1] * sin(phi)) * sin_theta;
}

fn particle_drag(v_rel: vec3f, linear: f32, quadratic: f32, dt: f32) -> vec3f {
  let s0 = length(v_rel);
  if (s0 <= 0.0 || dt <= 0.0) {
    return v_rel;
  }
  let a = max(linear, 0.0);
  let b = max(quadratic, 0.0);
  // ds/dt = -a s - b s^2 has s(t) = a s0 e / (a + b s0 (1 - e)), e = exp(-a t); for a -> 0 it
  // becomes s0 / (1 + b s0 t). Both only ever shrink s, for any t.
  var s = s0 / (1.0 + b * s0 * dt);
  if (a > 1e-6) {
    let e = exp(-a * dt);
    s = a * s0 * e / (a + b * s0 * (1.0 - e));
  }
  return v_rel * (s / s0);
}

fn particle_point_force(
  p: vec3f,
  center: vec3f,
  axis: vec3f,
  attract: f32,
  swirl: f32,
  radius: f32,
) -> vec3f {
  let d = center - p;
  let d2 = dot(d, d);
  if (d2 <= 1e-20) {
    return vec3f(0.0);
  }
  let r2 = max(radius * radius, 1e-12);
  let falloff = r2 / (d2 + r2);
  let toward = d * inverseSqrt(d2);
  var around = cross(axis, -toward);
  let around_len = length(around);
  around = select(vec3f(0.0), around / max(around_len, 1e-20), around_len > 1e-6);
  return (toward * attract + around * swirl) * falloff;
}

fn particle_cool_newton(t: f32, ambient: f32, rate: f32, dt: f32) -> f32 {
  return ambient + (t - ambient) * exp(-max(rate, 0.0) * dt);
}

fn particle_cool_linear(t: f32, ambient: f32, rate: f32, dt: f32) -> f32 {
  if (t <= ambient) {
    return t;
  }
  return max(t - max(rate, 0.0) * dt, ambient);
}

fn particle_size_over_life(x: f32, curve: vec4f) -> f32 {
  let k = clamp(x, 0.0, 1.0);
  let peak_at = clamp(curve.w, 1e-4, 1.0 - 1e-4);
  if (k < peak_at) {
    return mix(curve.x, curve.y, smoothstep(0.0, peak_at, k));
  }
  return mix(curve.y, curve.z, smoothstep(peak_at, 1.0, k));
}

fn particle_twinkle(seed: u32, time: f32, amount: f32, rate: f32) -> f32 {
  let h = to_unorm_4d(pcg_4d(vec4u(seed, 0x27d4eb2fu, 0x165667b1u, 0xd3a2646cu)));
  let hz = clamp(rate, 0.0, PARTICLE_TWINKLE_MAX_HZ);
  let f1 = hz * mix(0.5, 1.0, h.x);
  let f2 = hz * mix(0.5, 1.0, h.y);
  // Callers wrap `time` (the framework every 2048 s) so f32 keeps its precision.
  let w = 0.6 * sin(TAU * (f1 * time + h.z)) + 0.4 * sin(TAU * (f2 * time + h.w));
  return 1.0 - clamp(amount, 0.0, 1.0) * (0.5 + 0.5 * w);
}

fn particle_hit_plane(p0: vec3f, p1: vec3f, plane: vec4f) -> vec4f {
  let n = plane.xyz;
  let d0 = dot(n, p0) + plane.w;
  let d1 = dot(n, p1) + plane.w;
  if (d1 >= 0.0 && d0 >= 0.0) {
    return vec4f(n, -1.0);
  }
  if (d0 < 0.0) {
    return vec4f(n, 0.0);
  }
  return vec4f(n, clamp(d0 / (d0 - d1), 0.0, 1.0));
}

fn particle_hit_sphere(p0: vec3f, p1: vec3f, center: vec3f, radius: f32, inside: bool) -> vec4f {
  let a0 = p0 - center;
  let a1 = p1 - center;
  let r2 = radius * radius;
  let in0 = dot(a0, a0) < r2;
  let in1 = dot(a1, a1) < r2;
  let len0 = length(a0);
  let out0 = select(vec3f(0.0, 1.0, 0.0), a0 / max(len0, 1e-20), len0 > 1e-12);
  if (!inside) {
    if (in0) {
      return vec4f(out0, 0.0);
    }
    // Entering a ball: the smaller root of |a0 + s (a1 - a0)| = radius, if it lies on the segment.
    let d = a1 - a0;
    let qa = dot(d, d);
    let qb = dot(a0, d);
    let qc = dot(a0, a0) - r2;
    let disc = qb * qb - qa * qc;
    if (qa <= 1e-20 || disc < 0.0) {
      return vec4f(0.0, 0.0, 0.0, -1.0);
    }
    let s = (-qb - sqrt(disc)) / qa;
    if (s < 0.0 || s > 1.0) {
      return vec4f(0.0, 0.0, 0.0, -1.0);
    }
    let hit = a0 + d * s;
    return vec4f(hit / max(length(hit), 1e-20), s);
  }
  if (!in0) {
    return vec4f(-out0, 0.0);
  }
  if (in1) {
    return vec4f(0.0, 0.0, 0.0, -1.0);
  }
  // Leaving the container: the larger root.
  let d = a1 - a0;
  let qa = dot(d, d);
  let qb = dot(a0, d);
  let qc = dot(a0, a0) - r2;
  let s = clamp((-qb + sqrt(max(qb * qb - qa * qc, 0.0))) / max(qa, 1e-20), 0.0, 1.0);
  let hit = a0 + d * s;
  return vec4f(-hit / max(length(hit), 1e-20), s);
}

fn particle_hit_box(p0: vec3f, p1: vec3f, center: vec3f, half: vec3f, inside: bool) -> vec4f {
  let a0 = p0 - center;
  let a1 = p1 - center;
  let d = a1 - a0;
  if (!inside) {
    let q0 = abs(a0) - half;
    if (max(q0.x, max(q0.y, q0.z)) < 0.0) {
      // Already inside: out through the nearest face.
      var n = vec3f(sign(a0.x), 0.0, 0.0);
      if (q0.y >= q0.x && q0.y >= q0.z) {
        n = vec3f(0.0, sign(a0.y), 0.0);
      } else if (q0.z >= q0.x && q0.z >= q0.y) {
        n = vec3f(0.0, 0.0, sign(a0.z));
      }
      return vec4f(select(n, vec3f(0.0, 1.0, 0.0), dot(n, n) < 0.5), 0.0);
    }
    // Slabs: the segment is in the box between the largest entry and the smallest exit.
    var enter = 0.0;
    var leave = 1.0;
    var n = vec3f(0.0);
    for (var k = 0u; k < 3u; k++) {
      if (abs(d[k]) < 1e-20) {
        if (abs(a0[k]) >= half[k]) {
          return vec4f(0.0, 0.0, 0.0, -1.0);
        }
        continue;
      }
      let ta = (-half[k] - a0[k]) / d[k];
      let tb = (half[k] - a0[k]) / d[k];
      let t_in = min(ta, tb);
      let t_out = max(ta, tb);
      if (t_in > enter) {
        enter = t_in;
        n = vec3f(0.0);
        n[k] = -sign(d[k]);
      }
      leave = min(leave, t_out);
    }
    if (enter > leave || dot(n, n) < 0.5) {
      return vec4f(0.0, 0.0, 0.0, -1.0);
    }
    return vec4f(n, enter);
  }
  // Container: the first wall the segment crosses on its way out.
  var first = 2.0;
  var n = vec3f(0.0);
  for (var k = 0u; k < 3u; k++) {
    if (abs(a0[k]) > half[k]) {
      // Outside already: back in through this face.
      var m = vec3f(0.0);
      m[k] = -sign(a0[k]);
      return vec4f(m, 0.0);
    }
    if (abs(a1[k]) > half[k] && abs(d[k]) > 1e-20) {
      let wall = select(-half[k], half[k], d[k] > 0.0);
      let t = clamp((wall - a0[k]) / d[k], 0.0, 1.0);
      if (t < first) {
        first = t;
        n = vec3f(0.0);
        n[k] = -sign(d[k]);
      }
    }
  }
  if (first > 1.0) {
    return vec4f(0.0, 0.0, 0.0, -1.0);
  }
  return vec4f(n, first);
}

fn particle_respond(v: vec3f, n: vec3f, restitution: f32, friction: f32) -> vec3f {
  let vn = dot(v, n);
  let normal = n * vn;
  let tangent = (v - normal) * (1.0 - clamp(friction, 0.0, 1.0));
  if (vn >= 0.0) {
    return normal + tangent;
  }
  return tangent - normal * clamp(restitution, 0.0, 1.0);
}

fn particle_field_uv(p: vec3f, row_u: vec4f, row_v: vec4f) -> vec2f {
  let h = vec4f(p, 1.0);
  return vec2f(dot(row_u, h), dot(row_v, h));
}

fn particle_field_weight(uv: vec2f) -> f32 {
  let outside = max(max(-uv, uv - vec2f(1.0)), vec2f(0.0));
  return clamp(1.0 - max(outside.x, outside.y) / 0.02, 0.0, 1.0);
}
