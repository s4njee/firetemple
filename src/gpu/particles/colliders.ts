import type { Vec3 } from './emitter.ts';

// Colliders: surfaces particles cannot pass. Each step the update kernel tests the SEGMENT a particle
// moved along against every collider (src/wgsl/particles.wgsl, `particle_hit_*`), not just where it
// ended, so a particle fast enough to cross a thin wall in one step still hits it; a particle that
// starts inside a solid (spawned there, or the collider moved onto it) is pushed out the nearest way.
// At a contact the particle is put back on the surface, `skin` outside it, and its velocity is
// reflected through `particle_respond` (restitution for the normal part, friction for the rest).
//
// THE EVENT. A contact can also, per collider: `kill` the particle; `cool` it (multiply its
// temperature); `spawn` `spawnCount` children from emitter template `spawnTemplate` at the contact
// point (the GPU spawn queue: no CPU round trip); and it always calls the `hook_collide` WGSL hook,
// which may do any of those itself. Counted in `ParticleStats.hits`.
//
// SDF. `{ type: 'sdf' }` asks the hook `fn hook_sdf(p: vec3f) -> f32` (negative inside the solid);
// the kernel sphere-traces the segment (up to 16 evaluations) and takes the normal from central
// differences (six more). Conservative for any true distance bound; a field that overstates the
// distance can still be tunnelled through.

export type ColliderType = 'plane' | 'sphere' | 'box' | 'sdf';

/** The u32 codes in kernels.wgsl. */
export const COLLIDER_TYPE_CODE: Readonly<Record<ColliderType, number>> = {
  plane: 1,
  sphere: 2,
  box: 3,
  sdf: 4,
};

/** Floats per collider record in the step uniform (four vec4f). */
export const COLLIDER_FLOATS = 16;

/** Bit flags in a collider record; keep in step with kernels.wgsl. */
export const COLLIDER_FLAG = { inside: 1, kill: 2, spawn: 4 } as const;

interface ColliderCommon {
  /** Normal velocity kept after a hit, 0..1. Default 0.4. */
  restitution?: number;
  /** Share of the tangential velocity lost on contact, 0..1. Default 0.1. */
  friction?: number;
  /** Distance kept from the surface after a hit, world units. Default 1e-4. */
  skin?: number;
  /** Kill the particle at contact. Default false. */
  kill?: boolean;
  /** Multiply the temperature at contact (1 = no change). Default 1. */
  cool?: number;
  /** Children per contact from template `spawnTemplate`. Default 0 (none). */
  spawnCount?: number;
  /** Emitter index whose settings the children take. Default 0. */
  spawnTemplate?: number;
  /** Turns the collider off without removing it. Default true. */
  enabled?: boolean;
}

export type Collider = ColliderCommon &
  (
    | {
        type: 'plane';
        /** Unit normal pointing out of the solid. */
        normal: Vec3;
        /** Signed distance of the origin: the plane is dot(normal, p) + offset = 0. */
        offset: number;
      }
    | {
        type: 'sphere';
        center: Vec3;
        radius: number;
        /** true: a container particles stay inside; false (default): a solid ball. */
        inside?: boolean;
      }
    | {
        type: 'box';
        center: Vec3;
        /** Half-size; axis-aligned. */
        half: Vec3;
        /** true: a container; false (default): a solid box. */
        inside?: boolean;
      }
    | { type: 'sdf' }
  );

/** A plane through `point` with outward `normal` (normalised here). */
export function planeThrough(
  point: Vec3,
  normal: Vec3,
): { type: 'plane'; normal: Vec3; offset: number } {
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  return {
    type: 'plane',
    normal: n,
    offset: -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]),
  };
}

export function packCollider(f32: Float32Array, u32: Uint32Array, at: number, c: Collider): void {
  f32.fill(0, at, at + COLLIDER_FLOATS);
  if (c.enabled === false) return;
  const inside = 'inside' in c && c.inside === true;
  const spawn = (c.spawnCount ?? 0) > 0;
  u32[at] = COLLIDER_TYPE_CODE[c.type];
  u32[at + 1] =
    (inside ? COLLIDER_FLAG.inside : 0) |
    (c.kill ? COLLIDER_FLAG.kill : 0) |
    (spawn ? COLLIDER_FLAG.spawn : 0);
  f32[at + 2] = c.restitution ?? 0.4;
  f32[at + 3] = c.friction ?? 0.1;
  if (c.type === 'plane') {
    const length = Math.hypot(c.normal[0], c.normal[1], c.normal[2]) || 1;
    f32[at + 4] = c.normal[0] / length;
    f32[at + 5] = c.normal[1] / length;
    f32[at + 6] = c.normal[2] / length;
    f32[at + 7] = c.offset / length;
  } else if (c.type === 'sphere') {
    f32.set(c.center, at + 4);
    f32[at + 7] = c.radius;
  } else if (c.type === 'box') {
    f32.set(c.center, at + 4);
    f32.set(c.half, at + 8);
  }
  f32[at + 11] = c.skin ?? 1e-4;
  u32[at + 12] = (c.spawnTemplate ?? 0) >>> 0;
  u32[at + 13] = Math.max(0, Math.floor(c.spawnCount ?? 0)) >>> 0;
  f32[at + 14] = c.cool ?? 1;
}
