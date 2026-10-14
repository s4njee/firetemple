import { createFixedStepper, type FixedStepper } from '../loop.ts';
import { noProfiler, type PassProfiler } from '../profiler.ts';
import type { ShaderSource } from '../shader.ts';
import { defineUniformStruct, uniformArray } from '../uniforms.ts';
import { COLLIDER_FLOATS, packCollider, type Collider } from './colliders.ts';
import { createComputePass, type ComputePass, type Resources } from './compute.ts';
import {
  createEmitterState,
  EMITTER_FLOATS,
  packEmitter,
  takeEmitterStep,
  type Emitter,
  type EmitterOptions,
  type EmitterState,
  type Vec3,
} from './emitter.ts';
import { defaultForces, defaultHeat, MAX_POINT_FORCES, type Forces, type Heat } from './forces.ts';
import kernels from './kernels.wgsl';

/*
 * The GPU particle system (story 7.1): a fixed-capacity pool of particles that live, die and are
 * recycled entirely on the GPU, with emitters, forces, colliders, temperature and GPU-side spawning.
 *
 *   const system = createParticleSystem({ device, capacity: 65536, dimension: 2 });
 *   const sparks = system.addEmitter({ shape: 'point', rate: 400, speed: [0.5, 1], spread: 0.4,
 *                                      life: [0.5, 1.2], temperature: [2200, 2600], size: [0.002, 0.004] });
 *   system.forces.gravity = [0, -1, 0];
 *   system.colliders.push(planeThrough([0, 0, 0], [0, 1, 0]));
 *   const renderer = createParticleRenderer(system, { camera: cameraBuffer });   // renderer.ts
 *   // every frame:
 *   sparks.moveTo(tip);                         // a moving emitter leaves no gaps
 *   system.advance(encoder, time.delta);        // fixed steps, one compute pass
 *   // (or `advance(encoder, delta, { afterStep(pass, step) { ... } })` to run a kernel of your own
 *   //  after every step, in the same pass)
 *   renderer.encode(encoder, time.delta);       // one sprite instance per live particle
 *   renderer.draw(encoder, { target: tail.scene.view, clear: { r: 0, g: 0, b: 0, a: 0 } });
 *
 * POOL AND RECYCLING (the classic GPU scheme). Particle state lives in storage buffers indexed by SLOT
 * (`positions`, `velocities`, `attributes`, optional `user`; layout in types.ts). Which slots are in
 * use is kept in `lists`: an atomic counter block, a dead stack of free slots, and two alive lists
 * that swap roles every step. The update kernel reads one alive list and appends each survivor to
 * the other, pushing each dead slot back on the stack; the emit kernel pops slots off the stack and
 * appends the new particles to the same output list. Every kernel that touches particles is
 * dispatched INDIRECTLY with arguments the previous kernel wrote, so a step costs in proportion to
 * the live count, not the capacity, and the CPU never reads anything back. alive + dead = capacity
 * always holds and no slot is ever in both or neither (tests/particles.test.ts checks it after
 * thousands of births and deaths). One step is four dispatches (update, plan, emit, finish; see
 * kernels.wgsl); every step of a frame goes into ONE compute pass. The simpler alternative, a ring
 * cursor over the whole capacity with dead slots drawn at size 0, was not built: its update and draw
 * cost follow the capacity, which for a pool sized for bursts (fireworks) is many times the live
 * count, and a ring overwrites live particles when a burst outruns it.
 *
 * MEASURED (Apple M1 Max, Dawn, one step plus an eighth of a sprite write, the slope of one more unit
 * in a command buffer; `PARTICLE_BENCH=1 npx vitest run tests/particles.test.ts -t cost`): 50 000
 * live particles cost 0.07 to 0.13 ms per step whether the pool holds 65 536, 262 144 or 1 048 576;
 * 250 000 cost about 0.2 ms and 1 000 000 about 0.65 ms (0.74 with 2D curl noise). The capacity costs
 * memory (48 bytes of state and 12 of lists a slot, 64 and 12 with `userData`), not time. The fixed
 * overhead is two small dispatches a step (plan: one workgroup; finish: one thread), which the HUD
 * cannot resolve. Spawn requests are planned by a prefix sum in that one workgroup (each of 256
 * threads sums a contiguous run of requests, then a workgroup scan): the sparkler forking at
 * 200 000 sparks a second (thousands of requests a step, 66 000 live) costs 0.12 to 0.15 ms a step
 * against 0.07 to 0.11 with forks off; the earlier single-thread walk of the queue cost 1.2 ms
 * (`-t "spawn requests"` in the same bench). A queue of tens of thousands of requests still plans
 * in one dispatch.
 *
 * EMISSION. CPU emitters (`addEmitter`, at most MAX_EMITTERS) say how many particles each step; the
 * GPU samples them (emitter.ts). `burst(n, user)` hands a vec4 to `hook_emit` with the burst. GPU
 * EVENTS spawn with no CPU round trip: a hook calls `ps_spawn(position, velocity, count, emitter,
 * user)` (or a collider has `spawnCount`), which appends a request to the spawn queue with an
 * atomic; the same step's emit pass gives the requests' children priority over CPU emission. A
 * request names an emitter as its TEMPLATE (often one with rate 0). `hook_emit` sees the request's
 * `position`, `velocity`, `count`, `user` and the child's `index` in its `ParticleSource`. If the
 * pool is full, emission is clamped and counted (`stats.droppedEmits`); if the queue is full,
 * requests are dropped and counted (`stats.droppedSpawns`).
 *
 * TIME. `advance(encoder, delta)` runs whole steps of `fixedStep` from an accumulator
 * (`createFixedStepper`, at most `maxSteps` a frame, a stalled tab skips the backlog), so motion is
 * the same at 60 and 144 Hz; the renderer extrapolates by the leftover fraction of a step so a display
 * faster than the step rate does not judder. `substeps` splits each step's integration and collision
 * (emission stays once per step). Each step writes its own slot of a uniform ring (STEP_SLOTS
 * slots): steps encoded before one submit never share parameters, so at most STEP_SLOTS steps may be
 * encoded per submit (`warmup` submits in chunks).
 *
 * AFTER EACH STEP. `advance`, `step` and `warmup` take `{ afterStep(pass, step) }`: it is called
 * once per step, after the step's last dispatch, with the open compute pass (dispatch into it; do
 * not end it) and `step` = { index in this call, the alive list that now holds the particles, the
 * step's ParticleStep uniform binding (its own ring slot, so a kernel built from `system.source`
 * can bind it at binding 0), the simulated time at the end of the step, dt }. Per-step records
 * (ribbon trails: src/effects/particle-trails/) cost one dispatch a step instead of a pass a step,
 * and the renderer's extrapolation still works because the steps come from `advance`.
 *
 * RANDOMNESS is a hash of (what the birth is, step counter, seed), never of the slot or of the
 * order threads reach an atomic (kernels.wgsl, DETERMINISM): nothing random is drawn on the CPU per
 * particle, and the same seed replays the same run, particle for particle (as a multiset; the slots
 * and the list order differ). Runs with a full pool or a full queue are the exception: which
 * births are dropped then depends on the order.
 *
 * HOOKS (kernels.wgsl lists them) are WGSL spliced into the kernels at creation: `hooks.code` may
 * define any of hook_force, hook_update, hook_collide, hook_die, hook_emit, hook_sdf, hook_sprite;
 * the others get empty defaults. `params.user` is four vec4f the hooks read as `ps_step.user[i]`.
 *
 * STATISTICS. `stats` is the latest live count and running totals, read back asynchronously a few
 * frames late in a small submit of its own (for the HUD); `readStats()` waits for the GPU and is exact
 * (for tests and tools).
 */

/** Emitters per system. */
export const MAX_EMITTERS = 8;
/** Colliders per system. */
export const MAX_COLLIDERS = 8;
/** Steps that can be encoded before one submit (one uniform slot each). */
export const STEP_SLOTS = 32;
/** The largest pool: the update dispatch may not exceed 65535 workgroups of 64. */
export const MAX_PARTICLE_CAPACITY = 65535 * 64;
/** Bytes per particle per attribute buffer (one vec4f). */
export const PARTICLE_ATTRIBUTE_BYTES = 16;

/** Counter slots in the lists buffer; keep in step with kernels.wgsl. */
export const COUNTER = {
  alive0: 0,
  alive1: 1,
  dead: 2,
  queue: 3,
  emitTotal: 4,
  queueTotal: 5,
  emitted: 6,
  died: 7,
  spawned: 8,
  droppedSpawns: 9,
  droppedEmits: 10,
  hits: 11,
  queueUsed: 12,
  steps: 13,
} as const;
const COUNTERS = 16;

/** Byte offsets in the args buffer; keep in step with kernels.wgsl. */
export const ARGS = { update: 0, emit: 12, draw: 24, indirect: 36 } as const;
const ARGS_BYTES = 64;
/** Bytes per spawn request (`ParticleSpawn` in kernels.wgsl). */
const SPAWN_BYTES = 80;

/** The per-step uniform block (`ParticleStep` in kernels.wgsl). */
export const ParticleStepUniform = defineUniformStruct('ParticleStep', {
  time: 'f32',
  dt: 'f32',
  substeps: 'u32',
  parity: 'u32',
  gravity: 'vec3f',
  dimension: 'u32',
  wind: 'vec3f',
  drag_linear: 'f32',
  up: 'vec3f',
  drag_quadratic: 'f32',
  buoyancy: 'f32',
  ambient: 'f32',
  cool_rate: 'f32',
  cool_mode: 'u32',
  death_temperature: 'f32',
  step_index: 'u32',
  emitter_count: 'u32',
  collider_count: 'u32',
  turbulence: 'vec4f',
  turbulence_mode: 'u32',
  turbulence_every: 'u32',
  point_count: 'u32',
  field_mode: 'u32',
  field_u: 'vec4f',
  field_v: 'vec4f',
  field_x: 'vec4f',
  field_y: 'vec4f',
  capacity: 'u32',
  queue_capacity: 'u32',
  cpu_emit_total: 'u32',
  seed: 'u32',
  user: uniformArray('vec4f', 4),
  emitters: uniformArray('vec4f', MAX_EMITTERS * (EMITTER_FLOATS / 4)),
  colliders: uniformArray('vec4f', MAX_COLLIDERS * (COLLIDER_FLOATS / 4)),
  points: uniformArray('vec4f', MAX_POINT_FORCES * 3),
});

/** The renderer's uniform block (`ParticleDraw` in kernels.wgsl); filled by renderer.ts. */
export const ParticleDrawUniform = defineUniformStruct('ParticleDraw', {
  list: 'u32',
  capacity: 'u32',
  dimension: 'u32',
  color_mode: 'u32',
  ahead: 'f32',
  time: 'f32',
  intensity: 'f32',
  t_ref: 'f32',
  gamma: 'f32',
  twinkle: 'f32',
  twinkle_rate: 'f32',
  size_scale: 'f32',
  size_curve: 'vec4f',
  tint: 'vec3f',
  fade_in: 'f32',
  fade_out: 'f32',
  user: uniformArray('vec4f', 4),
});

const STEP_STRIDE = Math.ceil(ParticleStepUniform.size / 256) * 256;
const STEP_OFFSET: Readonly<Record<string, number>> = Object.fromEntries(
  ParticleStepUniform.layout.map((field) => [field.name, field.offset / 4]),
);

const HOOK_DEFAULTS: Readonly<Record<string, string>> = {
  hook_force: 'fn hook_force(p: Particle, time: f32) -> vec3f {\n  return vec3f(0.0);\n}',
  hook_update: 'fn hook_update(p: ptr<function, Particle>, time: f32, dt: f32) {}',
  hook_collide: 'fn hook_collide(p: ptr<function, Particle>, hit: ParticleHit) {}',
  hook_die: 'fn hook_die(p: Particle) {}',
  hook_emit: 'fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {}',
  hook_sdf: 'fn hook_sdf(q: vec3f) -> f32 {\n  return 1e9;\n}',
  hook_sprite: 'fn hook_sprite(p: Particle, s: ptr<function, ParticleSprite>, time: f32) {}',
};

const USER_ON = `@group(0) @binding(4) var<storage, read_write> ps_user: array<vec4f>;
fn ps_load_user(i: u32) -> vec4f {
  return ps_user[i];
}
fn ps_store_user(i: u32, value: vec4f) {
  ps_user[i] = value;
}
`;
const USER_OFF = `fn ps_load_user(i: u32) -> vec4f {
  return vec4f(0.0);
}
fn ps_store_user(i: u32, value: vec4f) {}
`;

export interface ParticleHooks {
  /** WGSL defining any of the hook functions listed in kernels.wgsl; the rest get defaults. */
  code?: string;
  /** Include targets the code needs, e.g. `libraryChunks(noisetex)`. */
  chunks?: Readonly<Record<string, string>>;
}

/** The kernels' source with the system's runtime chunks: the hooks, the uniform structs, user data. */
export function particleKernelSource(hooks: ParticleHooks = {}, userData = false): ShaderSource {
  const code = hooks.code ?? '';
  const defaults = Object.entries(HOOK_DEFAULTS)
    .filter(([name]) => !new RegExp(`\\bfn\\s+${name}\\s*\\(`).test(code))
    .map(([, fn]) => fn);
  return {
    label: 'particles/kernels.wgsl',
    code: kernels.code,
    chunks: {
      ...kernels.chunks,
      ...hooks.chunks,
      'particle-step.wgsl': ParticleStepUniform.wgsl,
      'particle-draw.wgsl': ParticleDrawUniform.wgsl,
      'particle-user.wgsl': userData ? USER_ON : USER_OFF,
      'particle-hooks.wgsl': `// Hooks (src/gpu/particles/kernels.wgsl lists them).\n${code}\n${defaults.join('\n')}\n`,
    },
  };
}

export interface ParticleSystemOptions {
  device: GPUDevice;
  /** Most particles alive at once. Fixed; make a new system to change it. */
  capacity: number;
  /** 2 keeps z at 0 everywhere and makes cones fans and discs circles in xy. Default 3. */
  dimension?: 2 | 3;
  /** Seconds per simulation step. Default 1/60. */
  fixedStep?: number;
  /** Most steps one `advance` runs. Default 4. */
  maxSteps?: number;
  /** Integration sub-steps per step (collisions are tested in each). Default 1. */
  substeps?: number;
  /** Spawn requests one step can hold. Default 256. */
  queueCapacity?: number;
  /** Store a free vec4f per particle (`Particle.user`). Default false (16 bytes a particle saved). */
  userData?: boolean;
  hooks?: ParticleHooks;
  /** A filterable 2D texture whose .xy is a velocity, for `forces.field`. Settable later. */
  field?: GPUTextureView;
  /** Varies every random number. Default 1. */
  seed?: number;
  profiler?: PassProfiler;
  label?: string;
}

/** Running totals and the live count, from the counter block. */
export interface ParticleStats {
  alive: number;
  /** Free slots (capacity - alive). */
  dead: number;
  /** Particles born since creation (CPU emitters and spawned children). */
  emitted: number;
  died: number;
  /** Children born from spawn requests. */
  spawned: number;
  /** Spawn requests that did not fit in the queue. */
  droppedSpawns: number;
  /** Births that did not fit in the pool. */
  droppedEmits: number;
  /** Collider contacts. */
  hits: number;
  steps: number;
}

/** A full copy of the state, for tests and tools (`read()`). */
export interface ParticleSnapshot {
  stats: ParticleStats;
  /** Slots in the current alive list, in list order. */
  alive: Uint32Array;
  /** Slots on the dead stack, bottom first. */
  dead: Uint32Array;
  /** Per slot: xyz position, age. */
  positions: Float32Array;
  /** Per slot: xyz velocity, life. */
  velocities: Float32Array;
  /** Per slot: temperature, size, seed bits, kind bits (read the last two through a Uint32Array). */
  attributes: Float32Array;
  /** Per slot, when the system has user data. */
  user?: Float32Array;
}

/** One step, as `afterStep` sees it. */
export interface ParticleStepInfo {
  /** Which step of this call, 0 first. */
  index: number;
  /** Steps this call runs. */
  steps: number;
  /** The alive list that holds the live particles after this step (0 or 1). */
  list: number;
  /** This step's `ParticleStep` uniform (its own ring slot), for a kernel built from `source`. */
  uniform: GPUBufferBinding;
  /** Simulation seconds at the end of this step (unwrapped). */
  time: number;
  dt: number;
}

export interface ParticleStepOptions {
  /**
   * Called after every step, with the step's compute pass still open: dispatch kernels of your own
   * into it (reading `system.args` for an indirect dispatch over the live particles is fine). Do
   * not end the pass.
   */
  afterStep?(pass: GPUComputePassEncoder, step: ParticleStepInfo): void;
}

export interface ParticleSystem {
  readonly device: GPUDevice;
  readonly capacity: number;
  readonly dimension: 2 | 3;
  readonly label: string;
  /** Live: gravity, drag, buoyancy, turbulence, point forces, the external field. */
  readonly forces: Forces;
  /** Live: cooling and the death temperature. */
  readonly heat: Heat;
  /** Live list, at most MAX_COLLIDERS; push, splice or edit entries between frames. */
  readonly colliders: Collider[];
  readonly emitters: readonly Emitter[];
  /** Live settings. */
  readonly params: {
    fixedStep: number;
    maxSteps: number;
    substeps: number;
    /** Four vec4f the hooks read as `ps_step.user[0..3]`. */
    user: [Vec4, Vec4, Vec4, Vec4];
  };
  /** The kernels' source as compiled, for a renderer or a custom kernel that shares the layout. */
  readonly source: ShaderSource;
  readonly hasUserData: boolean;
  /** State buffers, indexed by slot (types.ts has the layout). */
  readonly positions: GPUBuffer;
  readonly velocities: GPUBuffer;
  readonly attributes: GPUBuffer;
  readonly user: GPUBuffer | undefined;
  readonly lists: GPUBuffer;
  readonly args: GPUBuffer;
  /** Which alive list holds the live particles now (0 or 1). */
  readonly list: number;
  /** Simulation seconds stepped so far. */
  readonly time: number;
  /** Leftover fraction of a step after the latest `advance`, 0..1 (for render extrapolation). */
  readonly alpha: number;
  readonly field: GPUTextureView;
  readonly fieldSampler: GPUSampler;
  /** Latest statistics read back from the GPU (a few frames late; zeros until the first). */
  readonly stats: Readonly<ParticleStats>;

  addEmitter(options: EmitterOptions): Emitter;
  /** Sets the external velocity texture `forces.field` reads (a 1x1 zero texture until then). */
  setField(view: GPUTextureView | undefined): void;
  /** Runs the whole fixed steps `delta` seconds add up to; returns how many. */
  advance(encoder: GPUCommandEncoder, delta: number, options?: ParticleStepOptions): number;
  /** Runs exactly `steps` steps of `dt` seconds (default `fixedStep`), whatever the clock says. */
  step(
    encoder: GPUCommandEncoder,
    steps?: number,
    dt?: number,
    options?: ParticleStepOptions,
  ): void;
  /**
   * Simulates `seconds` right now in steps of `dt` (default 1/30 s) in its own submits, so a scene
   * starts full. Emitters stay where they are.
   */
  warmup(seconds: number, dt?: number, options?: ParticleStepOptions): void;
  /** Kills every particle (all slots back on the dead stack); keeps emitters and settings. */
  reset(): void;
  /** Waits for the GPU and returns exact statistics. */
  readStats(): Promise<ParticleStats>;
  /** Waits for the GPU and returns the whole state. */
  read(): Promise<ParticleSnapshot>;
  destroy(): void;
}

export type Vec4 = [number, number, number, number];

const TURBULENCE_MODE = { none: 0, '2d': 1, '3d': 2 } as const;
const FIELD_MODE = { none: 0, drag: 1, accel: 2, advect: 3 } as const;
const COOLING_MODE = { none: 0, newton: 1, linear: 2 } as const;
/** Calls of advance/step between two statistics read-backs. */
const STATS_EVERY = 6;
/** Simulation time handed to the kernels wraps here so f32 keeps its precision. */
const TIME_WRAP = 4096;

function statsFrom(counters: Uint32Array, capacity: number): ParticleStats {
  // Between steps one alive counter is the live count and the other is zero (finish clears it).
  const alive = (counters[COUNTER.alive0] ?? 0) + (counters[COUNTER.alive1] ?? 0);
  return {
    alive,
    dead: counters[COUNTER.dead] ?? capacity - alive,
    emitted: counters[COUNTER.emitted] ?? 0,
    died: counters[COUNTER.died] ?? 0,
    spawned: counters[COUNTER.spawned] ?? 0,
    droppedSpawns: counters[COUNTER.droppedSpawns] ?? 0,
    droppedEmits: counters[COUNTER.droppedEmits] ?? 0,
    hits: counters[COUNTER.hits] ?? 0,
    steps: counters[COUNTER.steps] ?? 0,
  };
}

export function createParticleSystem(options: ParticleSystemOptions): ParticleSystem {
  const {
    device,
    dimension = 3,
    queueCapacity = 256,
    userData = false,
    seed = 1,
    profiler = noProfiler,
    label = 'particles',
  } = options;
  const capacity = Math.floor(options.capacity);
  if (!(capacity >= 1) || capacity > MAX_PARTICLE_CAPACITY) {
    throw new RangeError(
      `${label}: capacity must be 1..${MAX_PARTICLE_CAPACITY}, got ${options.capacity}`,
    );
  }
  const attributeBytes = capacity * PARTICLE_ATTRIBUTE_BYTES;
  const listBytes = (COUNTERS + 3 * capacity) * 4;
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (attributeBytes > limit || listBytes > limit) {
    throw new RangeError(`${label}: ${capacity} particles exceed the device's buffer limit`);
  }

  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const makeBuffer = (name: string, size: number, usage: number) =>
    device.createBuffer({ label: `${label} ${name}`, size, usage });
  const positions = makeBuffer('positions', attributeBytes, storage | GPUBufferUsage.VERTEX);
  const velocities = makeBuffer('velocities', attributeBytes, storage);
  const attributes = makeBuffer('attributes', attributeBytes, storage);
  const user = userData ? makeBuffer('user', attributeBytes, storage) : undefined;
  const lists = makeBuffer('lists', listBytes, storage);
  const queue = makeBuffer('spawn queue', Math.max(1, queueCapacity) * SPAWN_BYTES, storage);
  const args = makeBuffer('args', ARGS_BYTES, storage | GPUBufferUsage.INDIRECT);
  const ring = makeBuffer(
    'step uniforms',
    STEP_STRIDE * STEP_SLOTS,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  );

  const zeroField = device.createTexture({
    label: `${label} no field`,
    size: [1, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fieldSampler = device.createSampler({
    label: `${label} field sampler`,
    magFilter: 'linear',
    minFilter: 'linear',
  });
  let field = options.field ?? zeroField.createView();

  const source = particleKernelSource(options.hooks, userData);
  const kernel = (entryPoint: string, workgroupSize: number): ComputePass =>
    createComputePass(device, {
      label: source.label,
      code: source.code,
      chunks: source.chunks,
      entryPoint,
      workgroupSize,
    });
  const update = kernel('update', 64);
  const plan = kernel('plan', 256);
  const emit = kernel('emit', 64);
  const finish = kernel('finish', 1);

  const params: ParticleSystem['params'] = {
    fixedStep: options.fixedStep ?? 1 / 60,
    maxSteps: options.maxSteps ?? 4,
    substeps: options.substeps ?? 1,
    user: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  const forces = defaultForces(dimension);
  const heat = defaultHeat();
  const colliders: Collider[] = [];
  const emitters: EmitterState[] = [];

  let list = 0;
  let time = 0;
  let alpha = 0;
  let stepIndex = 0;
  let slot = 0;
  let destroyed = false;
  let stepper: FixedStepper = createFixedStepper(params.fixedStep, { maxSteps: params.maxSteps });
  let stepperKey = `${params.fixedStep}|${params.maxSteps}`;

  const slotData = new ArrayBuffer(STEP_STRIDE);
  const f32 = new Float32Array(slotData);
  const u32 = new Uint32Array(slotData);

  function initialLists(): Uint32Array {
    const data = new Uint32Array(COUNTERS + 3 * capacity);
    data[COUNTER.dead] = capacity;
    // The stack pops from the top, so slot 0 is handed out first.
    for (let i = 0; i < capacity; i++) data[COUNTERS + i] = capacity - 1 - i;
    return data;
  }
  function reset(): void {
    device.queue.writeBuffer(lists, 0, initialLists());
    device.queue.writeBuffer(args, 0, new Uint32Array(ARGS_BYTES / 4));
    list = 0;
  }
  reset();

  // --- Statistics read back a few frames late ---------------------------------------------------
  // The copy goes in a small submit of its own, made before the caller's encoder is submitted, so it
  // reads the counters as the previous frames left them and the buffer is never mapped while a
  // command buffer that uses it is still being recorded. At most one every STATS_EVERY calls.
  let latest: ParticleStats = statsFrom(new Uint32Array(COUNTERS), capacity);
  const readbacks = Array.from({ length: 2 }, (_, index) => ({
    buffer: makeBuffer(
      `stats ${index}`,
      COUNTERS * 4,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    ),
    busy: false,
  }));
  let calls = 0;

  function requestStats(): void {
    if (calls++ % STATS_EVERY !== 0) return;
    const r = readbacks.find((candidate) => !candidate.busy);
    if (!r) return;
    r.busy = true;
    const encoder = device.createCommandEncoder({ label: `${label} stats` });
    encoder.copyBufferToBuffer(lists, 0, r.buffer, 0, COUNTERS * 4);
    device.queue.submit([encoder.finish()]);
    r.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (destroyed) return;
        latest = statsFrom(new Uint32Array(r.buffer.getMappedRange().slice(0)), capacity);
        r.buffer.unmap();
        r.busy = false;
      })
      .catch(() => {
        r.busy = false;
      });
  }

  // --- One step's uniforms ----------------------------------------------------------------------
  function writeVec(name: string, values: ArrayLike<number>): void {
    const at = STEP_OFFSET[name]!;
    for (let i = 0; i < values.length; i++) f32[at + i] = values[i]!;
  }
  function writeU32(name: string, value: number): void {
    u32[STEP_OFFSET[name]!] = value >>> 0;
  }
  function writeF32(name: string, value: number): void {
    f32[STEP_OFFSET[name]!] = value;
  }

  /** Packs step `k` of `n` in this call into the next ring slot; returns the slot's binding. */
  function packStep(k: number, n: number, dt: number): GPUBufferBinding {
    f32.fill(0);
    writeF32('time', time % TIME_WRAP);
    writeF32('dt', dt);
    writeU32('substeps', Math.max(1, Math.floor(params.substeps)));
    writeU32('parity', list);
    writeVec('gravity', forces.gravity);
    writeU32('dimension', dimension);
    writeVec('wind', forces.wind);
    writeF32('drag_linear', forces.dragLinear);
    writeVec('up', forces.up);
    writeF32('drag_quadratic', forces.dragQuadratic);
    writeF32('buoyancy', forces.buoyancy);
    writeF32('ambient', heat.ambient);
    writeF32('cool_rate', heat.rate);
    writeU32('cool_mode', COOLING_MODE[heat.cooling]);
    writeF32('death_temperature', heat.deathTemperature);
    writeU32('step_index', stepIndex);
    writeU32('emitter_count', emitters.length);
    writeU32('collider_count', Math.min(colliders.length, MAX_COLLIDERS));
    writeVec('turbulence', [
      forces.turbulenceStrength,
      forces.turbulenceFrequency,
      forces.turbulenceEvolve,
      forces.turbulenceOctaves,
    ]);
    writeU32('turbulence_mode', TURBULENCE_MODE[forces.turbulence]);
    writeU32('turbulence_every', Math.max(1, Math.floor(forces.turbulenceEvery)));
    writeU32('point_count', Math.min(forces.points.length, MAX_POINT_FORCES));
    writeU32('field_mode', FIELD_MODE[forces.field]);
    const mapping = forces.fieldMapping;
    writeVec('field_u', mapping.u);
    writeVec('field_v', mapping.v);
    writeVec('field_x', [...mapping.x, forces.fieldCoupling]);
    writeVec('field_y', [...mapping.y, 0]);
    writeU32('capacity', capacity);
    writeU32('queue_capacity', queueCapacity);
    writeU32('seed', seed);
    writeVec('user', params.user.flat());

    // Emitters: where each one is during this step, and how many it emits.
    let cpuTotal = 0;
    const emitterBase = STEP_OFFSET.emitters!;
    emitters.forEach((e, index) => {
      const counts = takeEmitterStep(e, dt);
      const start = e.stepPosition;
      const lerp = (s: number): Vec3 => [
        start[0] + (e.target[0] - start[0]) * s,
        start[1] + (e.target[1] - start[1]) * s,
        start[2] + (e.target[2] - start[2]) * s,
      ];
      const from = lerp(k / n);
      const to = lerp((k + 1) / n);
      const velocity: Vec3 = [
        (to[0] - from[0]) / dt,
        (to[1] - from[1]) / dt,
        (to[2] - from[2]) / dt,
      ];
      packEmitter(
        f32,
        u32,
        emitterBase + index * EMITTER_FLOATS,
        e,
        counts,
        from,
        to,
        cpuTotal,
        velocity,
        index * 0x9e3779b9,
      );
      cpuTotal += counts.rateCount + counts.burstCount;
    });
    writeU32('cpu_emit_total', cpuTotal);

    const colliderBase = STEP_OFFSET.colliders!;
    colliders.slice(0, MAX_COLLIDERS).forEach((c, index) => {
      packCollider(f32, u32, colliderBase + index * COLLIDER_FLOATS, c);
    });
    const pointBase = STEP_OFFSET.points!;
    forces.points.slice(0, MAX_POINT_FORCES).forEach((p, index) => {
      const at = pointBase + index * 12;
      f32.set(p.position, at);
      f32[at + 3] = p.radius;
      f32.set(p.axis ?? [0, 0, 1], at + 4);
      f32[at + 8] = p.attract;
      f32[at + 9] = p.swirl;
    });

    const offset = slot * STEP_STRIDE;
    slot = (slot + 1) % STEP_SLOTS;
    device.queue.writeBuffer(ring, offset, slotData, 0, ParticleStepUniform.size);
    return { buffer: ring, offset, size: ParticleStepUniform.size };
  }

  function encodeSteps(
    encoder: GPUCommandEncoder,
    steps: number,
    dt: number,
    options: ParticleStepOptions = {},
  ): void {
    if (steps <= 0) return;
    if (steps > STEP_SLOTS) {
      throw new RangeError(`${label}: at most ${STEP_SLOTS} steps per submit, asked for ${steps}`);
    }
    const pass = encoder.beginComputePass({
      label: `${label} step`,
      timestampWrites: profiler.pass(label) as GPUComputePassTimestampWrites | undefined,
    });
    for (let k = 0; k < steps; k++) {
      const uniform = packStep(k, steps, dt);
      const particleResources: Resources = [
        uniform,
        positions,
        velocities,
        attributes,
        user,
        lists,
        queue,
        undefined,
        field,
        fieldSampler,
      ];
      update.dispatchIndirect(pass, particleResources, args, ARGS.update);
      plan.dispatch(
        pass,
        [uniform, undefined, undefined, undefined, undefined, lists, queue, args],
        1,
      );
      emit.dispatchIndirect(pass, particleResources.slice(0, 7), args, ARGS.emit);
      finish.dispatch(
        pass,
        [uniform, undefined, undefined, undefined, undefined, lists, undefined, args],
        1,
      );
      list = 1 - list;
      time += dt;
      stepIndex++;
      options.afterStep?.(pass, { index: k, steps, list, uniform, time, dt });
    }
    pass.end();
    // The steps of this call swept every emitter to its target.
    for (const e of emitters) {
      e.stepPosition[0] = e.target[0];
      e.stepPosition[1] = e.target[1];
      e.stepPosition[2] = e.target[2];
    }
  }

  async function readCounters(): Promise<Uint32Array> {
    const staging = makeBuffer(
      'stats read',
      COUNTERS * 4,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const encoder = device.createCommandEncoder({ label: `${label} read stats` });
    encoder.copyBufferToBuffer(lists, 0, staging, 0, COUNTERS * 4);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const counters = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return counters;
  }

  async function readBuffer(buffer: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const staging = makeBuffer('read', bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const encoder = device.createCommandEncoder({ label: `${label} read` });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return data;
  }

  const system: ParticleSystem = {
    device,
    capacity,
    dimension,
    label,
    forces,
    heat,
    colliders,
    emitters,
    params,
    source,
    hasUserData: userData,
    positions,
    velocities,
    attributes,
    user,
    lists,
    args,
    get list() {
      return list;
    },
    get time() {
      return time;
    },
    get alpha() {
      return alpha;
    },
    get field() {
      return field;
    },
    fieldSampler,
    get stats() {
      return latest;
    },

    addEmitter(emitterOptions) {
      if (emitters.length >= MAX_EMITTERS) {
        throw new RangeError(`${label}: at most ${MAX_EMITTERS} emitters`);
      }
      const e = createEmitterState(emitters.length, emitterOptions);
      emitters.push(e);
      return e;
    },
    setField(view) {
      field = view ?? zeroField.createView();
    },
    advance(encoder, delta, stepOptions) {
      const key = `${params.fixedStep}|${params.maxSteps}`;
      if (key !== stepperKey) {
        stepper = createFixedStepper(params.fixedStep, { maxSteps: params.maxSteps });
        stepperKey = key;
      }
      requestStats();
      const result = stepper.advance(delta);
      alpha = result.alpha;
      encodeSteps(encoder, result.steps, params.fixedStep, stepOptions);
      return result.steps;
    },
    step(encoder, steps = 1, dt = params.fixedStep, stepOptions) {
      requestStats();
      encodeSteps(encoder, Math.floor(steps), dt, stepOptions);
    },
    warmup(seconds, dt = 1 / 30, stepOptions) {
      let left = Math.round(seconds / dt);
      while (left > 0) {
        const n = Math.min(left, STEP_SLOTS);
        const encoder = device.createCommandEncoder({ label: `${label} warm-up` });
        encodeSteps(encoder, n, dt, stepOptions);
        device.queue.submit([encoder.finish()]);
        left -= n;
      }
    },
    reset,
    async readStats() {
      return statsFrom(await readCounters(), capacity);
    },
    async read() {
      const listData = new Uint32Array(await readBuffer(lists, listBytes));
      const counters = listData.subarray(0, COUNTERS);
      const stats = statsFrom(counters, capacity);
      const aliveStart = COUNTERS + capacity * (1 + list);
      const snapshot: ParticleSnapshot = {
        stats,
        alive: listData.slice(aliveStart, aliveStart + stats.alive),
        dead: listData.slice(COUNTERS, COUNTERS + stats.dead),
        positions: new Float32Array(await readBuffer(positions, attributeBytes)),
        velocities: new Float32Array(await readBuffer(velocities, attributeBytes)),
        attributes: new Float32Array(await readBuffer(attributes, attributeBytes)),
      };
      if (user) snapshot.user = new Float32Array(await readBuffer(user, attributeBytes));
      return snapshot;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const pass of [update, plan, emit, finish]) pass.destroy();
      for (const buffer of [positions, velocities, attributes, lists, queue, args, ring]) {
        buffer.destroy();
      }
      user?.destroy();
      for (const r of readbacks) r.buffer.destroy();
      zeroField.destroy();
    },
  };
  return system;
}
