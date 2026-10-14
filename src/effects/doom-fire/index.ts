import { createRampTexture } from '../../gpu/emission/ramp-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createFixedStepper, type FixedStepper } from '../../gpu/loop.ts';
import { linearSampler } from '../../gpu/passes/common.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import {
  createDoomFire,
  DOOM_BACKENDS,
  DOOM_HEAT_MAX,
  DOOM_MAX_STEPS,
  type DoomFire,
  type DoomInput,
} from '../../gpu/sim/doom.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import {
  collectIgniters,
  createAmbientIgnition,
  createPointerIgnition,
  type Igniter,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import shader from './display.wgsl';
import { meta } from './meta.ts';
import { DOOM_LEVELS, doomRamp } from './palette.ts';

const Params = defineUniformStruct('Params', {
  blend: 'f32',
  intensity: 'f32',
  palette: 'f32',
  pixelated: 'f32',
});

/** The index is `PALETTE_*` in display.wgsl. */
const PALETTES = ['fire', 'doom', 'gas'] as const;

/** Most cells along the longer side of the canvas, however wide a band it is. */
const MAX_LONG_SIDE = 1024;
/** Full drive (scroll or sound at its loudest) raises the base fuel by this share of itself. */
export const DRIVE_SHARE = 0.5;
/** Lumps of fuel drift this many lumps a second along the base. */
const DRIFT_PER_SECOND = 0.45;
const DRIFT_PERIOD = 1024;
/** How long a gust lasts, and how many cells a step the gust field climbs. */
const GUST_SECONDS = 1.3;
const GUST_CLIMB = 0.25;
/** Flames are never taller than this share of the canvas width. */
const MAX_TALL = 0.8;
/** Most steps run before the first frame, so the first frame is already a fire. */
const MAX_WARM_STEPS = 480;

/**
 * The grid for a canvas: `resolution` cells along its shorter side and as many square cells as
 * fit along the longer one, in whole compute workgroups (8) so a resize rarely changes it.
 */
export function doomGrid(width: number, height: number, resolution: number): [number, number] {
  const short = Math.min(512, Math.max(16, Math.round(resolution / 8) * 8));
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const aspect = Math.max(w, h) / Math.min(w, h);
  const long = Math.min(MAX_LONG_SIDE, Math.max(short, Math.round((short * aspect) / 8) * 8));
  return w >= h ? [long, short] : [short, long];
}

/** Heat of the base row: the calm level, raised by a share of itself as the drive level rises. */
export function baseFuel(fuel: number, level: number): number {
  const calm = Math.min(Math.max(fuel, 0), 1);
  return Math.min(DOOM_HEAT_MAX, calm * (1 + DRIVE_SHARE * Math.min(Math.max(level, 0), 1)));
}

/**
 * What every preset starts from: the default look, written out so that choosing a preset after
 * another one puts back whatever the other changed (`burnt out`, then `hearth`, relights the fire).
 */
const LOOK = {
  backend: 'render',
  resolution: 192,
  rate: 45,
  height: 0.55,
  fuel: 0.9,
  uneven: 0.45,
  embers: 0.4,
  brush: 0.035,
  drive: 'none',
  wind: 0,
  sway: 1.2,
  patchy: 0.6,
  spread: 1,
  grain: 0.25,
  lift: 0.5,
  palette: 'fire',
  pixelated: false,
  bloom: 0.6,
} as const;

/** The running effect, with its solver exposed for tests and for anything that wants the heat. */
export interface DoomFireInstance extends EffectInstance {
  readonly fire: DoomFire;
}

export const effect = defineEffect({
  meta,
  params: {
    backend: { type: 'select', default: LOOK.backend, options: DOOM_BACKENDS },
    resolution: { type: 'number', default: LOOK.resolution, min: 48, max: 256, step: 8 },
    rate: {
      type: 'number',
      default: LOOK.rate,
      min: 5,
      max: 60,
      step: 1,
      label: 'steps per second',
    },
    height: { type: 'number', default: LOOK.height, min: 0.1, max: 1.2, step: 0.01 },
    fuel: { type: 'number', default: LOOK.fuel, min: 0, max: 1, step: 0.01 },
    uneven: {
      type: 'number',
      default: LOOK.uneven,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'uneven fuel',
    },
    embers: {
      type: 'number',
      default: LOOK.embers,
      min: 0,
      max: 4,
      step: 0.05,
      label: 'embers per second',
    },
    brush: { type: 'number', default: LOOK.brush, min: 0.01, max: 0.12, step: 0.005 },
    drive: { type: 'select', default: LOOK.drive, options: EXCITATIONS },
    wind: { type: 'number', default: LOOK.wind, min: -1, max: 1, step: 0.01 },
    sway: { type: 'number', default: LOOK.sway, min: 0, max: 3, step: 0.05 },
    patchy: { type: 'number', default: LOOK.patchy, min: 0, max: 1, step: 0.01 },
    spread: { type: 'number', default: LOOK.spread, min: 1, max: 6, step: 1 },
    grain: { type: 'number', default: LOOK.grain, min: 0, max: 1, step: 0.01 },
    lift: { type: 'number', default: LOOK.lift, min: 0, max: 1, step: 0.01 },
    palette: { type: 'select', default: LOOK.palette, options: PALETTES },
    pixelated: { type: 'boolean', default: LOOK.pixelated },
    intensity: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    hearth: { ...LOOK },
    // The look of the original: a flat row of fuel, 37 colours, square cells and the coin-toss
    // speckle, at under half its full strength and 24 steps a second. At full strength and 30
    // steps a second it is the original's rule, and it measures far over the flash threshold.
    'classic doom': {
      ...LOOK,
      resolution: 96,
      rate: 24,
      height: 0.6,
      fuel: 1,
      uneven: 0,
      embers: 0,
      sway: 0.6,
      patchy: 0.4,
      spread: 3,
      grain: 0.4,
      palette: 'doom',
      pixelated: true,
      bloom: 0.35,
    },
    footer: { ...LOOK, height: 0.3, fuel: 0.8, uneven: 0.6, embers: 0.2, rate: 36, sway: 0.9 },
    // Story 5.2: a bed of coals to draw fire over. Drawn fire is hotter than the bed, so it
    // climbs far above it.
    'draw with the pointer': { ...LOOK, height: 0.85, fuel: 0.22, uneven: 0.3, brush: 0.05 },
    // Story 5.7: no fuel at all, so only stray embers burn; `hearth` relights it.
    'burnt out': { ...LOOK, fuel: 0, embers: 2.5 },
    // Story 5.8: a lower fire that the page's scrolling feeds; it flares while the visitor
    // scrolls and settles when they stop.
    'fed by scrolling': { ...LOOK, drive: 'scroll', fuel: 0.6, height: 0.6 },
    'gas blue': { ...LOOK, palette: 'gas', height: 0.45, uneven: 0.25, embers: 0, sway: 0.8 },
    // The same fire stepped by the compute pass, for the comparison of story 5.1.
    'compute backend': { ...LOOK, backend: 'compute' },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<DoomFireInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'doom-fire' });
    const uniforms = createUniformBuffer(device, Params, 'doom-fire params');
    const palette = createRampTexture(device, doomRamp, {
      width: DOOM_LEVELS,
      label: 'doom-fire palette',
    });
    const paletteView = palette.createView();
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });

    let canvasWidth = Math.max(1, canvas.width);
    let canvasHeight = Math.max(1, canvas.height);
    const [columns, rows] = doomGrid(canvasWidth, canvasHeight, params.resolution);
    const fire = createDoomFire(device, {
      width: columns,
      height: rows,
      backend: params.backend === 'compute' ? 'compute' : 'render',
      label: 'doom-fire',
    });

    // Story 5.2: taps, drags and several fingers. Story 5.7: stray embers.
    const pointer = createPointerIgnition(canvas, { radius: params.brush });
    const embers = createAmbientIgnition({ rate: params.embers, radius: 0.022, seed: 7 });
    // Story 5.8: a 0..1 level from the page's scrolling or from sound.
    let drive = createExcitation(params.drive, canvas);

    let stepper: FixedStepper | undefined;
    let stepperRate = 0;
    let drift = 0;
    let climb = 0;
    let warmed = false;

    // The display reads whichever state is newest; one bind group per arrangement of the two.
    let displayGroups = new Map<string, GPUBindGroup>();
    let displayGeneration = fire.generation;
    const displayGroup = (): GPUBindGroup => {
      if (displayGeneration !== fire.generation) {
        displayGroups = new Map();
        displayGeneration = fire.generation;
      }
      const key = fire.current.label;
      let group = displayGroups.get(key);
      if (!group) {
        group = device.createBindGroup({
          label: `doom-fire display ${key}`,
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: fire.current.view },
            { binding: 2, resource: fire.previous.view },
            { binding: 3, resource: linearSampler(device) },
            { binding: 4, resource: paletteView },
          ],
        });
        displayGroups.set(key, group);
      }
      return group;
    };

    // `height` is a share of the canvas height, but no taller than 0.8 of its width: on a phone
    // held upright the flames stay a fire along the bottom, not a column filling the screen.
    const reachOf = (height: number) =>
      Math.min(height, (MAX_TALL * fire.width) / Math.max(1, fire.height));

    const input = (level: number, igniters: readonly Igniter[]): DoomInput => ({
      fuel: baseFuel(params.fuel, level),
      reach: reachOf(params.height),
      spread: params.spread,
      wind: params.wind,
      uneven: params.uneven,
      sway: params.sway,
      patchy: params.patchy,
      grain: params.grain,
      lift: params.lift,
      gustBeat: stepperRate * GUST_SECONDS,
      gustClimb: climb,
      drift,
      igniters,
      aspect: canvasWidth / canvasHeight,
    });

    return {
      fire,
      resize(width, height) {
        canvasWidth = Math.max(1, width);
        canvasHeight = Math.max(1, height);
        tail.resize(width, height);
      },
      frame(time, encoder, target) {
        // The grid follows the `resolution` parameter and the canvas shape, never its size.
        fire.resize(...doomGrid(canvasWidth, canvasHeight, params.resolution));
        fire.backend = params.backend === 'compute' ? 'compute' : 'render';

        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(time.delta);

        const rate = Math.min(Math.max(params.rate, 1), 120);
        if (!stepper || rate !== stepperRate) {
          stepper = createFixedStepper(1 / rate, { maxSteps: DOOM_MAX_STEPS });
          stepperRate = rate;
        }
        const dt = 1 / rate;

        if (!warmed) {
          // Start as a fire that has been burning, not as a row of coals: the first frame may be
          // the only one (a poster, a thumbnail, reduced motion).
          const climb = Math.ceil(reachOf(params.height) * fire.height * 1.3);
          fire.warm(Math.min(MAX_WARM_STEPS, climb), input(level, []));
          warmed = true;
        }

        pointer.radius = params.brush;
        embers.rate = params.embers;
        // Embers land where the fire lives: the band below its reach, clear of the very base.
        embers.region = [0, Math.max(0, 1 - 0.85 * reachOf(params.height)), 1, 0.97];

        const { steps, alpha } = stepper.advance(time.delta);
        const inputs: DoomInput[] = [];
        for (let index = 0; index < steps; index++) {
          drift = (drift + dt * DRIFT_PER_SECOND) % DRIFT_PERIOD;
          climb += GUST_CLIMB;
          inputs.push(input(level, collectIgniters(dt, pointer, embers)));
        }
        if (inputs.length > 0) fire.advance(encoder, inputs, profiler.pass('step'));

        uniforms.set({
          blend: alpha,
          intensity: params.intensity,
          palette: Math.max(0, PALETTES.indexOf(params.palette as (typeof PALETTES)[number])),
          pixelated: params.pixelated ? 1 : 0,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup()], {
          timestampWrites: profiler.pass('display'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        fire.destroy();
        palette.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
