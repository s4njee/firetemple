/**
 * The memory layout of a particle system, for a kernel of your own that reads or writes it (a trail
 * renderer, a sort, a debug view). Every array is indexed by SLOT, 0..capacity-1; which slots are
 * live is in `lists` (system.ts). All buffers have STORAGE | COPY_SRC | COPY_DST usage; `positions`
 * also VERTEX.
 *
 *   positions    array<vec4f>   xyz position (world units), w age (seconds since birth)
 *   velocities   array<vec4f>   xyz velocity (world units per second), w life (seconds it lives)
 *   attributes   array<vec4f>   x temperature (kelvin), y size (sprite half-width, world units),
 *                               z seed (u32 bits), w kind (u32 bits)
 *   user         array<vec4f>   free, when the system was made with `userData`
 *   lists        16 atomic u32 counters (COUNTER in system.ts: alive0, alive1, dead, ...), then
 *                u32[capacity] dead stack, u32[capacity] alive list 0, u32[capacity] alive list 1.
 *                The live particles are the first counters[system.list] entries of alive list
 *                `system.list`, in no particular order.
 *   args         indirect arguments (ARGS in system.ts): update and draw dispatches over the live
 *                count, and a `drawIndirect` of 6 vertices x live-count instances.
 *
 * The easiest way to get a kernel with this layout is to write it as a hook (kernels.wgsl): the
 * `Particle` struct, `ps_load` / `ps_store` and the bindings are already there.
 */
export interface ParticleBuffers {
  readonly positions: GPUBuffer;
  readonly velocities: GPUBuffer;
  readonly attributes: GPUBuffer;
  readonly user: GPUBuffer | undefined;
  readonly lists: GPUBuffer;
  readonly args: GPUBuffer;
  readonly capacity: number;
  /** Which alive list is current (0 or 1). Changes every step. */
  readonly list: number;
}
