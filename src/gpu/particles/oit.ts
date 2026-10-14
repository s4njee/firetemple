import { createFullscreenPipeline, drawFullscreen } from '../fullscreen.ts';
import { withChunks } from '../shader.ts';
import { createRenderTarget, type RenderTarget } from '../targets.ts';
import compositeShader from './oit-composite.wgsl';
import oitChunk from './oit.wgsl';

/*
 * Weighted blended order-independent transparency (McGuire and Bavoil, JCGT 2013) for particles:
 * alpha-blended smoke without a sort. Story 7.9 compares it with sorted alpha and additive.
 *
 *   const oit = createOit(device, { label: 'smoke' });
 *   resize:  oit.resize(width, height);
 *   frame:
 *     const pass = oit.begin(encoder, { timestampWrites });   // clears the targets
 *     pass.setPipeline(myParticlePipeline);                     // built with `oit.targets`
 *     pass.draw(6, count);                                      // any order: no sort
 *     pass.end();
 *     oit.composite(encoder, tail.scene.view, { occlusion: 0.5 });
 *
 * The particle shader includes "oit.wgsl" (pass `OIT_CHUNKS` to `withChunks`) and returns
 * `oit_accumulate(...)` or, with `emissive: true` (the default), `oit_accumulate_emissive(...)`.
 * The pipeline's colour targets are `oit.targets` in that order. No depth attachment: test against
 * the scene's depth in the fragment stage, as src/gpu/sprites.ts does.
 *
 * TARGETS (all the size of the scene, re-created by `resize`):
 *   accum      rgba16float  sum of premultiplied colour * w (rgb) and alpha * w (a); blend one, one
 *   revealage  r16float     product of (1 - alpha); blend zero, one-minus-src. The paper allows
 *                           r8unorm; over the dozens of layers of a smoke column its rounding at
 *                           every blend adds up (0.5/255 a layer), so r16float is the default and
 *                           `revealageFormat: 'r8unorm'` saves a byte a pixel.
 *   emission   rgba16float  (emissive only) added light, unweighted; blend one, one
 * Memory per pixel: 8 + 2 + 8 = 18 bytes, 37 MB at 1920 x 1080 (10 bytes, 21 MB, without emission).
 *
 * EMISSION is added, not weighted. A flame puff is nearly transparent and bright, so as a weighted
 * layer its colour would be divided by a tiny alpha. Emission instead goes to its own target and the
 * composite adds it times mix(1, revealage, occlusion): see oit.wgsl. With occlusion 0 fire shows
 * through all smoke (cheap, and right for smoke behind the fire); with 1 it is dimmed by all the
 * smoke at its pixel, including smoke behind it.
 *
 * WEIGHT: the depth weight is the caller's choice (`oit_weight` in oit.wgsl offers the paper's
 * equations 7 to 10). particle-blending uses equation 7 with z in scene units; its notes say why.
 *
 * Composite: one fullscreen pass blended (one, one-minus-src-alpha) onto the scene, which writes
 * coverage (1 - revealage) into the scene's alpha, so an overlay's `coverage` / `luminance` alpha
 * sees the smoke.
 */

export type RevealageFormat = 'r16float' | 'r8unorm';

/** Include chunks for a shader that draws into the accumulation pass: `#include "oit.wgsl"`. */
export const OIT_CHUNKS: Readonly<Record<string, string>> = {
  ...oitChunk.chunks,
  'oit.wgsl': oitChunk.code,
};

/** Weight equations understood by `oit_weight`, by name. */
export const OIT_WEIGHTS = { none: 0, eq7: 7, eq8: 8, eq9: 9, eq10: 10 } as const;
export type OitWeight = keyof typeof OIT_WEIGHTS;

export interface OitOptions {
  /** Add the emission target (default true). Shaders then use `oit_accumulate_emissive`. */
  emissive?: boolean;
  revealageFormat?: RevealageFormat;
  label?: string;
}

export interface OitBeginOptions {
  /** Restrict drawing to a pixel rectangle (x, y, width, height). */
  scissor?: readonly [number, number, number, number];
  timestampWrites?: GPURenderPassTimestampWrites;
  label?: string;
}

export interface OitCompositeOptions {
  /** 0..1: how much of the smoke at a pixel dims the emission there. Default 0.5. */
  occlusion?: number;
  scissor?: readonly [number, number, number, number];
  timestampWrites?: GPURenderPassTimestampWrites;
  label?: string;
}

export interface Oit {
  readonly emissive: boolean;
  /** Colour target states, in attachment order, for a pipeline that draws into `begin`'s pass. */
  readonly targets: readonly GPUColorTargetState[];
  readonly accum: RenderTarget;
  readonly revealage: RenderTarget;
  readonly emission: RenderTarget | undefined;
  /** Bytes of target memory per pixel. */
  readonly bytesPerPixel: number;
  resize(width: number, height: number): void;
  /** Begins the accumulation pass with cleared targets; the caller draws and ends it. */
  begin(encoder: GPUCommandEncoder, options?: OitBeginOptions): GPURenderPassEncoder;
  /** Resolves onto `scene` (an rgba16float view the size of the targets), loading it. */
  composite(encoder: GPUCommandEncoder, scene: GPUTextureView, options?: OitCompositeOptions): void;
  destroy(): void;
}

const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
const MULTIPLY_BY_ONE_MINUS_SRC: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export function createOit(device: GPUDevice, options: OitOptions = {}): Oit {
  const { emissive = true, revealageFormat = 'r16float', label = 'oit' } = options;
  const target = (name: string, format: GPUTextureFormat) =>
    createRenderTarget(device, { label: `${label} ${name}`, format, width: 1, height: 1 });
  const accum = target('accum', 'rgba16float');
  const revealage = target('revealage', revealageFormat);
  const emission = emissive ? target('emission', 'rgba16float') : undefined;
  const targets: GPUColorTargetState[] = [
    { format: 'rgba16float', blend: ADD },
    { format: revealageFormat, blend: MULTIPLY_BY_ONE_MINUS_SRC },
  ];
  if (emission) targets.push({ format: 'rgba16float', blend: ADD });

  const layout = device.createBindGroupLayout({
    label: `${label} composite`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: 16 },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' },
      },
    ],
  });
  const pipeline = createFullscreenPipeline(device, {
    fragment: withChunks({ ...compositeShader, label: 'particles/oit-composite.wgsl' }),
    format: 'rgba16float',
    blend: PREMULTIPLIED_OVER,
    layout: [layout],
    label: `${label} composite`,
  });
  const uniforms = device.createBuffer({
    label: `${label} composite`,
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformData = new ArrayBuffer(16);
  const uniformFloats = new Float32Array(uniformData);
  const uniformUints = new Uint32Array(uniformData);
  // Bound in place of the emission target when there is none; never read.
  const blank = emissive
    ? undefined
    : device.createTexture({
        label: `${label} no emission`,
        size: [1, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });

  let group: GPUBindGroup | undefined;
  const groupNow = () =>
    (group ??= device.createBindGroup({
      label: `${label} composite`,
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: accum.view },
        { binding: 2, resource: revealage.view },
        { binding: 3, resource: emission?.view ?? blank!.createView() },
      ],
    }));

  return {
    emissive,
    targets,
    accum,
    revealage,
    emission,
    bytesPerPixel: 8 + (revealageFormat === 'r8unorm' ? 1 : 2) + (emissive ? 8 : 0),

    resize(width, height) {
      const changed = [accum, revealage, emission].map((t) => t?.resize(width, height) ?? false);
      if (changed.some(Boolean)) group = undefined;
    },

    begin(encoder, beginOptions = {}) {
      const attachments: GPURenderPassColorAttachment[] = [
        { view: accum.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: revealage.view, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] },
      ];
      if (emission) {
        attachments.push({
          view: emission.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        });
      }
      const pass = encoder.beginRenderPass({
        label: beginOptions.label ?? `${label} accumulate`,
        colorAttachments: attachments,
        timestampWrites: beginOptions.timestampWrites,
      });
      if (beginOptions.scissor) pass.setScissorRect(...beginOptions.scissor);
      return pass;
    },

    composite(encoder, scene, compositeOptions = {}) {
      uniformFloats[0] = Math.min(1, Math.max(0, compositeOptions.occlusion ?? 0.5));
      uniformUints[1] = emissive ? 1 : 0;
      device.queue.writeBuffer(uniforms, 0, uniformData);
      const pass = encoder.beginRenderPass({
        label: compositeOptions.label ?? `${label} composite`,
        colorAttachments: [{ view: scene, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: compositeOptions.timestampWrites,
      });
      if (compositeOptions.scissor) pass.setScissorRect(...compositeOptions.scissor);
      drawFullscreen(pass, pipeline, groupNow());
      pass.end();
    },

    destroy() {
      accum.destroy();
      revealage.destroy();
      emission?.destroy();
      blank?.destroy();
      uniforms.destroy();
    },
  };
}
