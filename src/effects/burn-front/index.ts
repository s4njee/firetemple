import type { ObstacleRect } from '../../gpu/dom-rects.ts';
import { getNoiseTexture, NOISE_TEXTURE_SIZE } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { linearSampler } from '../../gpu/passes/common.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import {
  burnGridSize,
  createBurnSim,
  type BurnSettings,
  type BurnSim,
} from '../../gpu/sim/burn.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import {
  createAmbientIgnition,
  createPointerIgnition,
  type IgnitionSource,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  paper: 'vec3f',
  aspect: 'f32',
  cell: 'vec2f',
  pixel: 'f32',
  glow: 'f32',
  fibre: 'f32',
  pattern: 'f32',
  lod: 'f32',
});

/** What is on the sheet; the index is `PATTERN_*` in scene.wgsl. */
const PATTERNS = ['plain', 'ruled', 'print'] as const;
/** Where stray embers land, and so where the fire starts. */
const ORIGINS = ['anywhere', 'centre', 'bottom edge'] as const;
type Origin = (typeof ORIGINS)[number];

/** Noise cells per canvas height in scene.wgsl (`ROUGH_SCALE`), for the mip level it reads. */
const ROUGH_SCALE = 14;
/** Texels of the noise tile per noise cell. */
const TEXELS_PER_CELL = NOISE_TEXTURE_SIZE / 8;
/** Full drive (scroll or sound at its loudest) raises the ember rate and the speed by these shares. */
export const DRIVE_EMBERS = 1;
export const DRIVE_SPEED = 0.5;
/** The first spark lands this long after the effect starts, so it is never a still sheet for long. */
const OPENING_SECONDS = 0.3;

/** Where embers may land for an origin, in canvas uv: [x0, y0, x1, y1]. */
export function emberRegion(origin: string, margin: number): [number, number, number, number] {
  const inset = Math.min(0.4, Math.max(0, margin)) + 0.04;
  if ((origin as Origin) === 'centre') return [0.48, 0.46, 0.52, 0.54];
  if ((origin as Origin) === 'bottom edge') return [inset, 0.97 - inset, 1 - inset, 0.99 - inset];
  return [inset, inset, 1 - inset, 1 - inset];
}

/** One igniter, `delay` seconds after the first call, wherever `at` says. */
function createOpeningSpark(at: () => [number, number], radius: () => number): IgnitionSource {
  let wait = OPENING_SECONDS;
  let fired = false;
  return {
    collect(dt) {
      if (fired) return [];
      wait -= dt;
      if (wait > 0) return [];
      fired = true;
      const [x, y] = at();
      return [{ fromX: x, fromY: y, toX: x, toY: y, radius: radius(), strength: 1 }];
    },
    destroy() {},
  };
}

/** The running effect, with its solver exposed for tests. */
export interface BurnFrontInstance extends EffectInstance {
  readonly sim: BurnSim;
}

export const effect = defineEffect({
  meta,
  params: {
    speed: { type: 'number', default: 0.045, min: 0.005, max: 0.3, step: 0.005 },
    irregular: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    grain: { type: 'number', default: 5, min: 1, max: 16, step: 0.5, label: 'grain (cells)' },
    climb: { type: 'number', default: 1, min: 0.5, max: 3, step: 0.05 },
    burnTime: { type: 'number', default: 0.45, min: 0.1, max: 2, step: 0.01, label: 'burn time' },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    crumble: { type: 'number', default: 2.2, min: 0.1, max: 10, step: 0.1, label: 'crumble (s)' },
    ash: { type: 'boolean', default: false, label: 'leave ash' },
    regrow: { type: 'number', default: 6, min: 0.5, max: 60, step: 0.5, label: 'regrow (s)' },
    embers: { type: 'number', default: 0.15, min: 0, max: 2, step: 0.01, label: 'embers / s' },
    origin: { type: 'select', default: 'anywhere', options: ORIGINS },
    margin: { type: 'number', default: 0, min: 0, max: 0.25, step: 0.005 },
    paper: { type: 'color', default: [0.66, 0.55, 0.37] },
    pattern: { type: 'select', default: 'print', options: PATTERNS },
    fibre: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    resolution: { type: 'number', default: 256, min: 64, max: 512, step: 16 },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'slow paper': {
      speed: 0.03,
      irregular: 0.75,
      burnTime: 0.7,
      crumble: 3,
      embers: 0.1,
      origin: 'anywhere',
      climb: 1,
      ash: false,
    },
    'flash paper': {
      speed: 0.2,
      irregular: 0.35,
      grain: 8,
      burnTime: 0.2,
      crumble: 0.3,
      regrow: 3,
      embers: 0.5,
      origin: 'anywhere',
      climb: 1,
      ash: false,
      pattern: 'plain',
    },
    hole: {
      speed: 0.05,
      irregular: 0.8,
      grain: 6,
      burnTime: 0.5,
      crumble: 1.2,
      embers: 0.4,
      origin: 'centre',
      climb: 1,
      ash: false,
    },
    'from below': {
      speed: 0.035,
      climb: 2,
      irregular: 0.6,
      burnTime: 0.6,
      crumble: 2,
      embers: 0.3,
      origin: 'bottom edge',
      ash: false,
      pattern: 'ruled',
    },
    ash: { ash: true, speed: 0.05, embers: 0.2, regrow: 5 },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<BurnFrontInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'burn-front' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'burn-front params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const sim = createBurnSim(device, { label: 'burn-front', grain: params.grain, seed: 3 });

    let canvasWidth = Math.max(1, canvas.width);
    let canvasHeight = Math.max(1, canvas.height);
    sim.resize(...burnGridSize(canvasWidth, canvasHeight, params.resolution));

    // Story 5.2: tap or drag to light the paper. Story 5.7: stray embers relight it once it has
    // regrown, so the sheet burns again and again with nobody there.
    const pointer = createPointerIgnition(canvas);
    const embers = createAmbientIgnition({ rate: params.embers, seed: 11 });
    const opening = createOpeningSpark(
      () => {
        const [x0, y0, x1, y1] = embers.region;
        // A fixed spot off the centre of the region: the same first frame every time.
        return [x0 + (x1 - x0) * 0.36, y0 + (y1 - y0) * 0.6];
      },
      () => embers.radius,
    );
    // Story 5.8: a 0..1 level from the page's scrolling or from sound.
    let drive = createExcitation(params.drive, canvas);

    // The sheet: the whole canvas, or inset by `margin` (of the shorter side) with soft corners.
    let sheetKey = '';
    const layoutSheet = () => {
      const margin = Math.min(0.4, Math.max(0, params.margin));
      const key = `${margin}:${canvasWidth}:${canvasHeight}`;
      if (key === sheetKey) return;
      sheetKey = key;
      const aspect = canvasWidth / canvasHeight;
      const short = Math.min(1, aspect);
      const mx = (margin * short) / aspect;
      const my = margin * short;
      const sheet: ObstacleRect = {
        // With no margin the sheet runs past the canvas, so its edge is never drawn.
        x: margin > 0 ? mx : -0.5,
        y: margin > 0 ? my : -0.5,
        width: margin > 0 ? 1 - 2 * mx : 2,
        height: margin > 0 ? 1 - 2 * my : 2,
        radius: margin > 0 ? 0.012 : 0,
      };
      sim.setRects([sheet]);
    };

    // The state ping-pongs every step: one bind group per texture it can be read from.
    let groups = new Map<GPUTextureView, GPUBindGroup>();
    let groupsGeneration = -1;
    const displayGroup = (): GPUBindGroup => {
      if (groupsGeneration !== sim.generation) {
        groups = new Map();
        groupsGeneration = sim.generation;
      }
      const view = sim.state.view;
      let group = groups.get(view);
      if (!group) {
        group = device.createBindGroup({
          label: 'burn-front display',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: view },
            { binding: 2, resource: sim.map.view },
            { binding: 3, resource: linearSampler(device) },
            { binding: 4, resource: noise.view },
            { binding: 5, resource: noise.sampler },
          ],
        });
        groups.set(view, group);
      }
      return group;
    };

    return {
      sim,
      resize(width, height) {
        canvasWidth = Math.max(1, width);
        canvasHeight = Math.max(1, height);
        tail.resize(width, height);
      },
      frame(time, encoder, target) {
        // The grid follows the `resolution` parameter and the canvas shape, not its size.
        sim.resize(...burnGridSize(canvasWidth, canvasHeight, params.resolution));
        sim.setGrain(params.grain);
        layoutSheet();

        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        // The drive adds a share of the calm ember rate and speed. It never touches the clock.
        const level = drive.update(time.delta);

        // A touch has to reach the centre of at least one cell, however coarse the grid.
        const reach = 4 * sim.cell;
        pointer.radius = Math.max(0.035, reach);
        embers.radius = Math.max(0.024, reach);
        embers.rate = Math.max(0, params.embers) * (1 + DRIVE_EMBERS * level);
        embers.region = emberRegion(params.origin, params.margin);

        const settings: BurnSettings = {
          speed: params.speed * (1 + DRIVE_SPEED * level),
          climb: params.climb,
          irregular: params.irregular,
          burnTime: params.burnTime,
          glow: 0.2,
          crumble: params.ash ? 0 : params.crumble,
          regrowth: 'all burnt',
          regrow: params.regrow,
          regrowFade: 1.5,
        };
        sim.advance(encoder, time.delta, settings, [pointer, opening, embers], profiler);

        const cellsPerPixel = (ROUGH_SCALE * TEXELS_PER_CELL) / canvasHeight;
        uniforms.set({
          paper: params.paper,
          aspect: canvasWidth / canvasHeight,
          cell: [1 / sim.width, 1 / sim.height],
          pixel: 1 / canvasHeight,
          glow: params.glow,
          fibre: params.fibre,
          pattern: Math.max(0, PATTERNS.indexOf(params.pattern as (typeof PATTERNS)[number])),
          // The mip level at which one texel of the noise tile covers about one pixel.
          lod: Math.max(0, Math.log2(cellsPerPixel)),
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup()], {
          timestampWrites: profiler.pass('paper'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        pointer.destroy();
        embers.destroy();
        opening.destroy();
        drive.destroy();
        sim.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
