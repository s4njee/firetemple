// The GPU particle framework (Epic 7, story 7.1). Import from here.
//
//   system.ts      createParticleSystem: the pool (dead stack, alive lists, indirect args), fixed
//                  steps in one compute pass (with an `afterStep` callback for per-step kernels),
//                  emitters, forces, colliders, heat, hooks, GPU spawning, repeatable randomness,
//                  statistics. Read its header first.
//   kernels.wgsl   update / plan / emit / finish / draw_sprites, and the hook contract
//   emitter.ts     Emitter options (shapes, rate, bursts, moving emitters, templates)
//   forces.ts      Forces and Heat (gravity, drag, buoyancy, curl turbulence, point forces, the
//                  external velocity field and its mappings, cooling)
//   colliders.ts   Collider descriptions (plane, sphere, box, SDF hook) and their events
//   renderer.ts    createParticleRenderer: sprite instances written on the GPU, drawn indirectly by
//                  the shared sprite renderer (src/gpu/sprites.ts)
//   cameras.ts     orthographicCamera, overlayCamera (canvas-height units), overlayPoint
//   compute.ts     createComputePass: pipeline and bind-group caching, (indirect) dispatch
//   types.ts       the buffer layout, for kernels of your own
//
// The WGSL helpers the kernels use are a library chunk: src/wgsl/particles.wgsl (`particle_`).
//   sort.ts        createDepthSort: back-to-front order by view depth (radix, bitonic, temporal), story 7.9
//   oit.ts         createOit: weighted blended order-independent transparency with an emissive term
//   scan.ts        createScan: the prefix scan the radix sort uses

export * from './cameras.ts';
export * from './colliders.ts';
export * from './compute.ts';
export * from './emitter.ts';
export * from './forces.ts';
export * from './oit.ts';
export * from './renderer.ts';
export * from './scan.ts';
export * from './sort.ts';
export * from './system.ts';
export type { ParticleBuffers } from './types.ts';
