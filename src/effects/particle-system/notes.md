## How it works

This is the validation scene of the Epic 7 particle framework (`src/gpu/particles/`, read `system.ts` first). It is not meant to be pretty; every switch shows one thing the framework does.

**The pool.** Particles live in storage buffers indexed by slot: `positions` (xyz, age), `velocities` (xyz, life), `attributes` (temperature, size, seed, kind) and an optional free `user` vec4. Which slots are in use is kept on the GPU in a `lists` buffer: an atomic counter block, a dead stack of free slots and two alive lists that swap roles every step. One step is four dispatches in `kernels.wgsl`:

```wgsl
update   // indirect, one thread per live particle: forces, colliders, cooling, hooks;
         // survivors appended to the other alive list, the dead pushed on the dead stack
plan     // one workgroup: a prefix sum of the spawn requests' child counts; this step's births,
         // the spawn queue's children first, clamped to free slots
emit     // indirect, one thread per birth: pop a slot, sample it from its emitter, append it
finish   // one thread: next step's dispatch arguments, the draw arguments, the statistics
```

Every kernel that touches particles is dispatched indirectly with arguments the previous kernel wrote, so the cost follows the live count, not the capacity, and nothing is read back to the CPU. All the steps of a frame go into one compute pass. A last kernel (`draw_sprites`, `renderer.ts`) writes one 12-float instance per live particle, compacted, into a buffer the shared sprite renderer (`src/gpu/sprites.ts`) draws with `drawIndirect`.

**Emitters** (`emitter.ts`): point, segment, box, sphere shell, disc and ring; a rate with a fractional carry (exact to one particle at any frame rate), bursts, a launch cone, speed, life, temperature and size ranges, a kind tag. `moving emitter` sweeps the main emitter round a circle at three radians a second: particles are placed along the path each step covered, so the line is continuous. `burst every 1 s` fires a sphere burst; with `children per burst particle` each of those particles, as it dies, asks for children through `ps_spawn` in a `hook_die` hook, and `on hit: split` does the same from `hook_collide`. Both go through the GPU spawn queue (an atomic append in the update kernel, consumed by the same step's emit kernel), with no CPU round trip. `count` is the capacity (1 024 to 1 048 576) and the emission rate is set so the pool stays about `fill` full.

**Forces** (`forces.ts`): gravity, linear drag towards the wind, buoyancy in proportion to temperature above the air, curl-noise turbulence (2D `curl_2d_anim` or 3D `curl_3d`), a point attractor or vortex, and an external velocity texture (`velocity field`). The scene's texture is a baked pair of counter-rotating vortices in image heights per second with y down, exactly the layout of the Epic 6 fluid's `fieldsView`, read through `overlayFieldMapping`; `advect` makes particles tracers of it, `drag` pulls them towards it.

**Colliders** (`colliders.ts`): plane, sphere, box and an SDF from a hook (here a wavy floor). The update kernel tests the segment each particle moved along, not only where it ended, so nothing tunnels through. Restitution, friction, and per collider kill, cool or spawn. In 2D faint outlines show where the collider and the point force are.

**Spaces.** `2d` is the overlay space: world units are canvas heights, origin bottom-left (`overlayCamera`). `3d` is a world with the same numbers, drawn with the forward renderer's orbit camera over a ground the particles land on, and the sprites fade softly against the scene depth.

**Colour.** Each sprite is `blackbody_radiance(T)` times an intensity, so the Newtonian cooling alone takes particles from yellow-white through orange to deep red.

**The live count** is read back from the counters a few frames late, in a small submit of its own, and shown in the HUD as a row of its own (the effect's `stats()`: live particles, the pool, children spawned, births dropped).

## Cost

GPU time, measured with another browser sharing the GPU (Apple M1 Max, 1920 × 1080, defaults, tail included): 1.00 ms per frame on Dawn and 1.69 ms for one frame in Chrome 155 (median of 3 loads, 1.45 to 1.81; `docs/studies/epic-7.md`, `docs/studies/browser-check.md`). Tier B on this machine by both readings; no integrated GPU or phone has been measured. Bundle: 91.7 kB.

Indicative readings, Apple M1 Max, 1920 × 1080, headless Chrome, HUD "GPU" span of one frame including the HDR tail, two sweeps (three and five loads) with another agent's work on the same GPU, so noisy; ranges over both:

| Capacity               |    Live |                                 Frame |
| ---------------------- | ------: | ------------------------------------: |
| 65 536 (default)       |  52 000 | 1.1 to 7.3 ms (medians 1.4, 2.9, 4.4) |
| 1 048 576, `fill` 0.05 |  52 000 |      1.6 to 2.5 ms (medians 2.2, 2.3) |
| 262 144                | 200 000 |      3.2 to 7.6 ms (medians 5.0, 3.5) |
| 1 048 576, `fill` 0.95 | 995 000 |    10.8 to 24.8 ms (medians 11, 18.8) |

A last check of the default, after every change, read 2.37 ms (2.31 to 2.52, three loads).

The framework alone, measured on Dawn with the benchmark harness method (slope of one more unit in the same command buffer; `PARTICLE_BENCH=1 npx vitest run tests/particles.test.ts -t cost`), one step plus an eighth of a sprite write, 2D, no turbulence: about 0.08 to 0.13 ms for 50 000 live particles whether the pool holds 65 536, 262 144 or 1 048 576; about 0.18 ms for 250 000; about 0.64 ms for a million (0.74 with 2D curl noise). The step costs what the live particles cost; capacity is memory, not time. At 1080p what the default scene costs is mostly the tail and the overdraw of 50 000 blended sprites, not the simulation.

Memory: 48 bytes a particle of state (64 with `user` data), 12 bytes of list entries, and 48 bytes of sprite instance: about 113 MB at the 1 048 576 maximum.

The default is Tier B. A million particles is at or over the Tier C budget (12 ms) on this machine, depending on what else the GPU is doing.

## Pitfalls

- **Mapping a buffer that is still in an unsubmitted encoder.** The first statistics read-back copied the counters into the caller's encoder and mapped the buffer two calls later. Several `step` calls in one command buffer (the benchmark, warm-ups) mapped it before submit: "used in submit while pending map", and the whole command buffer was dropped silently, which showed up as timestamps that were never written. The copy now goes in a small submit of its own.
- **A collider that spawns children on contact cascades.** Children born on the surface fall back onto it and split again until the pool is full. The scene's split hook spares particles of the children's kind; the collider's own `spawnCount` has no such filter, so give its template an outward speed.
- **The same buffer cannot be written as storage and read as indirect arguments in one dispatch.** The arguments live in their own buffer, written only by the `plan` and `finish` kernels, which are dispatched directly.
- WGSL names: `step` is a built-in function (the uniform is `ps_step`, or every chunk that calls `step()` breaks), and `template` is reserved (the spawn request's field is `emitter`).
- Dawn quantises timestamps (65 µs steps here): a benchmark unit of one step reads as zero slope. Measure eight steps a unit.
- The HUD's per-pass rows are per label, so a label that changes every frame grows a row per frame. The first version put the live count in the sprite pass's label; it is now an effect stats row, and every pass label is fixed.
- **Over a light page** the default fountain reads as a saturated orange-yellow cloud with a shape (checked in the browser over the light hero), so `scorecard.lightPage` is `yes`; sparse settings (few, small, cool particles) turn into flecks, as `embers` does.
- A million particles is a bright cloud: the preset lowers the size and the intensity; at the default intensity the core saturates.

## When to use it

To check what the framework does before building on it, and as the scene the scale study (7.10) sweeps with `count`. Effects built on the framework (`embers`, and the rest of Epic 7) are the things to ship. It is Tier B at its defaults on this machine; the browser readings are indicative only.

## References

- [docs/effect-authoring.md](../../../docs/effect-authoring.md), "Particles": how to build an effect on the framework.
- G. Thomas, "Compute-Based GPU Particle Systems", GDC 2014: the dead list, alive lists and indirect dispatch.
- J. Turánszki, "GPU-based particle simulation", Wicked Engine blog, 2017: the same scheme with an emit pass sized on the GPU.
- R. Bridson, J. Hourihan, M. Nordenstam, "Curl-Noise for Procedural Fluid Flow", SIGGRAPH 2007.
- W. T. Reeves, "Particle Systems — a Technique for Modeling a Class of Fuzzy Objects", SIGGRAPH 1983.
- Water Temple's particle framework (`src/gpu/particles/`), from which `compute.ts`, `cameras.ts` and the emitter sampling were ported.
