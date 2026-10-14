import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import {
  ARGS,
  createComputePass,
  createParticleSystem,
  STEP_SLOTS,
  type ParticleStepOptions,
  type ParticleSystem,
} from '../../gpu/particles/index.ts';
import type { PassProfiler } from '../../gpu/profiler.ts';
import { createShader, withChunks } from '../../gpu/shader.ts';
import { createPingPongTarget, type PingPongTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import accumulateShader from './accumulate.wgsl';
import recordShader from './record.wgsl';
import ribbonShader from './ribbon.wgsl';

// The two ways story 7.7 draws a particle's trail, on the same particles (index.ts puts them side by
// side):
//
//   RIBBONS (createRibbons). Every particle keeps its last `points` positions in a ring buffer of its
//   own (record.wgsl, run after every simulation step: `system.advance(encoder, delta, ribbons.steps)`
//   dispatches it inside the steps' own compute pass), and a vertex shader expands them into a
//   camera-facing strip (ribbon.wgsl). Geometry in world space: sharp at any resolution, right
//   under camera motion, per-particle in everything (width, colour, length), and gone the moment the
//   particle dies. It costs `points` * 16 bytes per particle and (points - 1) * 6 vertices per live
//   particle per frame.
//
//   ACCUMULATION (createAccumulation). A persistent HDR target, multiplied every frame by
//   exp(-dt / tau) (accumulate.wgsl `decay`), into which the particles are drawn as sprites with a
//   weight of 1 - exp(-dt / tau), then added to the scene. No geometry and a fixed cost per pixel,
//   whatever the count; but it lives in screen space (a camera move smears it, a resize loses it),
//   its look depends on the frame rate unless the deposit is normalised as here, and it cannot tell
//   one particle's trail from another's.

/** Simulation step of the trail scenes; ribbon points are this far apart in time. */
export const TRAIL_STEP = 1 / 60;
/** Steps (and so ribbon records) to encode before one submit: within the record uniform ring. */
export const STEP_SLOTS_PER_SUBMIT = 16;
/** Bytes a ribbon point takes (x, y, temperature, age as f32). */
export const POINT_BYTES = 16;

export const TrailRecord = defineUniformStruct('TrailRecord', {
  capacity: 'u32',
  list: 'u32',
  points: 'u32',
  step: 'u32',
});

export const TrailRibbon = defineUniformStruct('TrailRibbon', {
  view: 'vec4f',
  capacity: 'u32',
  list: 'u32',
  points: 'u32',
  pixel: 'f32',
  width: 'f32',
  intensity: 'f32',
  min_pixels: 'f32',
  taper: 'f32',
  t_ref: 'f32',
  gamma: 'f32',
});

export const TrailAccumulate = defineUniformStruct('TrailAccumulate', {
  decay: 'f32',
  gain: 'f32',
  split: 'f32',
  frame: 'u32',
});

/** Points a ribbon may hold for this pool without its history buffer passing the device's limits. */
export function ribbonPoints(device: GPUDevice, capacity: number, points: number): number {
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  return Math.max(2, Math.min(Math.round(points), Math.floor(limit / (capacity * POINT_BYTES))));
}

export interface RibbonStyle {
  /** World units per pixel. */
  pixel: number;
  /** Visible rectangle: centre x, y and half width, half height, world units. */
  view: readonly [number, number, number, number];
  /** Multiplies the particle's sprite size. */
  width: number;
  intensity: number;
  minPixels: number;
  /** 0 keeps the width along the ribbon; 1 tapers it to nothing at the tail. */
  taper: number;
  tRef: number;
  gamma: number;
}

export interface Ribbons {
  readonly points: number;
  /** (head, count, seed, step) per slot. */
  readonly heads: GPUBuffer;
  /** `points` vec4f (x, y, temperature, age) per slot. */
  readonly history: GPUBuffer;
  /** Bytes of history and heads. */
  readonly bytes: number;
  /**
   * Pass to `system.advance` / `step` / `warmup`: records the live particles' positions after every
   * step, in the steps' own compute pass.
   */
  readonly steps: ParticleStepOptions;
  /** Records the live particles' positions now, in a pass of its own (after a `step` without `steps`). */
  record(encoder: GPUCommandEncoder): void;
  /** Adds the ribbons of the live particles to `target`. */
  draw(
    encoder: GPUCommandEncoder,
    options: {
      target: GPUTextureView;
      style: RibbonStyle;
      scissor?: readonly [number, number, number, number];
      timestampWrites?: GPURenderPassTimestampWrites;
    },
  ): void;
  destroy(): void;
}

export function createRibbons(
  system: ParticleSystem,
  options: { points: number; format?: GPUTextureFormat; profiler?: PassProfiler },
): Ribbons {
  const { device, capacity } = system;
  const points = ribbonPoints(device, capacity, options.points);
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const history = device.createBuffer({
    label: 'trails history',
    size: capacity * points * POINT_BYTES,
    usage,
  });
  const heads = device.createBuffer({ label: 'trails heads', size: capacity * 16, usage });
  // vertex count, instance count, first vertex, first instance
  const args = device.createBuffer({
    label: 'trails ribbon args',
    size: 16,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(args, 0, new Uint32Array([(points - 1) * 6, 0, 0, 0]));

  // Each step of a frame needs its own record uniform (writes before a submit all land first).
  const slotBytes = 256;
  const ring = device.createBuffer({
    label: 'trails record uniforms',
    size: slotBytes * STEP_SLOTS,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  let slot = 0;
  let step = 0;
  const recordPass = createComputePass(device, {
    label: 'particle-trails/record.wgsl',
    code: recordShader.code,
    chunks: { ...recordShader.chunks, 'trail-record.wgsl': TrailRecord.wgsl },
    entryPoint: 'record',
  });

  const uniforms = createUniformBuffer(device, TrailRibbon, 'trails ribbon');
  const module = createShader(
    device,
    withChunks(ribbonShader, { 'trail-ribbon.wgsl': TrailRibbon.wgsl }),
  );
  const pipeline = device.createRenderPipeline({
    label: 'trails ribbons',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format: options.format ?? 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  const group = device.createBindGroup({
    label: 'trails ribbons',
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms.buffer } },
      { binding: 1, resource: { buffer: system.lists } },
      { binding: 2, resource: { buffer: system.attributes } },
      { binding: 3, resource: { buffer: history } },
      { binding: 4, resource: { buffer: heads } },
    ],
  });

  /** Records the particles of alive list `list` into an open compute pass. */
  function recordInto(pass: GPUComputePassEncoder, list: number): void {
    step++;
    const offset = slot * slotBytes;
    slot = (slot + 1) % STEP_SLOTS;
    device.queue.writeBuffer(ring, offset, new Uint32Array([capacity, list, points, step]));
    // Indirect over the live count the step's finish kernel just wrote.
    recordPass.dispatchIndirect(
      pass,
      [
        { buffer: ring, offset, size: TrailRecord.size },
        system.positions,
        system.attributes,
        system.lists,
        history,
        heads,
      ],
      system.args,
      ARGS.draw,
    );
  }

  return {
    points,
    heads,
    history,
    bytes: capacity * (points * POINT_BYTES + 16),
    steps: { afterStep: (pass, info) => recordInto(pass, info.list) },
    record(encoder) {
      const pass = encoder.beginComputePass({ label: 'trails record' });
      recordInto(pass, system.list);
      pass.end();
    },
    draw(encoder, drawOptions) {
      const s = drawOptions.style;
      uniforms.set({
        view: s.view,
        capacity,
        list: system.list,
        points,
        pixel: s.pixel,
        width: s.width,
        intensity: s.intensity,
        min_pixels: s.minPixels,
        taper: s.taper,
        t_ref: s.tRef,
        gamma: s.gamma,
      });
      uniforms.upload();
      // The live count the system's finish kernel wrote for the sprites is the instance count.
      encoder.copyBufferToBuffer(system.args, ARGS.indirect + 4, args, 4, 4);
      const pass = encoder.beginRenderPass({
        label: 'trails ribbons',
        colorAttachments: [{ view: drawOptions.target, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: drawOptions.timestampWrites,
      });
      if (drawOptions.scissor) pass.setScissorRect(...drawOptions.scissor);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.drawIndirect(args, 0);
      pass.end();
    },
    destroy() {
      recordPass.destroy();
      uniforms.destroy();
      for (const buffer of [history, heads, args, ring]) buffer.destroy();
    },
  };
}

export interface Accumulation {
  readonly target: PingPongTarget;
  /** The target the particles are deposited into this frame (after `decay`). */
  readonly view: GPUTextureView;
  resize(width: number, height: number): void;
  /** Fades the trails by exp(-delta / tau). Returns the deposit weight, 1 - that factor. */
  decay(encoder: GPUCommandEncoder, delta: number, tau: number): number;
  /** Writes the trails (times `gain`) into `target` right of `split` pixels, clearing the rest. */
  composite(encoder: GPUCommandEncoder, target: GPUTextureView, gain: number, split: number): void;
  clear(encoder: GPUCommandEncoder): void;
  destroy(): void;
}

export function createAccumulation(
  device: GPUDevice,
  options: { format?: GPUTextureFormat; profiler?: PassProfiler } = {},
): Accumulation {
  const target = createPingPongTarget(device, {
    label: 'trails accumulation',
    format: 'rgba16float',
    width: 1,
    height: 1,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });
  const fragment = withChunks(accumulateShader, { 'trail-accumulate.wgsl': TrailAccumulate.wgsl });
  const decayPipeline = createFullscreenPipeline(device, {
    fragment,
    entryPoint: 'decay',
    format: 'rgba16float',
    label: 'trails decay',
  });
  const compositePipeline = createFullscreenPipeline(device, {
    fragment,
    entryPoint: 'composite',
    format: options.format ?? 'rgba16float',
    label: 'trails composite',
  });
  const decayUniforms = createUniformBuffer(device, TrailAccumulate, 'trails decay');
  const compositeUniforms = createUniformBuffer(device, TrailAccumulate, 'trails composite');
  const profiler = options.profiler;
  let frame = 0;
  // One bind group per (pipeline, source view); the views change on resize.
  const groups = new Map<GPURenderPipeline, WeakMap<GPUTextureView, GPUBindGroup>>();
  const groupFor = (
    pipeline: GPURenderPipeline,
    buffer: GPUBuffer,
    view: GPUTextureView,
  ): GPUBindGroup => {
    let perView = groups.get(pipeline);
    if (!perView) groups.set(pipeline, (perView = new WeakMap()));
    let group = perView.get(view);
    if (!group) {
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: view },
        ],
      });
      perView.set(view, group);
    }
    return group;
  };

  return {
    target,
    get view() {
      return target.read.view;
    },
    resize(width, height) {
      target.resize(width, height);
    },
    decay(encoder, delta, tau) {
      const factor = Math.exp(-Math.max(delta, 0) / Math.max(tau, 1e-4));
      decayUniforms.set({ decay: factor, gain: 1, split: 0, frame: frame++ });
      decayUniforms.upload();
      const read = target.read;
      renderFullscreen(
        encoder,
        target.write.view,
        decayPipeline,
        [groupFor(decayPipeline, decayUniforms.buffer, read.view)],
        { label: 'trails decay', timestampWrites: profiler?.pass('trails decay') },
      );
      target.swap();
      return 1 - factor;
    },
    composite(encoder, view, gain, split) {
      compositeUniforms.set({ decay: 1, gain, split, frame });
      compositeUniforms.upload();
      renderFullscreen(
        encoder,
        view,
        compositePipeline,
        [groupFor(compositePipeline, compositeUniforms.buffer, target.read.view)],
        { label: 'trails composite', timestampWrites: profiler?.pass('trails composite') },
      );
    },
    clear(encoder) {
      for (const view of [target.read.view, target.write.view]) {
        encoder
          .beginRenderPass({
            label: 'trails clear',
            colorAttachments: [
              { view, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
            ],
          })
          .end();
      }
    },
    destroy() {
      target.destroy();
      decayUniforms.destroy();
      compositeUniforms.destroy();
    },
  };
}

/** A particle system for the trail scenes: 2D overlay space, user data off, one hook. */
export function createTrailSystem(
  device: GPUDevice,
  options: { capacity: number; profiler?: PassProfiler; seed?: number },
): ParticleSystem {
  return createParticleSystem({
    device,
    capacity: options.capacity,
    dimension: 2,
    fixedStep: TRAIL_STEP,
    maxSteps: 4,
    seed: options.seed ?? 9,
    profiler: options.profiler,
    label: 'trails',
    hooks: {
      // Comets: born on a ring round `user[0].xy` and sent off along it at `user[0].w` (with a little
      // spread), so the attractor at the centre bends them into ellipses.
      code: `fn hook_emit(p: ptr<function, Particle>, source: ParticleSource) {
  if (ps_step.user[0].z > 0.5 && !source.spawned) {
    let r = (*p).position.xy - ps_step.user[0].xy;
    let d = length(r);
    let speed = ps_step.user[0].w * inverseSqrt(max(d, 0.05)) * (0.85 + 0.3 * to_unorm_1d(pcg_1d((*p).seed)));
    (*p).velocity = vec3f(vec2f(-r.y, r.x) / max(d, 1e-6) * speed, 0.0);
  }
}

// The vortex scene: the air is a row of three Lamb-Oseen vortices of alternating sense (centre
// user[1].y, 0.55 high, user[1].z apart, circulation user[1].w, core radius 0.08) over an
// updraft, and particles are dragged towards it at user[1].x per second.
fn hook_force(p: Particle, time: f32) -> vec3f {
  let k = ps_step.user[1].x;
  if (k <= 0.0) {
    return vec3f(0.0);
  }
  var air = vec2f(0.0, 0.02);
  for (var i = 0; i < 3; i++) {
    let centre = vec2f(ps_step.user[1].y + f32(i - 1) * ps_step.user[1].z, 0.55);
    let r = p.position.xy - centre;
    let d2 = max(dot(r, r), 1e-8);
    let sense = select(1.0, -1.0, i == 1);
    let speed = sense * ps_step.user[1].w / (6.2831853 * d2) * (1.0 - exp(-d2 / 0.0064));
    air += vec2f(-r.y, r.x) * speed;
  }
  return vec3f((air - p.velocity.xy) * k, 0.0);
}`,
    },
  });
}
