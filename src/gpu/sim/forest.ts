import { getNoiseTexture } from '../emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { withChunks, type ShaderSource } from '../shader.ts';
import { createPingPongTarget, type PingPongTarget, type RenderTarget } from '../targets.ts';
import { createUniformBuffer, defineUniformStruct, type UniformBuffer } from '../uniforms.ts';
import landShader from './forest-land.wgsl';
import seedShader from './forest-seed.wgsl';
import stepShader from './forest-step.wgsl';
import { IgnitersUniform, writeIgniters, type Igniter } from './ignition.ts';

/*
 * A forest-fire automaton (story 5.5): burn, spread, regrow, with wind.
 *
 *   const forest = createForestSim(device, { seed: 1 });
 *   forest.resize(320, 180);                       // cells; re-seeds, bumps `generation`
 *   // each fixed step, at most FOREST_STEPS_PER_SUBMIT of them per submitted encoder:
 *   forest.step(encoder, { growth, spread, wind, windAngle, aspect }, igniters);
 *   // display: sample forest.current.view (and forest.previous.view to blend between steps)
 *
 * The state is one rgba16float texel per cell (fuel, burning, scorch, smoke: see
 * forest-step.wgsl) in a ping-pong pair, advanced by one render pass per step. Randomness is a
 * hash of the cell, the step number and the seed, so a run is repeatable on a given device.
 */

/** Steps that can be encoded before the encoder is submitted (each needs its own uniforms). */
export const FOREST_STEPS_PER_SUBMIT = 4;
export const FOREST_FORMAT: GPUTextureFormat = 'rgba16float';
/** Cells on the longer side are capped here, however wide the canvas. */
export const FOREST_MAX_SIDE = 2048;

/** Starting states; the numbers are `start` in forest-seed.wgsl. */
export const FOREST_LAYOUTS = ['landscape', 'full', 'empty'] as const;
export type ForestLayout = (typeof FOREST_LAYOUTS)[number];

const StepUniform = defineUniformStruct('ForestStep', {
  size: 'vec2f',
  wind_dir: 'vec2f',
  land_offset: 'vec2f',
  plume_phase: 'vec2f',
  step: 'u32',
  seed: 'u32',
  aspect: 'f32',
  terrain: 'f32',
  growth: 'f32',
  spread: 'f32',
  wind_gain: 'f32',
  spot: 'f32',
  plume_drift: 'f32',
  plume_wobble: 'f32',
  plume_keep: 'f32',
});

const SeedUniform = defineUniformStruct('ForestSeed', {
  size: 'vec2f',
  land_offset: 'vec2f',
  aspect: 'f32',
  terrain: 'f32',
  seed: 'u32',
  start: 'u32',
});

/** How strongly full wind favours spread downwind: the chance is multiplied by exp(±this). */
export const FOREST_WIND_GAIN = 2.2;
/** Wind (0..1) below which no embers are carried two cells. */
export const FOREST_SPOT_FROM = 0.2;
/** Weight of a two-cell ember jump straight downwind at full wind. */
export const FOREST_SPOT_WEIGHT = 4;
/** Cells per step that full wind adds to the drift of smoke (any wind at all gives 0.4). */
export const FOREST_SMOKE_DRIFT = 2.2;

export interface ForestStepParams {
  /** Fuel a cell gains per step, on average (the model's `p`). 0 stops growth. */
  growth: number;
  /** Scales every chance of catching from a neighbour. 1 is the tuned default. */
  spread: number;
  /** Wind strength, 0..1. */
  wind: number;
  /** Direction the wind blows TOWARDS, in radians: 0 is right, a quarter turn is up the screen. */
  windAngle: number;
  /** Width / height of the area the grid covers. Igniter radii are in heights of it. */
  aspect: number;
  /** How much the land varies: 0 is good soil everywhere, 1 has lakes and thin soil. Default 0. */
  terrain?: number;
  /** Share of the smoke that survives a step. Default 0.965. */
  smokeKeep?: number;
}

export interface ForestSim {
  /** Cells across and down. */
  readonly width: number;
  readonly height: number;
  /** Bumps whenever the state textures are re-created: rebuild bind groups that hold their views. */
  readonly generation: number;
  /** Steps taken since the last seeding. */
  readonly steps: number;
  /** The newest state. */
  readonly current: RenderTarget;
  /** The state one step earlier, for blending between steps when drawing. */
  readonly previous: RenderTarget;
  /** `forest-land.wgsl` and what it includes, as include chunks for a display shader. */
  readonly landChunks: Readonly<Record<string, string>>;
  /** Where the map sits on the noise tile; pass it to `forest_land` as `offset`. */
  readonly landOffset: readonly [number, number];
  /**
   * Sets the grid size. Returns true, re-seeds and bumps `generation` when it changed (the old
   * state is lost); false when the size is the same.
   */
  resize(width: number, height: number): boolean;
  /** Starts again from a fresh state. `terrain` must match what the steps will be given. */
  reseed(options?: {
    layout?: ForestLayout;
    seed?: number;
    terrain?: number;
    aspect?: number;
  }): void;
  /**
   * Sets every cell of a rectangle (in cells, clipped to the grid) to one state, in both
   * textures: a firebreak, a lake, a stand of old trees, a fire. `[fuel, burning, scorch, smoke]`.
   */
  paint(
    x: number,
    y: number,
    width: number,
    height: number,
    cell: readonly [number, number, number, number],
  ): void;
  /** Encodes one step. No more than `FOREST_STEPS_PER_SUBMIT` per submitted encoder. */
  step(
    encoder: GPUCommandEncoder,
    params: ForestStepParams,
    igniters?: readonly Igniter[],
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
  destroy(): void;
}

export interface ForestSimOptions {
  label?: string;
  /** The same seed gives the same landscape and the same run. Default 1. */
  seed?: number;
  /** The state `resize` seeds with. Default `landscape`. */
  layout?: ForestLayout;
  /** Terrain the first seeding assumes, 0..1. Default 0. */
  terrain?: number;
}

/** Grid size for a canvas: `cells` on the shorter side, the same aspect, capped on the longer. */
export function forestGridSize(
  canvasWidth: number,
  canvasHeight: number,
  cells: number,
): [number, number] {
  const short = Math.max(8, Math.round(cells));
  const aspect = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 1;
  const long = (ratio: number) =>
    Math.min(FOREST_MAX_SIDE, Math.max(short, Math.round(short * ratio)));
  return aspect >= 1 ? [long(aspect), short] : [short, long(1 / aspect)];
}

/** A number to IEEE half precision bits (round to nearest; enough for state values). */
export function toHalf(value: number): number {
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    return sign | ((mantissa | 0x800000) >> (14 - exponent));
  }
  if (exponent >= 31) return sign | 0x7c00;
  // Added, not or-ed: a mantissa that rounds up carries into the exponent.
  return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
}

// mulberry32 once: a seed to two offsets on the noise tile (which is 8 cells across).
function landOffsetOf(seed: number): [number, number] {
  let t = ((seed >>> 0) + 0x6d2b79f5) >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return [next() * 8, next() * 8];
}

export function createForestSim(device: GPUDevice, options: ForestSimOptions = {}): ForestSim {
  const label = options.label ?? 'forest';
  const noise = getNoiseTexture(device);
  const landChunks: Record<string, string> = {
    ...(landShader as ShaderSource).chunks,
    'forest-land.wgsl': landShader.code,
  };

  const stepPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(stepShader, { 'forest-step-params.wgsl': StepUniform.wgsl }),
    format: FOREST_FORMAT,
  });
  const seedPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(seedShader, { 'forest-seed-params.wgsl': SeedUniform.wgsl }),
    format: FOREST_FORMAT,
  });
  const sampler = device.createSampler({
    label: `${label} state sampler`,
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const seedUniforms = createUniformBuffer(device, SeedUniform, `${label} seed`);
  const seedBindGroup = device.createBindGroup({
    label: `${label} seed`,
    layout: seedPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: seedUniforms.buffer } },
      { binding: 1, resource: noise.view },
      { binding: 2, resource: noise.sampler },
    ],
  });

  // Uniform writes land before the next submit, so several steps in one encoder each need a
  // buffer of their own, or they would all see the last step's number and repeat its dice.
  interface Slot {
    step: UniformBuffer<typeof StepUniform.fields>;
    igniters: UniformBuffer<typeof IgnitersUniform.fields>;
    /** One bind group per state texture it can read from. */
    groups: [GPUBindGroup | undefined, GPUBindGroup | undefined];
  }
  const slots: Slot[] = Array.from({ length: FOREST_STEPS_PER_SUBMIT }, (_, index) => ({
    step: createUniformBuffer(device, StepUniform, `${label} step ${index}`),
    igniters: createUniformBuffer(device, IgnitersUniform, `${label} igniters ${index}`),
    groups: [undefined, undefined],
  }));

  let seed = (options.seed ?? 1) >>> 0;
  let layout: ForestLayout = options.layout ?? 'landscape';
  let terrain = options.terrain ?? 0;
  let landOffset = landOffsetOf(seed);
  let aspectAtSeed = 1;
  let state: PingPongTarget | undefined;
  // Which of the pair is being read; the bind groups are keyed by it.
  let parity: 0 | 1 = 0;
  let generation = 0;
  let steps = 0;
  let slot = 0;
  let smokePhase = 0;

  const need = (): PingPongTarget => {
    if (!state) throw new Error('ForestSim: call resize() before using the state');
    return state;
  };

  function seedState() {
    const pair = need();
    seedUniforms.set({
      size: [pair.read.width, pair.read.height],
      land_offset: landOffset,
      aspect: aspectAtSeed,
      terrain,
      seed,
      start: FOREST_LAYOUTS.indexOf(layout),
    });
    seedUniforms.upload();
    const encoder = device.createCommandEncoder({ label: `${label} seed` });
    // Both textures: the display blends the newest state with the one before it.
    renderFullscreen(encoder, pair.read.view, seedPipeline, [seedBindGroup]);
    renderFullscreen(encoder, pair.write.view, seedPipeline, [seedBindGroup]);
    device.queue.submit([encoder.finish()]);
    steps = 0;
    smokePhase = 0;
  }

  return {
    get width() {
      return state?.read.width ?? 0;
    },
    get height() {
      return state?.read.height ?? 0;
    },
    get generation() {
      return generation;
    },
    get steps() {
      return steps;
    },
    get current() {
      return need().read;
    },
    get previous() {
      return need().write;
    },
    landChunks,
    get landOffset() {
      return landOffset;
    },

    resize(width, height) {
      const w = Math.min(FOREST_MAX_SIDE, Math.max(1, Math.round(width)));
      const h = Math.min(FOREST_MAX_SIDE, Math.max(1, Math.round(height)));
      if (state && state.read.width === w && state.read.height === h) return false;
      state?.destroy();
      state = createPingPongTarget(device, {
        label: `${label} state`,
        format: FOREST_FORMAT,
        width: w,
        height: h,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          // Lets tests and tools read the state back, and `paint` write into it.
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      parity = 0;
      for (const each of slots) each.groups = [undefined, undefined];
      aspectAtSeed = w / h;
      generation++;
      seedState();
      return true;
    },

    reseed(next = {}) {
      if (next.seed !== undefined) {
        seed = next.seed >>> 0;
        landOffset = landOffsetOf(seed);
      }
      layout = next.layout ?? layout;
      terrain = next.terrain ?? terrain;
      aspectAtSeed = next.aspect ?? aspectAtSeed;
      if (state) seedState();
    },

    paint(x, y, width, height, cell) {
      const pair = need();
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(pair.read.width, Math.round(x + width));
      const y1 = Math.min(pair.read.height, Math.round(y + height));
      if (x1 <= x0 || y1 <= y0) return;
      const texel = cell.map(toHalf);
      const data = new Uint16Array((x1 - x0) * (y1 - y0) * 4);
      for (let i = 0; i < data.length; i += 4) data.set(texel, i);
      for (const target of [pair.read, pair.write]) {
        device.queue.writeTexture(
          { texture: target.texture, origin: [x0, y0] },
          data,
          { bytesPerRow: (x1 - x0) * 8 },
          [x1 - x0, y1 - y0],
        );
      }
    },

    step(encoder, params, igniters = [], timestampWrites) {
      const pair = need();
      const use = slots[slot]!;
      slot = (slot + 1) % FOREST_STEPS_PER_SUBMIT;

      const wind = Math.min(1, Math.max(0, params.wind));
      // Up the screen is -y in uv.
      const windDir: [number, number] = [Math.cos(params.windAngle), -Math.sin(params.windAngle)];
      const spot =
        (FOREST_SPOT_WEIGHT * Math.max(0, wind - FOREST_SPOT_FROM)) / (1 - FOREST_SPOT_FROM);
      // The wobble field drifts a twentieth of a noise cell per step and wraps with the tile.
      smokePhase = (smokePhase + 0.05) % 8;
      use.step.set({
        size: [pair.read.width, pair.read.height],
        wind_dir: windDir,
        land_offset: landOffset,
        plume_phase: [smokePhase, smokePhase * 0.37],
        step: steps >>> 0,
        seed,
        aspect: params.aspect > 0 ? params.aspect : 1,
        terrain: Math.min(1, Math.max(0, params.terrain ?? 0)),
        // A chance per step: more than one quantum per step is not a rate the rule can keep.
        growth: Math.min(0.2, Math.max(0, params.growth)),
        spread: Math.max(0, params.spread),
        wind_gain: FOREST_WIND_GAIN * wind,
        spot,
        // Smoke outruns the fire: a light wind already carries it half a cell a step.
        plume_drift: wind > 0 ? 0.4 + FOREST_SMOKE_DRIFT * wind : 0,
        plume_wobble: 0.5 + 0.5 * wind,
        plume_keep: Math.min(0.999, Math.max(0, params.smokeKeep ?? 0.965)),
      });
      use.step.upload();
      writeIgniters(use.igniters, igniters, params.aspect);
      use.igniters.upload();

      use.groups[parity] ??= device.createBindGroup({
        label: `${label} step`,
        layout: stepPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: use.step.buffer } },
          { binding: 1, resource: { buffer: use.igniters.buffer } },
          { binding: 2, resource: pair.read.view },
          { binding: 3, resource: sampler },
          { binding: 4, resource: noise.view },
          { binding: 5, resource: noise.sampler },
        ],
      });
      renderFullscreen(encoder, pair.write.view, stepPipeline, [use.groups[parity]!], {
        label: `${label} step`,
        timestampWrites,
      });
      pair.swap();
      parity = parity === 0 ? 1 : 0;
      steps++;
    },

    destroy() {
      state?.destroy();
      state = undefined;
      seedUniforms.destroy();
      for (const each of slots) {
        each.step.destroy();
        each.igniters.destroy();
      }
    },
  };
}
