import { createFullscreenPipeline, drawFullscreen, renderFullscreen } from '../fullscreen.ts';
import { withChunks } from '../shader.ts';
import { noProfiler, type PassProfiler } from '../profiler.ts';
import { createRenderTarget, type RenderTarget } from '../targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../uniforms.ts';
import { linearSampler, perDevice } from '../passes/common.ts';
import downsampleSource from '../passes/downsample.wgsl';
import downSource from './bloom-down.wgsl';
import upSource from './bloom-up.wgsl';

/** Bloom levels are always this format: HDR energy has to survive the chain. */
export const BLOOM_FORMAT: GPUTextureFormat = 'rgba16float';
export const MAX_BLOOM_LEVELS = 8;
/** The smallest level keeps at least this many texels on its shorter side. */
export const MIN_BLOOM_LEVEL_SIZE = 4;
/** Shorter side, in texels, of the coarsest level an automatic level count aims for. */
export const BLOOM_COARSEST_SIDE = 34;

const BloomParams = defineUniformStruct('BloomParams', {
  threshold: 'f32',
  knee: 'f32',
  intensity: 'f32',
  karis: 'f32',
});

export interface BloomSettings {
  /**
   * Strength of the glow, as a multiple of the energy that passes the threshold. 0 turns bloom off
   * and `encode` then does no GPU work at all.
   */
  intensity: number;
  /** Scene-linear brightness (brightest channel, before exposure) below which nothing glows. */
  threshold: number;
  /** Width of the soft transition below the threshold, in the same units. 0 is a hard edge. */
  knee: number;
  /**
   * 0..1: how much of each level comes from the coarser one on the way up. 0 keeps only the finest
   * (tight) glow; towards 1 the wide, faint levels dominate. Each step is a convex blend, so this
   * moves energy between scales and never adds any.
   */
  radius: number;
  /**
   * Number of mip levels; clamped to 1..8 and to what the image size allows. 0 (the default)
   * chooses it from the image size with `bloomLevelsForSize`, so the glow reaches the same
   * fraction of the picture at every canvas size and pixel ratio. A fixed count does not: each
   * level doubles the reach in pixels, so 5 levels that look right at 1080p flood a 270p card.
   */
  levels: number;
  /** Karis-average the first downsample so single hot pixels cannot flicker. Costs nothing measurable. */
  fireflyFilter: boolean;
}

export const DEFAULT_BLOOM: Readonly<BloomSettings> = {
  intensity: 0.6,
  threshold: 1,
  knee: 0.5,
  radius: 0.7,
  levels: 0,
  fireflyFilter: true,
};

export interface BloomOptions {
  label?: string;
  /** Size of the image that will be passed to `encode`. */
  width: number;
  height: number;
  /**
   * Start the chain at half the source size (default), which is what keeps the cost low: the first
   * pass reads the full-size image once and everything after it is a quarter of that or less.
   * `false` starts at full size, which is sharper and about four times dearer.
   */
  halfResolution?: boolean;
  /** Adds COPY_SRC to the level textures so tests and tools can read them back. */
  readable?: boolean;
}

export interface Bloom {
  readonly format: GPUTextureFormat;
  /**
   * Records the chain for `source` (any filterable colour texture) and returns the finest level,
   * which holds the glow already multiplied by `intensity`, or `undefined` when intensity is 0.
   * Add it to the scene (the output pass does). The view is valid until the next `resize`.
   *
   * The parameters go out through `queue.writeBuffer`, so two `encode` calls on one Bloom before a
   * single submit both run with the last settings.
   */
  encode(
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    settings?: Partial<BloomSettings>,
    profiler?: PassProfiler,
  ): GPUTextureView | undefined;
  /** Size of the image `encode` will read. Reallocates the levels and returns true if it changed. */
  resize(width: number, height: number): boolean;
  /** Sizes of the levels currently allocated, finest first. */
  levelSizes(): readonly (readonly [number, number])[];
  /** The levels (finest first), for tests and debugging. */
  readonly levels: readonly RenderTarget[];
  /** How many levels a source of the current size supports. */
  maxLevels(): number;
  destroy(): void;
}

interface BloomState {
  downLayout: GPUBindGroupLayout;
  prefilterLayout: GPUBindGroupLayout;
  down: GPURenderPipeline;
  prefilter: GPURenderPipeline;
  up: GPURenderPipeline;
}

// Created once per device; the constant-factor blend is what turns the upsample into a mix.
const stateFor = perDevice((device): BloomState => {
  const entry = (
    binding: number,
    kind: 'texture' | 'sampler' | 'uniform',
  ): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    ...(kind === 'texture'
      ? { texture: { sampleType: 'float' as const } }
      : kind === 'sampler'
        ? { sampler: { type: 'filtering' as const } }
        : { buffer: { type: 'uniform' as const } }),
  });
  const downLayout = device.createBindGroupLayout({
    label: 'bloom down layout',
    entries: [entry(0, 'texture'), entry(1, 'sampler')],
  });
  const prefilterLayout = device.createBindGroupLayout({
    label: 'bloom prefilter layout',
    entries: [entry(0, 'texture'), entry(1, 'sampler'), entry(2, 'uniform')],
  });
  const downShader = withChunks(downSource, downsampleSource.chunks, {
    'downsample13.wgsl': downsampleSource.code,
    'bloom-params.wgsl': BloomParams.wgsl,
  });
  const constant: GPUBlendComponent = {
    srcFactor: 'constant',
    dstFactor: 'one-minus-constant',
    operation: 'add',
  };
  return {
    downLayout,
    prefilterLayout,
    down: createFullscreenPipeline(device, {
      label: 'bloom down',
      fragment: downShader,
      entryPoint: 'fs',
      format: BLOOM_FORMAT,
      layout: [downLayout],
    }),
    prefilter: createFullscreenPipeline(device, {
      label: 'bloom prefilter',
      fragment: downShader,
      entryPoint: 'fs_prefilter',
      format: BLOOM_FORMAT,
      layout: [prefilterLayout],
    }),
    up: createFullscreenPipeline(device, {
      label: 'bloom up',
      fragment: upSource,
      format: BLOOM_FORMAT,
      blend: { color: constant, alpha: constant },
      layout: [downLayout],
    }),
  };
});

const halve = (size: number) => Math.max(1, (size + 1) >> 1);

/** Level sizes for a source of `width` x `height`, finest first, as many as fit. */
export function bloomLevelSizes(
  width: number,
  height: number,
  halfResolution = true,
): [number, number][] {
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));
  if (halfResolution) [w, h] = [halve(w), halve(h)];
  const sizes: [number, number][] = [[w, h]];
  while (sizes.length < MAX_BLOOM_LEVELS) {
    const next: [number, number] = [halve(w), halve(h)];
    if (Math.min(next[0], next[1]) < MIN_BLOOM_LEVEL_SIZE) break;
    sizes.push(next);
    [w, h] = next;
  }
  return sizes;
}

/**
 * The level count that keeps the glow's reach a constant fraction of the image: the coarsest level
 * ends up about `BLOOM_COARSEST_SIDE` texels on its shorter side. 5 levels at 1080p, 4 at 540p, 3 at
 * 270p (one more of each at full resolution, where every level is twice as fine).
 */
export function bloomLevelsForSize(width: number, height: number, halfResolution = true): number {
  const side = Math.max(1, Math.min(width, height));
  const levels = Math.round(Math.log2(side / BLOOM_COARSEST_SIDE)) + (halfResolution ? 0 : 1);
  const fits = bloomLevelSizes(width, height, halfResolution).length;
  return Math.max(1, Math.min(fits, MAX_BLOOM_LEVELS, levels));
}

/** What a bloom of `levels` levels costs, counted rather than timed. */
export interface BloomWorkload {
  /** Levels actually used, after clamping to what the image allows. */
  levels: number;
  /** Render passes: one down per level, one up per level but the coarsest. */
  passes: number;
  /** Texels written, summed over every pass. */
  texels: number;
  /** Texture fetches: 13 per texel going down, 9 per texel coming up. */
  taps: number;
  /** Bytes of the level textures (rgba16float, 8 bytes per texel). */
  bytes: number;
}

/**
 * Passes, texels and taps for one bloom of an image of this size. `levels` 0 means automatic, as in
 * `BloomSettings`. The first level dominates: every further level adds a quarter of the one before,
 * so the count barely moves the texel total and mostly costs two more passes.
 */
export function bloomWorkload(
  width: number,
  height: number,
  levels = 0,
  halfResolution = true,
): BloomWorkload {
  const sizes = bloomLevelSizes(width, height, halfResolution);
  const requested = levels > 0 ? levels : bloomLevelsForSize(width, height, halfResolution);
  const count = Math.max(1, Math.min(sizes.length, MAX_BLOOM_LEVELS, Math.round(requested)));
  const areas = sizes.slice(0, count).map(([w, h]) => w * h);
  const down = areas.reduce((a, b) => a + b, 0);
  const up = down - (areas[count - 1] ?? 0);
  return {
    levels: count,
    passes: 2 * count - 1,
    texels: down + up,
    taps: 13 * down + 9 * up,
    bytes: down * 8,
  };
}

export function createBloom(device: GPUDevice, options: BloomOptions): Bloom {
  const label = options.label ?? 'bloom';
  const halfResolution = options.halfResolution ?? true;
  const usage =
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.TEXTURE_BINDING |
    (options.readable ? GPUTextureUsage.COPY_SRC : 0);
  const state = stateFor(device);
  const uniforms = createUniformBuffer(device, BloomParams, `${label} params`);
  const sampler = linearSampler(device);
  const levels: RenderTarget[] = [];
  const prefilterGroups = new WeakMap<GPUTextureView, GPUBindGroup>();
  const downGroups = new WeakMap<GPUTextureView, GPUBindGroup>();
  let sizes = bloomLevelSizes(options.width, options.height, halfResolution);
  let sourceSize: [number, number] = [options.width, options.height];
  let destroyed = false;

  // Bind groups are cached per source view; a level's view changes only when it is reallocated.
  const prefilterGroupFor = (view: GPUTextureView) => {
    let group = prefilterGroups.get(view);
    if (!group) {
      group = device.createBindGroup({
        label: `${label} prefilter source`,
        layout: state.prefilterLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: uniforms.buffer } },
        ],
      });
      prefilterGroups.set(view, group);
    }
    return group;
  };

  const groupForDown = (view: GPUTextureView) => {
    let group = downGroups.get(view);
    if (!group) {
      group = device.createBindGroup({
        label: `${label} level source`,
        layout: state.downLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: sampler },
        ],
      });
      downGroups.set(view, group);
    }
    return group;
  };

  function ensure(count: number) {
    while (levels.length < count) {
      const [w, h] = sizes[levels.length] ?? [1, 1];
      levels.push(
        createRenderTarget(device, {
          label: `${label} level ${levels.length}`,
          format: BLOOM_FORMAT,
          width: w,
          height: h,
          usage,
        }),
      );
    }
  }

  return {
    format: BLOOM_FORMAT,
    levels,
    maxLevels: () => sizes.length,
    levelSizes: () => levels.map((level) => [level.width, level.height] as const),

    resize(width, height) {
      if (destroyed) return false;
      sizes = bloomLevelSizes(width, height, halfResolution);
      sourceSize = [width, height];
      let changed = false;
      // Levels past the new count are dropped so a smaller image does not keep a big chain alive.
      for (const extra of levels.splice(sizes.length)) {
        extra.destroy();
        changed = true;
      }
      levels.forEach((level, index) => {
        const [w, h] = sizes[index] ?? [1, 1];
        changed = level.resize(w, h) || changed;
      });
      return changed;
    },

    encode(encoder, source, settings = {}, profiler = noProfiler) {
      const s = { ...DEFAULT_BLOOM, ...settings };
      if (destroyed || !(s.intensity > 0)) return undefined;
      const requested = s.levels > 0 ? s.levels : bloomLevelsForSize(...sourceSize, halfResolution);
      const count = Math.min(
        sizes.length,
        Math.max(1, Math.min(MAX_BLOOM_LEVELS, Math.round(requested))),
      );
      ensure(count);

      uniforms.set({
        threshold: Math.max(0, s.threshold),
        knee: Math.max(0, s.knee),
        intensity: s.intensity,
        karis: s.fireflyFilter ? 1 : 0,
      });
      uniforms.upload();

      renderFullscreen(encoder, levels[0]!.view, state.prefilter, [prefilterGroupFor(source)], {
        label: `${label} prefilter`,
        timestampWrites: profiler.pass('bloom-down'),
      });
      for (let i = 1; i < count; i++) {
        renderFullscreen(
          encoder,
          levels[i]!.view,
          state.down,
          [groupForDown(levels[i - 1]!.view)],
          { label: `${label} down ${i}`, timestampWrites: profiler.pass('bloom-down') },
        );
      }

      // Back up: level i = mix(down[i], tent(level i+1), radius). The constant blend factor does the
      // mix in the ROP, so the finer level is read and written in place with no extra texture.
      const radius = Math.min(1, Math.max(0, s.radius));
      for (let i = count - 2; i >= 0; i--) {
        const pass = encoder.beginRenderPass({
          label: `${label} up ${i}`,
          colorAttachments: [{ view: levels[i]!.view, loadOp: 'load', storeOp: 'store' }],
          timestampWrites: profiler.pass('bloom-up'),
        });
        pass.setBlendConstant({ r: radius, g: radius, b: radius, a: radius });
        drawFullscreen(pass, state.up, groupForDown(levels[i + 1]!.view));
        pass.end();
      }
      return levels[0]!.view;
    },

    destroy() {
      destroyed = true;
      for (const level of levels.splice(0)) level.destroy();
      uniforms.destroy();
    },
  };
}
