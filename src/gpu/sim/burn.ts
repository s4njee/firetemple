import type { ObstacleRect } from '../dom-rects.ts';
import {
  getNoiseTexture,
  NOISE_TEXTURE_CELLS,
  NOISE_TEXTURE_SIZE,
} from '../emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { createFixedStepper } from '../loop.ts';
import { noProfiler, type PassProfiler } from '../profiler.ts';
import { withChunks } from '../shader.ts';
import {
  createPingPongTarget,
  createRenderTarget,
  type PingPongTarget,
  type RenderTarget,
} from '../targets.ts';
import {
  createUniformBuffer,
  defineUniformStruct,
  uniformArray,
  type UniformBuffer,
} from '../uniforms.ts';
import copyShader from './burn-copy.wgsl';
import mapShader from './burn-map.wgsl';
import reduceShader from './burn-reduce.wgsl';
import stepShader from './burn-step.wgsl';
import worldShader from './burn-world.wgsl';
import {
  collectIgniters,
  IgnitersUniform,
  writeIgniters,
  type Igniter,
  type IgnitionSource,
} from './ignition.ts';

/*
 * A burn front on a fuel map (stories 5.3 and 5.4): fire as a line that crosses fuel, consumes
 * it, glows where it is, and leaves char that crumbles.
 *
 *   const burn = createBurnSim(device, { label: 'paper' });
 *   burn.resize(...burnGridSize(canvasWidth, canvasHeight, cells));  // bumps `generation`
 *   burn.setRects([{ x: 0, y: 0, width: 1, height: 1 }]);            // what there is to burn
 *   // each frame:
 *   burn.advance(encoder, time.delta, settings, [pointer, embers], profiler);
 *   // display: sample burn.state.view (fuel, heat, char) and burn.map.view (distance to fuel)
 *
 * The state is one rgba16float texel per cell in a ping-pong pair, advanced by one render pass
 * per fixed step of BURN_STEP_SECONDS (burn-step.wgsl says what the channels are and how the
 * front is found). The fuel map is a second texture, redrawn only when the rectangles change, so
 * moving the fuel never touches what has already burnt. Everything is in canvas heights and
 * seconds, so the fire behaves the same at any grid resolution; the resolution only sets how
 * fine the front can be.
 *
 * Render passes only, no compute: the step is nine texel loads and a little arithmetic.
 */

/** Length of one simulation step, seconds. */
export const BURN_STEP_SECONDS = 1 / 60;
/** Most steps one `advance` encodes (each needs its own uniform buffers). */
export const BURN_MAX_STEPS = 4;
/** Rounded rectangles of fuel the map can hold. */
export const BURN_MAX_RECTS = 32;
export const BURN_FORMAT: GPUTextureFormat = 'rgba16float';
/** Cells on the longer side are capped here, however wide the canvas. */
export const BURN_MAX_SIDE = 2048;
/** The clock value that means "no front is on its way"; `BURN_INF` in burn-step.wgsl. */
export const BURN_NEVER = 10000;
/** Burnt-out cells hold a clock at or below minus this; `BURN_CODE` in burn-step.wgsl. */
export const BURN_CODE = 32;
/** The front can advance this share of a cell per step at most (a causality limit, like CFL). */
export const BURN_MAX_CELLS_PER_STEP = 0.85;
/** Speed of the front across a gap, as a share of its speed through even fuel. */
export const BURN_BRIDGE_SPEED = 0.7;
/** Seconds of the clock's wrap-around; regrowth cell by cell cannot wait longer than this. */
const PHASE_PERIOD = 128;
/** Seconds between runs of the "anything left?" passes. */
const WORLD_EVERY = 0.1;
/** Scale of the map's second noise layer against the first; `BURN_FINE` in burn-map.wgsl. */
const FINE_SCALE = 2.63;
/** Cells per side of a block in the "anything left?" reduction; `BURN_BLOCK` in burn-reduce.wgsl. */
const REDUCE_BLOCK = 4;

const StepUniform = defineUniformStruct('BurnStep', {
  dt: 'f32',
  cell: 'f32',
  speed: 'f32',
  climb: 'f32',
  irregular: 'f32',
  tau_min: 'f32',
  tau_max: 'f32',
  window: 'f32',
  isotropic: 'f32',
  bridge_reach: 'f32',
  bridge_speed: 'f32',
  burn_rate: 'f32',
  crumble_rate: 'f32',
  heat_rise: 'f32',
  heat_fall: 'f32',
  phase: 'f32',
  regrow_all: 'f32',
  regrow_each: 'f32',
  regrow_step: 'f32',
  tick: 'u32',
});

const MapUniform = defineUniformStruct('BurnMap', {
  count: 'u32',
  aspect: 'f32',
  grain: 'f32',
  lod_coarse: 'f32',
  lod_fine: 'f32',
  offset: 'vec2f',
  rects: uniformArray('vec4f', BURN_MAX_RECTS),
  shapes: uniformArray('vec4f', BURN_MAX_RECTS),
});

const WorldUniform = defineUniformStruct('BurnWorld', { elapsed: 'f32' });

/** When burnt fuel comes back. */
export const BURN_REGROWTH = ['all burnt', 'each cell', 'never'] as const;
export type BurnRegrowth = (typeof BURN_REGROWTH)[number];

export interface BurnSettings {
  /** Speed of the front through even fuel, canvas heights per second. */
  speed: number;
  /** How many times faster the front climbs than it spreads sideways. 1 is the same every way. Default 1. */
  climb?: number;
  /** How much the noise field changes the local speed and burn time: 0 is even, 1 is ragged. Default 0.6. */
  irregular?: number;
  /** Seconds a cell takes to burn through. With the speed, this is how wide the glowing line is. Default 0.5. */
  burnTime?: number;
  /** Seconds the glow takes to die once a cell has burnt through. Default 0.3. */
  glow?: number;
  /** Seconds before char falls away after a cell has burnt through; 0 keeps it. Default 2. */
  crumble?: number;
  /** Widest gap in the fuel the fire crosses, canvas heights. 0 stops it at any gap. Default 0. */
  jump?: number;
  /** When fuel comes back. Default `never`. */
  regrowth?: BurnRegrowth;
  /**
   * Seconds before it does: after the whole map has burnt out (`all burnt`), or after each cell
   * has (`each cell`, at most 120). Default 10.
   */
  regrow?: number;
  /** Seconds fuel takes to fade back in. Default 1.5. */
  regrowFade?: number;
}

export interface BurnSim {
  /** Cells across and down (0 before the first `resize`). */
  readonly width: number;
  readonly height: number;
  /** Size of one cell in canvas heights. */
  readonly cell: number;
  /** Bumps whenever the state or map textures are re-created: rebuild bind groups that hold their views. */
  readonly generation: number;
  /** Simulated seconds since creation. */
  readonly time: number;
  /** The newest state: r fuel, g heat, b char, a clock (burn-step.wgsl). Changes every step. */
  readonly state: RenderTarget;
  /** The state one step earlier. */
  readonly previous: RenderTarget;
  /** The fuel map: r signed distance to fuel in canvas heights, gba noise (burn-map.wgsl). */
  readonly map: RenderTarget;
  /**
   * Sets the grid size in cells. Returns true and bumps `generation` when it changed; what has
   * burnt is carried over to the new grid, nearest cell to nearest cell.
   */
  resize(width: number, height: number): boolean;
  /**
   * What there is to burn: rounded rectangles in canvas uv (at most `BURN_MAX_RECTS`; the rest
   * are dropped). The map is redrawn before the next step. The state is not touched: cells that
   * have burnt out stay burnt out wherever the fuel moves.
   */
  setRects(rects: readonly ObstacleRect[]): void;
  /** Scale (noise cells per canvas height) and seed of the irregularity. Redraws the map. */
  setGrain(grain: number, seed?: number): void;
  /** Encodes exactly one step. At most `BURN_MAX_STEPS` per submitted encoder. */
  step(
    encoder: GPUCommandEncoder,
    settings: BurnSettings,
    igniters?: readonly Igniter[],
    timestampWrites?: GPURenderPassTimestampWrites,
  ): void;
  /**
   * Encodes the whole steps `delta` seconds contain (0 to `BURN_MAX_STEPS`), polling `sources`
   * once per step, then the "anything left?" passes if regrowth needs them. Returns the steps run.
   */
  advance(
    encoder: GPUCommandEncoder,
    delta: number,
    settings: BurnSettings,
    sources?: readonly IgnitionSource[],
    profiler?: PassProfiler,
  ): number;
  /** Unburnt fuel everywhere, nothing alight. */
  reset(): void;
  destroy(): void;
}

export interface BurnSimOptions {
  label?: string;
  /** Noise cells per canvas height. Default 5. */
  grain?: number;
  /** The same seed gives the same irregularity. Default 1. */
  seed?: number;
}

/**
 * Grid size for a canvas: `cells` on the shorter side, the same aspect, capped on the longer
 * side. Never finer than two canvas pixels to a cell: below that the grid costs more than the
 * picture can show.
 */
export function burnGridSize(
  canvasWidth: number,
  canvasHeight: number,
  cells: number,
): [number, number] {
  const w = Math.max(1, canvasWidth);
  const h = Math.max(1, canvasHeight);
  const short = Math.max(8, Math.min(Math.round(cells), Math.ceil(Math.min(w, h) / 2)));
  const long = (ratio: number) =>
    Math.min(BURN_MAX_SIDE, Math.max(short, Math.round(short * ratio)));
  return w >= h ? [long(w / h), short] : [short, long(h / w)];
}

/**
 * The numbers one step needs, from the settings and the grid. Exported so tests and notes can
 * state the limits (how fast the front can go on a given grid) without restating the formulas.
 */
export function burnStepValues(settings: BurnSettings, gridHeight: number, time = 0, tick = 0) {
  const dt = BURN_STEP_SECONDS;
  const cell = 1 / Math.max(1, gridHeight);
  const speed = Math.max(1e-4, settings.speed);
  const climb = Math.min(4, Math.max(0.25, settings.climb ?? 1));
  // Seconds to cross one cell. The front cannot be asked to cross more than most of a cell in a
  // step: a cell only learns of the fire from its neighbours, one step at a time.
  const tauMin = dt / BURN_MAX_CELLS_PER_STEP;
  const perCell = Math.max(cell / speed, tauMin);
  // A lit cell can light its neighbours for `window` seconds. The slowest crossing allowed (noise
  // at its slowest, downhill, along a diagonal) has to fit inside it, or the front would stall.
  // Ages are kept exactly only up to 16 seconds, so the window stops short of that.
  const window = Math.min(15, 8.5 * perCell);
  const regrowth = settings.regrowth ?? 'never';
  const regrow = Math.max(0, settings.regrow ?? 10);
  const crumble = settings.crumble ?? 2;
  return {
    dt,
    cell,
    speed,
    climb,
    irregular: Math.min(1.5, Math.max(0, settings.irregular ?? 0.6)),
    tau_min: tauMin,
    tau_max: window / 1.6,
    window,
    isotropic: Math.abs(climb - 1) < 1e-3 ? 1 : 0,
    bridge_reach: Math.max(0, settings.jump ?? 0) / 2,
    bridge_speed: BURN_BRIDGE_SPEED,
    burn_rate: 1 / Math.max(0.05, settings.burnTime ?? 0.5),
    crumble_rate: crumble > 0 ? 1 / Math.max(0.05, crumble) : 0,
    heat_rise: 1 - Math.exp(-dt / 0.06),
    heat_fall: 1 - Math.exp(-dt / Math.max(0.02, settings.glow ?? 0.3)),
    phase: (time / PHASE_PERIOD) % 1,
    regrow_all: regrowth === 'all burnt' ? regrow : -1,
    regrow_each: regrowth === 'each cell' ? Math.min(regrow, 120) / PHASE_PERIOD : -1,
    regrow_step: dt / Math.max(dt, settings.regrowFade ?? 1.5),
    tick: tick >>> 0,
  };
}

interface StepSlot {
  step: UniformBuffer<typeof StepUniform.fields>;
  igniters: UniformBuffer<typeof IgnitersUniform.fields>;
  /** One bind group per (state parity, world parity). */
  groups: (GPUBindGroup | undefined)[];
}

export function createBurnSim(device: GPUDevice, options: BurnSimOptions = {}): BurnSim {
  const label = options.label ?? 'burn';
  const noise = getNoiseTexture(device);
  const stepPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(stepShader, { 'burn-step-uniforms.wgsl': StepUniform.wgsl }),
    format: BURN_FORMAT,
    label: `${label} step`,
  });
  const mapPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(mapShader, { 'burn-map-uniforms.wgsl': MapUniform.wgsl }),
    format: BURN_FORMAT,
    label: `${label} map`,
  });
  const reducePipeline = createFullscreenPipeline(device, {
    fragment: reduceShader,
    format: BURN_FORMAT,
    label: `${label} reduce`,
  });
  const maxPipeline = createFullscreenPipeline(device, {
    fragment: reduceShader,
    entryPoint: 'fs_max',
    format: BURN_FORMAT,
    label: `${label} reduce max`,
  });
  const worldPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(worldShader, { 'burn-world-uniforms.wgsl': WorldUniform.wgsl }),
    format: BURN_FORMAT,
    label: `${label} world`,
  });
  const copyPipeline = createFullscreenPipeline(device, {
    fragment: copyShader,
    format: BURN_FORMAT,
    label: `${label} copy`,
  });

  const slots: StepSlot[] = Array.from({ length: BURN_MAX_STEPS }, (_, index) => ({
    step: createUniformBuffer(device, StepUniform, `${label} step ${index}`),
    igniters: createUniformBuffer(device, IgnitersUniform, `${label} igniters ${index}`),
    groups: [],
  }));
  const mapUniforms = createUniformBuffer(device, MapUniform, `${label} map`);
  const worldUniforms = createUniformBuffer(device, WorldUniform, `${label} world`);
  const mapBindGroup = device.createBindGroup({
    label: `${label} map`,
    layout: mapPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: mapUniforms.buffer } },
      { binding: 1, resource: noise.view },
      { binding: 2, resource: noise.sampler },
    ],
  });

  // The one texel that says whether anything is left to burn, and for how long nothing has been.
  const world = createPingPongTarget(device, {
    label: `${label} world`,
    format: BURN_FORMAT,
    width: 1,
    height: 1,
  });
  let worldParity = 0;

  const usage =
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.TEXTURE_BINDING |
    // Lets tests and tools read the state back; costs nothing.
    GPUTextureUsage.COPY_SRC;
  let state: PingPongTarget | undefined;
  let stateParity = 0;
  let map: RenderTarget | undefined;
  /** The reduction pyramid, finest first; the last level is at most 4 x 4. */
  let levels: RenderTarget[] = [];
  let levelGroups: GPUBindGroup[] = [];
  let reduceGroups: (GPUBindGroup | undefined)[] = [];
  let worldGroups: (GPUBindGroup | undefined)[] = [];

  let generation = 0;
  let time = 0;
  let tick = 0;
  /** Simulated seconds the "anything left?" passes have not yet counted. */
  let unreduced = 0;
  let slot = 0;
  let rects: readonly ObstacleRect[] = [];
  let grain = options.grain ?? 5;
  let seed = options.seed ?? 1;
  let mapDirty = true;
  const stepper = createFixedStepper(BURN_STEP_SECONDS, { maxSteps: BURN_MAX_STEPS });

  const need = (): PingPongTarget => {
    if (!state) throw new Error(`${label}: resize() must be called before the simulation is used`);
    return state;
  };

  function forgetGroups() {
    for (const each of slots) each.groups = [];
    reduceGroups = [];
    worldGroups = [];
    levelGroups = levels.slice(1).map((_, i) =>
      device.createBindGroup({
        label: `${label} reduce max`,
        layout: maxPipeline.getBindGroupLayout(0),
        entries: [{ binding: 2, resource: levels[i]!.view }],
      }),
    );
  }

  /** Unburnt fuel, no heat, no char, no front on its way. */
  function clearState(pair: PingPongTarget) {
    const encoder = device.createCommandEncoder({ label: `${label} clear` });
    for (const target of [pair.read, pair.write]) {
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: target.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 1, g: 0, b: 0, a: BURN_NEVER },
            },
          ],
        })
        .end();
    }
    for (const target of [world.read, world.write]) {
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: target.view,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 1, g: 0, b: 0, a: 1 },
            },
          ],
        })
        .end();
    }
    device.queue.submit([encoder.finish()]);
  }

  function drawMap() {
    const target = map!;
    const count = Math.min(rects.length, BURN_MAX_RECTS);
    const boxes = new Float32Array(BURN_MAX_RECTS * 4);
    const shapes = new Float32Array(BURN_MAX_RECTS * 4);
    for (let i = 0; i < count; i++) {
      const rect = rects[i]!;
      // Centre and half size in uv; the corner radius is already in canvas heights.
      boxes.set(
        [rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2],
        i * 4,
      );
      shapes.set([Math.max(0, rect.radius ?? 0), 0, 0, 0], i * 4);
    }
    // The seed moves the map to another part of the noise tile.
    const s = seed >>> 0;
    const cells = Math.max(0.1, grain);
    // Texels of the noise tile per grid cell, for the mip level each layer is read at.
    const texels = (cells * (NOISE_TEXTURE_SIZE / NOISE_TEXTURE_CELLS)) / target.height;
    mapUniforms.set({
      count,
      aspect: target.width / target.height,
      grain: cells,
      lod_coarse: Math.max(0, Math.log2(texels)),
      lod_fine: Math.max(0, Math.log2(texels * FINE_SCALE)),
      offset: [((s * 0.618034) % 1) * 8, ((s * 0.754878) % 1) * 8],
      rects: boxes,
      shapes,
    });
    mapUniforms.upload();
    const encoder = device.createCommandEncoder({ label: `${label} map` });
    renderFullscreen(encoder, target.view, mapPipeline, [mapBindGroup]);
    device.queue.submit([encoder.finish()]);
    mapDirty = false;
  }

  function stepGroup(use: StepSlot, pair: PingPongTarget): GPUBindGroup {
    const key = stateParity * 2 + worldParity;
    return (use.groups[key] ??= device.createBindGroup({
      label: `${label} step`,
      layout: stepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: use.step.buffer } },
        { binding: 1, resource: { buffer: use.igniters.buffer } },
        { binding: 2, resource: pair.read.view },
        { binding: 3, resource: map!.view },
        { binding: 4, resource: world.read.view },
      ],
    }));
  }

  function encodeStep(
    encoder: GPUCommandEncoder,
    settings: BurnSettings,
    igniters: readonly Igniter[],
    timestampWrites: GPURenderPassTimestampWrites | undefined,
  ) {
    const pair = need();
    if (mapDirty) drawMap();
    const use = slots[slot]!;
    slot = (slot + 1) % BURN_MAX_STEPS;
    use.step.set(burnStepValues(settings, pair.read.height, time, tick++));
    use.step.upload();
    writeIgniters(use.igniters, igniters, pair.read.width / pair.read.height);
    use.igniters.upload();
    renderFullscreen(encoder, pair.write.view, stepPipeline, [stepGroup(use, pair)], {
      label: `${label} step`,
      timestampWrites,
    });
    pair.swap();
    stateParity ^= 1;
    time += BURN_STEP_SECONDS;
  }

  /** Looks for anything still live and keeps the time since nothing was. */
  function encodeWorld(encoder: GPUCommandEncoder, elapsed: number, profiler: PassProfiler) {
    const pair = need();
    const reduceGroup = (reduceGroups[stateParity] ??= device.createBindGroup({
      label: `${label} reduce`,
      layout: reducePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: pair.read.view },
        { binding: 1, resource: map!.view },
      ],
    }));
    renderFullscreen(encoder, levels[0]!.view, reducePipeline, [reduceGroup], {
      label: `${label} reduce`,
      timestampWrites: profiler.pass('burn reduce'),
    });
    for (let i = 1; i < levels.length; i++) {
      renderFullscreen(encoder, levels[i]!.view, maxPipeline, [levelGroups[i - 1]!], {
        label: `${label} reduce max`,
      });
    }
    worldUniforms.set({ elapsed });
    worldUniforms.upload();
    const worldGroup = (worldGroups[worldParity] ??= device.createBindGroup({
      label: `${label} world`,
      layout: worldPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: worldUniforms.buffer } },
        { binding: 1, resource: levels[levels.length - 1]!.view },
        { binding: 2, resource: world.read.view },
      ],
    }));
    renderFullscreen(encoder, world.write.view, worldPipeline, [worldGroup], {
      label: `${label} world`,
      timestampWrites: profiler.pass('burn world'),
    });
    world.swap();
    worldParity ^= 1;
  }

  return {
    get width() {
      return state?.read.width ?? 0;
    },
    get height() {
      return state?.read.height ?? 0;
    },
    get cell() {
      return 1 / (state?.read.height ?? 1);
    },
    get generation() {
      return generation;
    },
    get time() {
      return time;
    },
    get state() {
      return need().read;
    },
    get previous() {
      return need().write;
    },
    get map() {
      need();
      return map!;
    },

    resize(width, height) {
      const w = Math.min(BURN_MAX_SIDE, Math.max(1, Math.round(width)));
      const h = Math.min(BURN_MAX_SIDE, Math.max(1, Math.round(height)));
      if (state && state.read.width === w && state.read.height === h) return false;
      const old = state;
      state = createPingPongTarget(device, {
        label: `${label} state`,
        format: BURN_FORMAT,
        width: w,
        height: h,
        usage,
      });
      stateParity = 0;
      if (old) {
        // Keep what has burnt: a resize must not hand the page a fresh sheet of paper.
        const encoder = device.createCommandEncoder({ label: `${label} carry over` });
        const group = device.createBindGroup({
          label: `${label} copy`,
          layout: copyPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: old.read.view }],
        });
        renderFullscreen(encoder, state.read.view, copyPipeline, [group]);
        renderFullscreen(encoder, state.write.view, copyPipeline, [group]);
        device.queue.submit([encoder.finish()]);
        old.destroy();
      } else {
        clearState(state);
      }
      map?.destroy();
      map = createRenderTarget(device, {
        label: `${label} map`,
        format: BURN_FORMAT,
        width: w,
        height: h,
        usage,
      });
      for (const level of levels) level.destroy();
      levels = [];
      let lw = w;
      let lh = h;
      do {
        lw = Math.ceil(lw / REDUCE_BLOCK);
        lh = Math.ceil(lh / REDUCE_BLOCK);
        levels.push(
          createRenderTarget(device, {
            label: `${label} reduce ${levels.length}`,
            format: BURN_FORMAT,
            width: lw,
            height: lh,
          }),
        );
      } while (lw > REDUCE_BLOCK || lh > REDUCE_BLOCK);
      mapDirty = true;
      forgetGroups();
      generation++;
      return true;
    },

    setRects(next) {
      rects = next.slice(0, BURN_MAX_RECTS);
      mapDirty = true;
    },

    setGrain(nextGrain, nextSeed = seed) {
      if (nextGrain === grain && nextSeed === seed) return;
      grain = nextGrain;
      seed = nextSeed;
      mapDirty = true;
    },

    step(encoder, settings, igniters = [], timestampWrites) {
      encodeStep(encoder, settings, igniters, timestampWrites);
    },

    advance(encoder, delta, settings, sources = [], profiler = noProfiler) {
      need();
      // Redraw the map even on a frame with no step: the display reads it too.
      if (mapDirty) drawMap();
      const { steps } = stepper.advance(delta);
      for (let i = 0; i < steps; i++) {
        const igniters = collectIgniters(BURN_STEP_SECONDS, ...sources);
        encodeStep(encoder, settings, igniters, profiler.pass('burn step'));
      }
      // Only regrowth of the whole map needs to know whether anything is left.
      // A tenth of a second late is soon enough, so it runs every sixth step or so, not every frame.
      if ((settings.regrowth ?? 'never') === 'all burnt') {
        unreduced += steps * BURN_STEP_SECONDS;
        if (unreduced >= WORLD_EVERY - 1e-9) {
          encodeWorld(encoder, unreduced, profiler);
          unreduced = 0;
        }
      }
      return steps;
    },

    reset() {
      if (state) clearState(state);
    },

    destroy() {
      state?.destroy();
      map?.destroy();
      for (const level of levels) level.destroy();
      world.destroy();
      for (const each of slots) {
        each.step.destroy();
        each.igniters.destroy();
      }
      mapUniforms.destroy();
      worldUniforms.destroy();
      state = undefined;
      map = undefined;
      levels = [];
    },
  };
}
