import { createFullscreenPipeline, drawFullscreen } from '../fullscreen.ts';
import { withChunks } from '../shader.ts';
import { createRenderTarget, type RenderTarget, type TargetView } from '../targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../uniforms.ts';
import depthDownsampleSource from './depth-downsample.wgsl';
import upsampleSource from './upsample.wgsl';

/*
 * A ray march at reduced resolution, composited under a full-resolution depth buffer.
 *
 * A volume is smooth and expensive: every pixel pays for the whole march. Marching at half
 * resolution costs a quarter, at quarter resolution a sixteenth, and nobody can tell from the
 * volume itself. What gives it away is the edge against opaque geometry, so that is where the
 * work goes. Three passes per frame:
 *
 *   1. `encodeDepth`  the scene's depth buffer, reduced to the march resolution as view-space depth
 *                     (`depth`, r32float): the nearest of each block on one colour of a
 *                     checkerboard, the farthest on the other (or the farthest everywhere, for a
 *                     plain bilinear upsample).
 *   2. the march      THE EFFECT'S OWN PASS, drawn into `target` (rgba16float). It must stop each
 *                     ray at the depth in `depth` (read it with textureLoad at the fragment's own
 *                     pixel) and write vec4f(radiance, transmittance); `volume_resolve` in
 *                     src/wgsl/volume.wgsl returns exactly that. Clear to (0, 0, 0, 1): nothing.
 *   3. `composite`    upsamples `target` to the scene's resolution, weighting the four nearest
 *                     texels by how well the depth they were marched against matches the pixel's
 *                     own depth, and blends it over the scene: scene * transmittance + radiance.
 *
 * At divisor 1 the same three passes run and the upsample is a copy, so an effect needs no second
 * code path to compare resolutions.
 */

/** March resolutions as divisors of the scene's width and height. */
export const VOLUME_DIVISORS = [1, 2, 4] as const;
export type VolumeDivisor = (typeof VOLUME_DIVISORS)[number];

/**
 * `bilinear` ignores depth: cheapest (4 texture loads) and smears the volume over silhouettes.
 * `depth-aware` is the joint-bilateral filter of `volume_upsample_weights` (9 loads).
 */
export const UPSAMPLE_FILTERS = ['depth-aware', 'bilinear'] as const;
export type UpsampleFilter = (typeof UPSAMPLE_FILTERS)[number];

/** Format of the march target: half-float radiance, transmittance in alpha. */
export const VOLUME_MARCH_FORMAT: GPUTextureFormat = 'rgba16float';
/** Format of the reduced depth: view-space depth in world units, read with `textureLoad`. */
export const VOLUME_DEPTH_FORMAT: GPUTextureFormat = 'r32float';

const ReduceParams = defineUniformStruct('VolumeReduceParams', {
  near: 'f32',
  far: 'f32',
  divisor: 'f32',
  tolerance: 'f32',
  depth_limit: 'f32',
  depth_aware: 'u32',
  checker: 'u32',
});
const REDUCE_CHUNK = { 'volume-reduce-params.wgsl': ReduceParams.wgsl };

/** Size of the march target for a scene of `size` pixels: every scene pixel is covered. */
export function reducedSize(size: number, divisor: number): number {
  return Math.max(1, Math.ceil(Math.max(1, Math.round(size)) / divisor));
}

export interface ReducedVolumeOptions {
  label: string;
  /** Initial divisor. Default 2. */
  divisor?: VolumeDivisor;
  /** Add COPY_SRC to both targets so a test or tool can read them back. Default false. */
  readback?: boolean;
}

export interface VolumeDepthOptions {
  /** The scene's depth buffer (a `depth32float` or `depth24plus` view, not multisampled). */
  sceneDepth: GPUTextureView;
  /** The camera's clip planes, to turn depth-buffer values into view-space depth. */
  near: number;
  far: number;
  /**
   * View-space depth beyond which there is no medium on any ray, e.g. the farthest corner of the
   * volume's box. Every depth beyond it is treated as equal to it. Without it the depth-aware
   * filter sees the background behind a volume as full of edges (a ground plane at a grazing
   * angle changes depth by several percent per texel) and falls back to the nearest texel there,
   * which shows the march's jitter as blocks. Default: no limit.
   */
  depthLimit?: number;
  /**
   * The upsample filter the result will be composited with. `depth-aware` (default) reduces depth
   * on a checkerboard of nearest and farthest; `bilinear` takes the farthest of every block.
   */
  filter?: UpsampleFilter;
  timestampWrites?: GPURenderPassTimestampWrites;
}

export interface VolumeCompositeOptions {
  /** Where the scene already is; the volume is blended over it. Same size as `sceneDepth`. */
  color: TargetView;
  sceneDepth: GPUTextureView;
  /** Default: the filter given to the last `encodeDepth`. */
  filter?: UpsampleFilter;
  /**
   * Relative depth difference at which a low-resolution texel's weight has fallen to a quarter.
   * Smaller is sharper at silhouettes and blockier on surfaces seen at a grazing angle. Default
   * 0.02.
   */
  depthTolerance?: number;
  timestampWrites?: GPURenderPassTimestampWrites;
}

export interface ReducedVolume {
  /** The march renders here: rgb radiance, a transmittance. Its view changes on resize. */
  readonly target: RenderTarget;
  /** View-space depth each march ray must stop at, one texel per `target` texel. */
  readonly depth: RenderTarget;
  readonly divisor: VolumeDivisor;
  /**
   * Multiply the march pass's fullscreen `uv` by this to get the scene's uv. It is (1, 1) when
   * the scene size is a multiple of the divisor; otherwise the last low-resolution row and column
   * hang over the scene's edge and the factor is slightly above 1.
   */
  readonly uvScale: readonly [number, number];
  /** Bumps whenever `target` and `depth` were reallocated: rebuild bind groups that hold them. */
  readonly generation: number;
  /** Sizes the targets for a scene of `width` x `height`. Returns true when they were reallocated. */
  resize(width: number, height: number, divisor?: VolumeDivisor): boolean;
  /** Pass 1. Call after the scene's opaque geometry is drawn and before the march. */
  encodeDepth(encoder: GPUCommandEncoder, options: VolumeDepthOptions): void;
  /**
   * Pass 3. Uses the clip planes and depth limit given to the last `encodeDepth`. The settings of
   * both passes live in one uniform buffer, so run the three passes once per submitted command
   * buffer: of two rounds with different settings before one submit, both would draw with the
   * second one's.
   */
  composite(encoder: GPUCommandEncoder, options: VolumeCompositeOptions): void;
  destroy(): void;
}

/** Premultiplied "over": the shader writes (radiance, 1 - transmittance). */
const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

export function createReducedVolume(
  device: GPUDevice,
  options: ReducedVolumeOptions,
): ReducedVolume {
  const { label } = options;
  const usage =
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.TEXTURE_BINDING |
    (options.readback ? GPUTextureUsage.COPY_SRC : 0);
  const target = createRenderTarget(device, {
    label: `${label} march`,
    format: VOLUME_MARCH_FORMAT,
    width: 1,
    height: 1,
    usage,
  });
  const depth = createRenderTarget(device, {
    label: `${label} march depth`,
    format: VOLUME_DEPTH_FORMAT,
    width: 1,
    height: 1,
    usage,
  });
  const uniforms = createUniformBuffer(device, ReduceParams, `${label} reduce params`);

  const uniformEntry: GPUBindGroupLayoutEntry = {
    binding: 0,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: 'uniform' },
  };
  const depthEntry: GPUBindGroupLayoutEntry = {
    binding: 1,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: 'depth' },
  };
  const loaded = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: 'unfilterable-float' },
  });
  const depthLayout = device.createBindGroupLayout({
    label: `${label} depth downsample layout`,
    entries: [uniformEntry, depthEntry],
  });
  const compositeLayout = device.createBindGroupLayout({
    label: `${label} upsample layout`,
    entries: [uniformEntry, depthEntry, loaded(2), loaded(3)],
  });

  const depthPipeline = createFullscreenPipeline(device, {
    label: `${label} depth downsample`,
    fragment: withChunks(depthDownsampleSource, REDUCE_CHUNK),
    format: VOLUME_DEPTH_FORMAT,
    layout: [depthLayout],
  });
  const compositePipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  let divisor: VolumeDivisor = options.divisor ?? 2;
  let sceneWidth = 1;
  let sceneHeight = 1;
  let generation = 0;
  let near = 0.1;
  let far = 100;
  let depthLimit = 3e38;
  let filter: UpsampleFilter = 'depth-aware';

  // Keyed by the scene depth view, which changes when the effect resizes its depth target; the
  // entries also hold this object's own views, so they are dropped whenever those are reallocated.
  let depthGroups = new WeakMap<GPUTextureView, GPUBindGroup>();
  let compositeGroups = new WeakMap<GPUTextureView, GPUBindGroup>();

  const upload = (tolerance?: number) => {
    uniforms.set({
      near,
      far,
      divisor,
      depth_limit: depthLimit,
      depth_aware: filter === 'depth-aware' ? 1 : 0,
      checker: filter === 'depth-aware' ? 1 : 0,
      ...(tolerance === undefined ? undefined : { tolerance }),
    });
    uniforms.upload();
  };

  return {
    target,
    depth,
    get divisor() {
      return divisor;
    },
    get uvScale() {
      return [
        (target.width * divisor) / sceneWidth,
        (target.height * divisor) / sceneHeight,
      ] as const;
    },
    get generation() {
      return generation;
    },

    resize(width, height, newDivisor = divisor) {
      sceneWidth = Math.max(1, Math.round(width));
      sceneHeight = Math.max(1, Math.round(height));
      divisor = newDivisor;
      const w = reducedSize(sceneWidth, divisor);
      const h = reducedSize(sceneHeight, divisor);
      const resized = target.resize(w, h);
      depth.resize(w, h);
      if (resized) {
        generation++;
        depthGroups = new WeakMap();
        compositeGroups = new WeakMap();
      }
      return resized;
    },

    encodeDepth(encoder, depthOptions) {
      near = depthOptions.near;
      far = depthOptions.far;
      depthLimit = depthOptions.depthLimit ?? 3e38;
      filter = depthOptions.filter ?? 'depth-aware';
      upload();

      let group = depthGroups.get(depthOptions.sceneDepth);
      if (!group) {
        group = device.createBindGroup({
          label: `${label} depth downsample`,
          layout: depthLayout,
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: depthOptions.sceneDepth },
          ],
        });
        depthGroups.set(depthOptions.sceneDepth, group);
      }
      const pass = encoder.beginRenderPass({
        label: `${label} depth downsample`,
        colorAttachments: [{ view: depth.view, loadOp: 'clear', storeOp: 'store' }],
        timestampWrites: depthOptions.timestampWrites,
      });
      drawFullscreen(pass, depthPipeline, group);
      pass.end();
    },

    composite(encoder, compositeOptions) {
      const { color, sceneDepth } = compositeOptions;
      filter = compositeOptions.filter ?? filter;
      upload(compositeOptions.depthTolerance ?? 0.02);

      let pipeline = compositePipelines.get(color.format);
      if (!pipeline) {
        pipeline = createFullscreenPipeline(device, {
          label: `${label} upsample ${color.format}`,
          fragment: withChunks(upsampleSource, REDUCE_CHUNK),
          format: color.format,
          blend: OVER,
          layout: [compositeLayout],
        });
        compositePipelines.set(color.format, pipeline);
      }
      let group = compositeGroups.get(sceneDepth);
      if (!group) {
        group = device.createBindGroup({
          label: `${label} upsample`,
          layout: compositeLayout,
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: sceneDepth },
            { binding: 2, resource: target.view },
            { binding: 3, resource: depth.view },
          ],
        });
        compositeGroups.set(sceneDepth, group);
      }
      const pass = encoder.beginRenderPass({
        label: `${label} upsample`,
        colorAttachments: [{ view: color.view, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: compositeOptions.timestampWrites,
      });
      drawFullscreen(pass, pipeline, group);
      pass.end();
    },

    destroy() {
      target.destroy();
      depth.destroy();
      uniforms.destroy();
    },
  };
}
