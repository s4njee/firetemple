import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { blit } from '../passes/blit.ts';
import { createShader, withChunks } from '../shader.ts';
import { createPingPongTarget, type PingPongTarget, type RenderTarget } from '../targets.ts';
import { createUniformBuffer, defineUniformStruct, type UniformBuffer } from '../uniforms.ts';
import computeShader from './doom-compute.wgsl';
import renderShader from './doom-render.wgsl';
import { IgnitersUniform, writeIgniters, type Igniter } from './ignition.ts';

/*
 * Doom fire: the PSX Doom heat-propagation automaton on a grid of its own (story 5.1).
 *
 *   const fire = createDoomFire(device, { width: 224, height: 128 });
 *   // each frame, with `steps` from a createFixedStepper:
 *   fire.advance(encoder, inputs, profiler.pass('step'));   // inputs: one DoomInput per step
 *   // then draw fire.current (heat in .r) however you like; fire.previous is the state one
 *   // step earlier, for blending between steps.
 *
 * The rule is in doom-kernel.wgsl. It is stepped by either of two backends that run that same
 * kernel: a render pass (one fragment per cell) or a compute pass (one invocation per cell,
 * writing a storage texture). `backend` can be changed at any time; the state carries over.
 *
 * The state is two `rgba16float` textures that swap. They are re-created only when the grid size
 * changes; `generation` bumps then, and anything holding their views must rebuild its bind groups.
 */

export const DOOM_BACKENDS = ['render', 'compute'] as const;
export type DoomBackend = (typeof DOOM_BACKENDS)[number];

export const DOOM_FORMAT: GPUTextureFormat = 'rgba16float';
/** Heat is kept on this grid (`DOOM_QUANTUM` in doom-kernel.wgsl): exact in a half float. */
export const DOOM_QUANTUM = 1 / 1024;
/** Heat is clamped here. Above 1 a ramp shows nothing new, but the flame it feeds is taller. */
export const DOOM_HEAT_MAX = 1.5;
/** Steps one `advance` (one command encoder) can carry; each needs its own uniform buffers. */
export const DOOM_MAX_STEPS = 4;
/** `@workgroup_size` of doom-compute.wgsl. */
const WORKGROUP = 8;

const DoomStep = defineUniformStruct('DoomStep', {
  tick: 'u32',
  seed: 'u32',
  choices: 'u32',
  reach_left: 'i32',
  wind: 'i32',
  sway: 'i32',
  patchy: 'i32',
  lift: 'u32',
  gust_beat: 'u32',
  gust_climb: 'u32',
  gust_cells: 'vec2u',
  cooling: 'u32',
  grain: 'i32',
  fuel: 'f32',
  uneven: 'f32',
  lumps: 'f32',
  drift: 'f32',
  heat_max: 'f32',
});

/** What one step needs to know. Everything is read at the step; nothing is remembered. */
export interface DoomInput {
  /** Heat the bottom row holds, 0..`DOOM_HEAT_MAX`. At 0 the fire dies from the base up. */
  fuel: number;
  /** How high a flame of heat 1 climbs before it is cold, as a fraction of the grid height. */
  reach: number;
  /**
   * Columns of the row below a cell may take its heat from, 1..8. 1 is a still column, 3 is
   * symmetric, and 4 is the original, which leans left because its four choices are -1..+2.
   * Default 3.
   */
  spread?: number;
  /** Cells a step carries heat sideways, on average; positive leans the flames right. Default 0. */
  wind?: number;
  /**
   * The gust field: smooth noise in space and time that neighbouring cells share, where the
   * original has only white noise. `sway` is how far it can lean the sideways pick, in cells a
   * step (typically a third of that); `patchy` (0..1) is how far it raises and lowers the
   * cooling, which opens gaps between tongues. Both default to 0, the original.
   */
  sway?: number;
  patchy?: number;
  /**
   * How much of the cooling is the original's coin toss, 0..1. At 1 a cell loses twice the mean
   * or nothing (the original, and its speckle); at 0 every cell loses the mean. Default 1.
   */
  grain?: number;
  /**
   * Chance, 0..1, that a cell takes its heat from two rows below instead of one. It makes heat
   * spread along its path as well as across it, and the fire climb `1 + lift` rows a step.
   * Default 0, the original.
   */
  lift?: number;
  /** Size of a gust in cells, across and up. Default an eighth and a third of the shorter side. */
  gustCells?: readonly [number, number];
  /** Steps a gust lasts. Default 40. */
  gustBeat?: number;
  /** Cells the gust field has climbed; advance it slowly to make the gusts rise. Default 0. */
  gustClimb?: number;
  /** How far the base dips between lumps of fuel, 0..1. 0 is the classic flat row. Default 0. */
  uneven?: number;
  /** Lumps of fuel along the base per length of the grid's shorter side. Default 3. */
  lumps?: number;
  /** Where the lumps are in their slow drift; advance it by seconds times a speed. Default 0. */
  drift?: number;
  /** Pointer strokes and embers for this step, in canvas uv. */
  igniters?: readonly Igniter[];
  /** Canvas width / height, for round igniters. Default: the grid's own. */
  aspect?: number;
}

export interface DoomFireOptions {
  /** Grid size in cells. */
  width: number;
  height: number;
  backend?: DoomBackend;
  /** The same seed and inputs give the same fire, in either backend. Default 1. */
  seed?: number;
  label?: string;
}

export interface DoomFire {
  /** Which pass runs the next step. Changing it keeps the state. */
  backend: DoomBackend;
  readonly width: number;
  readonly height: number;
  /** Bumps whenever the state textures are re-created (a resize that changed the grid). */
  readonly generation: number;
  /** Steps taken since creation or the last `clear`. */
  readonly tick: number;
  /** The newest state: heat in .r, 0..`DOOM_HEAT_MAX`. Changes after every step; read it per frame. */
  readonly current: RenderTarget;
  /** The state one step before `current`. */
  readonly previous: RenderTarget;
  /**
   * Changes the grid size, returning whether it did. The fire is resampled onto the new grid, so
   * it keeps burning; `generation` bumps. Submits its own commands, so call it outside a frame's
   * encoder (from the effect's `resize`, or before encoding).
   */
  resize(width: number, height: number): boolean;
  /**
   * Encodes one step per input, at most `DOOM_MAX_STEPS` (extra inputs are dropped). Call it once
   * per command encoder: the uniforms of a step are only safe until the encoder is submitted.
   */
  advance(
    encoder: GPUCommandEncoder,
    inputs: readonly DoomInput[],
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
  /** Runs `steps` steps of `input` right now, in commands of its own: a fire already burning. */
  warm(steps: number, input: DoomInput): void;
  /** Puts the fire out everywhere and restarts the step count. */
  clear(): void;
  destroy(): void;
}

/**
 * The mean heat a cell loses per row, in 1/256 of a quantum (the kernel's unit), that makes a
 * flame of heat 1 reach `reach` of `rows`. A flame cannot be shorter than four rows.
 */
export function doomCooling(reach: number, rows: number): number {
  const climb = Math.max(4, reach * rows);
  return Math.round(256 / DOOM_QUANTUM / climb);
}

const quantise = (heat: number) => Math.round(heat / DOOM_QUANTUM) * DOOM_QUANTUM;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
/** The kernel's sideways arithmetic is fixed point: this many units to a cell. */
const FIXED = 4096;
/** Most cells a step may carry heat sideways, by wind or by gust. */
const MAX_LEAN = 4;

interface Slot {
  step: UniformBuffer<typeof DoomStep.fields>;
  igniters: UniformBuffer<typeof IgnitersUniform.fields>;
  group: GPUBindGroup;
}

export function createDoomFire(device: GPUDevice, options: DoomFireOptions): DoomFire {
  const label = options.label ?? 'doom fire';
  const seed = (options.seed ?? 1) >>> 0;
  const chunks = { 'doom-uniforms.wgsl': DoomStep.wgsl };

  // Group 0: what one step is told. Shared by both backends, one set per step of a frame.
  const uniformLayout = device.createBindGroupLayout({
    label: `${label} step uniforms`,
    entries: [0, 1].map((binding) => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' as const },
    })),
  });
  // Group 1: the state. textureLoad only, so no sampler and no filtering in either backend.
  const previousEntry = (visibility: GPUShaderStageFlags): GPUBindGroupLayoutEntry => ({
    binding: 0,
    visibility,
    texture: { sampleType: 'unfilterable-float' },
  });
  const renderLayout = device.createBindGroupLayout({
    label: `${label} render state`,
    entries: [previousEntry(GPUShaderStage.FRAGMENT)],
  });
  const computeLayout = device.createBindGroupLayout({
    label: `${label} compute state`,
    entries: [
      previousEntry(GPUShaderStage.COMPUTE),
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: DOOM_FORMAT },
      },
    ],
  });

  // Pipelines are built on first use, so a page that only ever uses one backend compiles one.
  let renderPipeline: GPURenderPipeline | undefined;
  let computePipeline: GPUComputePipeline | undefined;
  const getRenderPipeline = () =>
    (renderPipeline ??= createFullscreenPipeline(device, {
      label: `${label} step (render)`,
      fragment: withChunks(renderShader, chunks),
      format: DOOM_FORMAT,
      layout: [uniformLayout, renderLayout],
    }));
  const getComputePipeline = () =>
    (computePipeline ??= device.createComputePipeline({
      label: `${label} step (compute)`,
      layout: device.createPipelineLayout({
        label: `${label} compute layout`,
        bindGroupLayouts: [uniformLayout, computeLayout],
      }),
      compute: {
        module: createShader(device, withChunks(computeShader, chunks)),
        entryPoint: 'doom_step',
      },
    }));

  const slots: Slot[] = Array.from({ length: DOOM_MAX_STEPS }, (_, index) => {
    const step = createUniformBuffer(device, DoomStep, `${label} step ${index}`);
    const igniters = createUniformBuffer(device, IgnitersUniform, `${label} igniters ${index}`);
    const group = device.createBindGroup({
      label: `${label} step ${index}`,
      layout: uniformLayout,
      entries: [
        { binding: 0, resource: { buffer: step.buffer } },
        { binding: 1, resource: { buffer: igniters.buffer } },
      ],
    });
    return { step, igniters, group };
  });

  const allocate = (width: number, height: number): PingPongTarget =>
    createPingPongTarget(device, {
      label: `${label} state`,
      format: DOOM_FORMAT,
      width,
      height,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        // The compute backend writes it as a storage texture.
        GPUTextureUsage.STORAGE_BINDING |
        // Lets tests and tools read the state back; costs nothing.
        GPUTextureUsage.COPY_SRC,
    });

  let state = allocate(options.width, options.height);
  let generation = 0;
  let tick = 0;
  let destroyed = false;
  // One bind group per backend and per state texture being read; rebuilt with the textures.
  let stateGroups = new Map<string, GPUBindGroup>();

  const stateGroup = (kind: DoomBackend): GPUBindGroup => {
    const key = `${kind}:${state.read.label}`;
    let group = stateGroups.get(key);
    if (!group) {
      group = device.createBindGroup({
        label: `${label} ${key}`,
        layout: kind === 'render' ? renderLayout : computeLayout,
        entries: [
          { binding: 0, resource: state.read.view },
          ...(kind === 'compute' ? [{ binding: 1, resource: state.write.view }] : []),
        ],
      });
      stateGroups.set(key, group);
    }
    return group;
  };

  const writeStep = (slot: Slot, input: DoomInput) => {
    const choices = Math.min(8, Math.max(1, Math.round(input.spread ?? 3)));
    const rows = state.read.height;
    const short = Math.min(rows, state.read.width);
    const gustCells = input.gustCells ?? [short / 8, short / 3];
    const cooling = doomCooling(input.reach, rows);
    const whole = (value: number, least: number) => Math.max(least, Math.round(value)) >>> 0;
    slot.step.set({
      tick,
      seed,
      choices,
      reach_left: Math.floor((choices - 1) / 2),
      // A cell reads from the column its heat comes FROM, so a wind to the right reads leftward.
      wind: Math.round(-clamp(input.wind ?? 0, -MAX_LEAN, MAX_LEAN) * FIXED),
      sway: Math.round(clamp(input.sway ?? 0, 0, MAX_LEAN) * FIXED),
      patchy: Math.round(clamp(input.patchy ?? 0, 0, 1) * FIXED),
      lift: Math.round(clamp(input.lift ?? 0, 0, 1) * FIXED),
      gust_beat: whole(input.gustBeat ?? 40, 1),
      gust_climb: whole(input.gustClimb ?? 0, 0),
      gust_cells: [whole(gustCells[0], 1), whole(gustCells[1], 1)],
      fuel: quantise(Math.min(Math.max(input.fuel, 0), DOOM_HEAT_MAX)),
      cooling,
      grain: Math.round(clamp(input.grain ?? 1, 0, 1) * cooling),
      uneven: Math.min(Math.max(input.uneven ?? 0, 0), 1),
      lumps: input.lumps ?? 3,
      drift: input.drift ?? 0,
      heat_max: DOOM_HEAT_MAX,
    });
    slot.step.upload();
    writeIgniters(
      slot.igniters,
      input.igniters ?? [],
      input.aspect ?? state.read.width / state.read.height,
    );
    slot.igniters.upload();
  };

  const fire: DoomFire = {
    backend: options.backend ?? 'render',
    get width() {
      return state.read.width;
    },
    get height() {
      return state.read.height;
    },
    get generation() {
      return generation;
    },
    get tick() {
      return tick;
    },
    get current() {
      return state.read;
    },
    get previous() {
      return state.write;
    },

    resize(width, height) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (destroyed || (w === state.read.width && h === state.read.height)) return false;
      const old = state;
      state = allocate(w, h);
      // Carry the fire over, into both textures: `previous` must be a state too.
      const encoder = device.createCommandEncoder({ label: `${label} resize` });
      blit(device, encoder, old.read.view, state.read);
      blit(device, encoder, old.read.view, state.write);
      device.queue.submit([encoder.finish()]);
      old.destroy();
      stateGroups = new Map();
      generation++;
      return true;
    },

    advance(encoder, inputs, timestampWrites) {
      const count = Math.min(inputs.length, DOOM_MAX_STEPS);
      for (let index = 0; index < count; index++) {
        const slot = slots[index]!;
        writeStep(slot, inputs[index]!);
        // Only the first step of a frame is timed: a label used twice is summed by the profiler,
        // and the timed-pass budget is small.
        const timing = index === 0 ? timestampWrites : undefined;
        if (fire.backend === 'compute') {
          const pass = encoder.beginComputePass({
            label: `${label} step (compute)`,
            timestampWrites: timing,
          });
          pass.setPipeline(getComputePipeline());
          pass.setBindGroup(0, slot.group);
          pass.setBindGroup(1, stateGroup('compute'));
          pass.dispatchWorkgroups(
            Math.ceil(state.read.width / WORKGROUP),
            Math.ceil(state.read.height / WORKGROUP),
          );
          pass.end();
        } else {
          renderFullscreen(
            encoder,
            state.write.view,
            getRenderPipeline(),
            [slot.group, stateGroup('render')],
            { label: `${label} step (render)`, timestampWrites: timing },
          );
        }
        state.swap();
        tick++;
      }
    },

    warm(steps, input) {
      for (let index = 0; index < steps; index++) {
        const encoder = device.createCommandEncoder({ label: `${label} warm` });
        fire.advance(encoder, [input]);
        device.queue.submit([encoder.finish()]);
      }
    },

    clear() {
      const encoder = device.createCommandEncoder({ label: `${label} clear` });
      for (const target of [state.read, state.write]) {
        encoder
          .beginRenderPass({
            colorAttachments: [
              { view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
            ],
          })
          .end();
      }
      device.queue.submit([encoder.finish()]);
      tick = 0;
    },

    destroy() {
      destroyed = true;
      for (const slot of slots) {
        slot.step.destroy();
        slot.igniters.destroy();
      }
      state.destroy();
      stateGroups = new Map();
    },
  };
  return fire;
}
