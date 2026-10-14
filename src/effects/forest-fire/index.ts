import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createFixedStepper, type FixedStepper } from '../../gpu/loop.ts';
import { createHdrTail, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { createRenderTarget, type RenderTarget } from '../../gpu/targets.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import {
  createForestSim,
  forestGridSize,
  FOREST_FORMAT,
  FOREST_STEPS_PER_SUBMIT,
  type ForestSim,
} from '../../gpu/sim/forest.ts';
import {
  collectIgniters,
  createAmbientIgnition,
  createPointerIgnition,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import betweenShader from './between.wgsl';
import shader from './landscape.wgsl';
import { meta } from './meta.ts';

const Params = defineUniformStruct('Params', {
  size: 'vec2f',
  land_offset: 'vec2f',
  aspect: 'f32',
  terrain: 'f32',
  palette: 'f32',
  pixelated: 'f32',
  intensity: 'f32',
  smoke: 'f32',
  grain_lod: 'f32',
});

const Between = defineUniformStruct('Between', { weight_a: 'f32' });

/** The index is `PALETTE_*` in landscape.wgsl. */
const PALETTES = ['forest', 'embers', 'night'] as const;

/** A cell is never drawn smaller than this many pixels: a finer grid would only alias. */
export const MIN_CELL_PIXELS = 2;
/** Full drive (scroll or sound at its loudest) adds this share of the calm lightning rate. */
export const DRIVE_LIGHTNING_SHARE = 1;
/** ...and this share of the calm wind. */
export const DRIVE_WIND_SHARE = 0.35;
/** Reach of a lightning strike, in cells. */
const STRIKE_CELLS = 1.6;
/** Texels of the noise tile per noise cell (256 texels, 8 cells), and grain cells per height. */
const NOISE_TEXELS_PER_CELL = 32;
const GRAIN_SCALE = 26;

/** The grid for a canvas: `resolution` cells on the shorter side unless the canvas is too small. */
export function forestGrid(width: number, height: number, resolution: number): [number, number] {
  const short = Math.max(1, Math.min(width, height));
  const cells = Math.min(Math.round(resolution), Math.floor(short / MIN_CELL_PIXELS));
  return forestGridSize(width, height, Math.max(16, cells));
}

/** The running effect, with its automaton exposed for tests and for anything that reads the state. */
export interface ForestFireInstance extends EffectInstance {
  readonly forest: ForestSim;
  /** Bumps when the grid is re-created (a new size, so a new state). */
  readonly generation: number;
}

export const effect = defineEffect({
  meta,
  params: {
    palette: { type: 'select', default: 'forest', options: PALETTES },
    resolution: { type: 'number', default: 180, min: 48, max: 360, step: 4 },
    rate: { type: 'number', default: 15, min: 2, max: 40, step: 1, label: 'steps per second' },
    growth: {
      type: 'number',
      default: 0.01,
      min: 0,
      max: 0.05,
      step: 0.001,
      label: 'growth (p, per second)',
    },
    lightning: {
      type: 'number',
      default: 1,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'lightning (f, strikes per second)',
    },
    spread: { type: 'number', default: 1, min: 0.05, max: 2, step: 0.01 },
    wind: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    direction: {
      type: 'number',
      default: 20,
      min: 0,
      max: 360,
      step: 1,
      label: 'wind direction (degrees)',
    },
    terrain: {
      type: 'number',
      default: 0.6,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'lakes and thin soil',
    },
    smoke: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    brush: { type: 'number', default: 0.03, min: 0.01, max: 0.12, step: 0.005 },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    pixelated: { type: 'boolean', default: false },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    seed: { type: 'number', default: 1, min: 1, max: 64, step: 1 },
    ...TAIL_PARAMS,
  },
  presets: {
    'living forest': {},
    'quiet valley': { growth: 0.004, lightning: 0.12, wind: 0.15, spread: 0.9, smoke: 0.5 },
    'windy day': { growth: 0.008, lightning: 0.25, wind: 0.85, direction: 15, smoke: 0.9 },
    'all sizes': { growth: 0.006, lightning: 1.6, rate: 30, wind: 0, terrain: 0.4, smoke: 0.4 },
    embers: { palette: 'embers', growth: 0.012, lightning: 1.2, wind: 0.2, smoke: 0.5 },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<ForestFireInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'forest-fire' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'forest-fire params');
    const forest = createForestSim(device, {
      label: 'forest-fire',
      seed: params.seed,
      terrain: params.terrain,
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, forest.landChunks, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const betweenUniforms = createUniformBuffer(device, Between, 'forest-fire between');
    const betweenPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(betweenShader, { 'between-params.wgsl': Between.wgsl }),
      format: FOREST_FORMAT,
    });
    // The state as this frame shows it, at grid size.
    const shown = createRenderTarget(device, {
      label: 'forest-fire shown state',
      format: FOREST_FORMAT,
      width: 1,
      height: 1,
    });
    const sampler = device.createSampler({
      label: 'forest-fire state sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // Story 5.2: taps, drags and several fingers. Story 5.7: lightning, the model's `f`.
    const pointer = createPointerIgnition(canvas, { radius: params.brush });
    const lightning = createAmbientIgnition({ rate: params.lightning, seed: params.seed });
    // Story 5.8: a 0..1 level from the page's scrolling or from sound.
    let drive = createExcitation(params.drive, canvas);

    let stepper: FixedStepper | undefined;
    let stepperRate = 0;
    let canvasWidth = 1;
    let canvasHeight = 1;
    let seed = params.seed;

    // The two state textures swap roles every step. Both are bound, and a weight says how much
    // of each to show, so the bind groups last until the grid is re-created.
    let bindGroup: GPUBindGroup | undefined;
    let betweenGroup: GPUBindGroup | undefined;
    let boundGeneration = -1;
    let textureA: RenderTarget | undefined;

    const regrid = () => {
      const [columns, rows] = forestGrid(canvasWidth, canvasHeight, params.resolution);
      forest.resize(columns, rows);
      if (boundGeneration === forest.generation) return;
      boundGeneration = forest.generation;
      textureA = forest.current;
      shown.resize(forest.width, forest.height);
      betweenGroup = device.createBindGroup({
        label: 'forest-fire between',
        layout: betweenPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: betweenUniforms.buffer } },
          { binding: 1, resource: forest.current.view },
          { binding: 2, resource: forest.previous.view },
        ],
      });
      bindGroup = device.createBindGroup({
        label: 'forest-fire',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.buffer } },
          { binding: 1, resource: shown.view },
          { binding: 3, resource: sampler },
          { binding: 4, resource: noise.view },
          { binding: 5, resource: noise.sampler },
        ],
      });
    };

    return {
      forest,
      get generation() {
        return forest.generation;
      },

      resize(width, height) {
        canvasWidth = Math.max(1, width);
        canvasHeight = Math.max(1, height);
        tail.resize(width, height);
        regrid();
      },

      frame(time, encoder, target) {
        if (params.seed !== seed) {
          seed = params.seed;
          forest.reseed({ seed, terrain: params.terrain });
        }
        // The grid follows the `resolution` parameter and the canvas's shape. A change of pixel
        // size alone keeps the state, unless the canvas is too small to show the cells.
        regrid();
        if (!bindGroup || !betweenGroup) return;
        const aspect = canvasWidth / canvasHeight;

        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        // A level, never a clock: it adds lightning and wind as a share of their calm values.
        const level = drive.update(time.delta);
        lightning.rate = params.lightning * (1 + DRIVE_LIGHTNING_SHARE * level);
        lightning.radius = STRIKE_CELLS / forest.height;
        pointer.radius = params.brush;
        const wind = Math.min(1, params.wind * (1 + DRIVE_WIND_SHARE * level));

        const rate = Math.min(Math.max(params.rate, 1), 60);
        if (!stepper || rate !== stepperRate) {
          stepper = createFixedStepper(1 / rate, { maxSteps: FOREST_STEPS_PER_SUBMIT });
          stepperRate = rate;
        }
        const dt = 1 / rate;
        const { steps, alpha } = stepper.advance(time.delta);
        for (let i = 0; i < steps; i++) {
          forest.step(
            encoder,
            {
              // Growth is per second, so the step rate changes how fast fire moves and nothing else.
              growth: params.growth * dt,
              spread: params.spread,
              wind,
              windAngle: (params.direction * Math.PI) / 180,
              aspect,
              terrain: params.terrain,
            },
            // The pointer first: it wins when there are too many igniters for one step.
            collectIgniters(dt, pointer, lightning),
            profiler.pass('step'),
          );
        }

        uniforms.set({
          size: [forest.width, forest.height],
          land_offset: [forest.landOffset[0], forest.landOffset[1]],
          aspect,
          terrain: params.terrain,
          palette: Math.max(0, PALETTES.indexOf(params.palette as (typeof PALETTES)[number])),
          pixelated: params.pixelated ? 1 : 0,
          intensity: params.intensity,
          smoke: params.smoke,
          // The grain is finer than the pixels on a small canvas: read a coarser level there.
          grain_lod: Math.max(
            0,
            Math.log2((GRAIN_SCALE * NOISE_TEXELS_PER_CELL) / Math.max(1, canvasHeight)),
          ),
        });
        uniforms.upload();
        // Blend from the step before to the newest one as the frame moves past it.
        betweenUniforms.set({ weight_a: forest.current === textureA ? alpha : 1 - alpha });
        betweenUniforms.upload();
        renderFullscreen(encoder, shown.view, betweenPipeline, [betweenGroup], {
          timestampWrites: profiler.pass('between'),
        });
        renderFullscreen(encoder, tail.scene.view, pipeline, [bindGroup], {
          timestampWrites: profiler.pass('landscape'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        pointer.destroy();
        lightning.destroy();
        drive.destroy();
        forest.destroy();
        shown.destroy();
        betweenUniforms.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
