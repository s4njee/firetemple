import { trackDomRects, type ObstacleRect } from '../../gpu/dom-rects.ts';
import { getNoiseTexture, NOISE_TEXTURE_SIZE } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { linearSampler } from '../../gpu/passes/common.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import {
  BURN_MAX_RECTS,
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
import { createPingPongTarget, type PingPongTarget } from '../../gpu/targets.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import licksShader from './licks.wgsl';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  pixel: 'f32',
  reach: 'f32',
  glow: 'f32',
  scorch: 'f32',
  demo: 'f32',
});

const Licks = defineUniformStruct('Licks', {
  cell: 'vec2f',
  aspect: 'f32',
  scale: 'f32',
  rise: 'f32',
  reach: 'f32',
  lod: 'f32',
});

/** Noise cells per canvas height for the flames. */
const LICK_SCALE = 9;
/** Height (canvas heights) over which a flame cools to 1/e, at flames = 1 and average noise. */
export const LICK_HEIGHT = 0.04;
/** Beyond this many of those heights above an element a flame is too cool to draw. */
const LICK_VISIBLE = 4.5;
/** Noise cells the flame pattern climbs per second: about one, which the flash analyser tolerates. */
const RISE_PER_SECOND = 1.1;
/** The climb wraps at a whole number of tiles (8 cells), so there is no seam. */
const RISE_PERIOD = 4000;
const TEXELS_PER_CELL = NOISE_TEXTURE_SIZE / 8;
/** Full drive (scroll or sound at its loudest) raises the ember rate and the speed by these shares. */
export const DRIVE_EMBERS = 1;
export const DRIVE_SPEED = 0.5;
/** The first spark lands this long after the effect starts. */
const OPENING_SECONDS = 0.35;

/**
 * Stand-in elements for a canvas with no marked DOM around it (tests, the bare canvas, a
 * gallery thumbnail): a bar across the top, a tall card, a wide card, and a row of three small
 * ones with narrow gaps the fire can jump. Canvas uv; radii in canvas heights.
 */
export function demoRects(aspect: number): ObstacleRect[] {
  const wide = aspect >= 1;
  const radius = 0.018;
  if (!wide) {
    return [
      { x: 0.06, y: 0.04, width: 0.88, height: 0.07, radius },
      { x: 0.06, y: 0.17, width: 0.88, height: 0.3, radius },
      { x: 0.06, y: 0.5, width: 0.42, height: 0.2, radius },
      { x: 0.52, y: 0.5, width: 0.42, height: 0.2, radius },
      { x: 0.06, y: 0.76, width: 0.88, height: 0.18, radius },
    ];
  }
  return [
    { x: 0.04, y: 0.06, width: 0.92, height: 0.09, radius },
    { x: 0.04, y: 0.25, width: 0.3, height: 0.66, radius },
    { x: 0.4, y: 0.25, width: 0.56, height: 0.3, radius },
    { x: 0.4, y: 0.59, width: 0.17, height: 0.32, radius },
    { x: 0.595, y: 0.59, width: 0.17, height: 0.32, radius },
    { x: 0.79, y: 0.59, width: 0.17, height: 0.32, radius },
  ];
}

/** The box that holds every rectangle, clipped to the canvas: where an ember can do anything. */
export function fuelBounds(rects: readonly ObstacleRect[]): [number, number, number, number] {
  if (rects.length === 0) return [0, 0, 1, 1];
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x);
    y0 = Math.min(y0, rect.y);
    x1 = Math.max(x1, rect.x + rect.width);
    y1 = Math.max(y1, rect.y + rect.height);
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(x0), clamp(y0), clamp(Math.max(x0, x1)), clamp(Math.max(y0, y1))];
}

/** Where the first spark lands: near the foot of the largest rectangle, so the fire has a climb ahead of it. */
export function openingSpot(rects: readonly ObstacleRect[]): [number, number] {
  let best: ObstacleRect | undefined;
  for (const rect of rects) {
    if (!best || rect.width * rect.height > best.width * best.height) best = rect;
  }
  if (!best) return [0.5, 0.5];
  const clamp = (v: number) => Math.min(0.98, Math.max(0.02, v));
  return [clamp(best.x + best.width * 0.3), clamp(best.y + best.height * 0.8)];
}

/** The running effect, with its solver exposed for tests. */
export interface DomFuelInstance extends EffectInstance {
  readonly sim: BurnSim;
  /** The rectangles in the fuel map right now (the page's, or the stand-ins). */
  readonly rects: readonly ObstacleRect[];
  /** True while the stand-in rectangles are in use. */
  readonly demo: boolean;
}

export const effect = defineEffect({
  meta,
  params: {
    speed: { type: 'number', default: 0.06, min: 0.004, max: 0.25, step: 0.002 },
    climb: { type: 'number', default: 1.8, min: 1, max: 3, step: 0.05 },
    irregular: { type: 'number', default: 0.7, min: 0, max: 1.5, step: 0.01 },
    grain: { type: 'number', default: 6, min: 1, max: 16, step: 0.5, label: 'grain (cells)' },
    jump: { type: 'number', default: 28, min: 0, max: 120, step: 1, label: 'jump (px)' },
    burnTime: { type: 'number', default: 0.6, min: 0.1, max: 2.5, step: 0.01, label: 'burn time' },
    flames: { type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    scorch: { type: 'number', default: 0.75, min: 0, max: 1, step: 0.01 },
    scorchFade: {
      type: 'number',
      default: 6,
      min: 0.5,
      max: 30,
      step: 0.5,
      label: 'scorch fade (s)',
    },
    regrow: { type: 'number', default: 8, min: 1, max: 60, step: 0.5, label: 'regrow (s)' },
    embers: { type: 'number', default: 0.35, min: 0, max: 4, step: 0.05, label: 'embers / s' },
    onTop: { type: 'boolean', default: true, label: 'canvas above content' },
    resolution: { type: 'number', default: 256, min: 64, max: 512, step: 16 },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    'slow creep': {
      speed: 0.025,
      climb: 1.5,
      burnTime: 0.9,
      flames: 0.7,
      embers: 0.25,
      regrow: 10,
      jump: 28,
    },
    'fast spread': {
      speed: 0.14,
      climb: 2.2,
      burnTime: 0.4,
      flames: 1.3,
      embers: 0.6,
      regrow: 6,
      jump: 44,
    },
    'embers only': {
      speed: 0.006,
      climb: 1,
      burnTime: 1.6,
      flames: 0.3,
      glow: 1.3,
      embers: 2.5,
      scorchFade: 4,
      regrow: 5,
      jump: 0,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<DomFuelInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'dom-fuel' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'dom-fuel params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const licksUniforms = createUniformBuffer(device, Licks, 'dom-fuel licks');
    const licksPipeline = createFullscreenPipeline(device, {
      fragment: withChunks(licksShader, { 'licks-params.wgsl': Licks.wgsl }),
      format: 'rgba16float',
    });
    const sim = createBurnSim(device, { label: 'dom-fuel', grain: params.grain, seed: 5 });

    let canvasWidth = Math.max(1, canvas.width);
    let canvasHeight = Math.max(1, canvas.height);
    let pixelRatio = 1;
    sim.resize(...burnGridSize(canvasWidth, canvasHeight, params.resolution));

    // Where the page's marked elements are. Inert without a DOM: it then reports no rectangles
    // and the stand-ins are used. Movement smaller than a quarter of a cell is not a change.
    const domOptions = { epsilon: 1e-4 };
    const dom = trackDomRects(canvas, domOptions);
    let rects: readonly ObstacleRect[] = [];
    let demo = true;
    let rectsKey = '';

    const pointer = createPointerIgnition(canvas);
    const embers = createAmbientIgnition({ rate: params.embers, seed: 23 });
    let openingWait = OPENING_SECONDS;
    const opening: IgnitionSource = {
      collect(dt) {
        if (openingWait <= 0 || rects.length === 0) return [];
        openingWait -= dt;
        if (openingWait > 0) return [];
        const [x, y] = openingSpot(rects);
        return [{ fromX: x, fromY: y, toX: x, toY: y, radius: embers.radius, strength: 1 }];
      },
      destroy() {},
    };
    let drive = createExcitation(params.drive, canvas);

    // The mock pages put the canvas behind their content, and a real page may too. Fire on an
    // element has to be drawn over it, so the canvas is raised above its siblings while there
    // are elements to burn. This is the one thing the effect changes outside its own pixels.
    const style = canvas.style as Partial<CSSStyleDeclaration> | undefined;
    const before = { position: style?.position ?? '', zIndex: style?.zIndex ?? '' };
    let raised = false;
    const raise = (on: boolean) => {
      if (!style || on === raised) return;
      style.position = on ? 'relative' : before.position;
      style.zIndex = on ? '5' : before.zIndex;
      raised = on;
    };

    // The flames: one texel per solver cell, re-created (empty) whenever the solver's grid is.
    let licks: PingPongTarget | undefined;
    let wired = -1;
    let groups = new Map<string, GPUBindGroup>();
    const wire = () => {
      if (wired === sim.generation && licks) return licks;
      licks?.destroy();
      licks = createPingPongTarget(device, {
        label: 'dom-fuel licks',
        format: 'rgba16float',
        width: sim.width,
        height: sim.height,
      });
      groups = new Map();
      wired = sim.generation;
      return licks;
    };
    // The state and the flames both ping-pong: one bind group per pair of textures read.
    const group = (kind: 'licks' | 'display', flames: PingPongTarget): GPUBindGroup => {
      const key = `${kind}:${sim.state.label}:${flames.read.label}`;
      let made = groups.get(key);
      if (!made) {
        made =
          kind === 'licks'
            ? device.createBindGroup({
                label: 'dom-fuel licks',
                layout: licksPipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: licksUniforms.buffer } },
                  { binding: 1, resource: sim.state.view },
                  { binding: 2, resource: flames.read.view },
                  { binding: 3, resource: linearSampler(device) },
                  { binding: 4, resource: noise.view },
                  { binding: 5, resource: noise.sampler },
                ],
              })
            : device.createBindGroup({
                label: 'dom-fuel display',
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: uniforms.buffer } },
                  { binding: 1, resource: sim.state.view },
                  { binding: 2, resource: sim.map.view },
                  { binding: 3, resource: linearSampler(device) },
                  { binding: 4, resource: flames.read.view },
                ],
              });
        groups.set(key, made);
      }
      return made;
    };

    let rise = 0;

    return {
      sim,
      get rects() {
        return rects;
      },
      get demo() {
        return demo;
      },
      resize(width, height, dpr) {
        canvasWidth = Math.max(1, width);
        canvasHeight = Math.max(1, height);
        pixelRatio = dpr > 0 ? dpr : 1;
        tail.resize(width, height);
      },
      frame(time, encoder, target) {
        sim.resize(...burnGridSize(canvasWidth, canvasHeight, params.resolution));
        sim.setGrain(params.grain);
        const aspect = canvasWidth / canvasHeight;

        // Read the page before writing anything. The fuel map is redrawn only when a rectangle
        // has moved by a quarter of a cell or more; the state (what is alight, what has burnt)
        // is never touched by a change of layout.
        domOptions.epsilon = 0.25 / Math.max(sim.width, sim.height);
        const page = dom.update(time.delta);
        const useDemo = page.rects.length === 0;
        const key = useDemo ? `demo:${aspect.toFixed(3)}` : 'dom';
        if (page.changed || key !== rectsKey) {
          rects = useDemo ? demoRects(aspect) : page.rects.slice(0, BURN_MAX_RECTS);
          demo = useDemo;
          rectsKey = key;
          sim.setRects(rects);
          embers.region = fuelBounds(rects);
        }
        raise(params.onTop && !demo);

        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(time.delta);

        const reach = 4 * sim.cell;
        pointer.radius = Math.max(0.035, reach);
        embers.radius = Math.max(0.024, reach);
        embers.rate = Math.max(0, params.embers) * (1 + DRIVE_EMBERS * level);

        // The jump is given in CSS pixels, the unit gaps between elements are designed in.
        const jump = (Math.max(0, params.jump) * pixelRatio) / canvasHeight;
        const settings: BurnSettings = {
          speed: params.speed * (1 + DRIVE_SPEED * level),
          climb: params.climb,
          irregular: params.irregular,
          burnTime: params.burnTime,
          glow: 0.25,
          crumble: params.scorchFade,
          jump,
          regrowth: 'each cell',
          regrow: params.regrow,
          regrowFade: 1.5,
        };
        sim.advance(encoder, time.delta, settings, [pointer, opening, embers], profiler);

        // Flames: one small pass a frame, after the steps.
        rise = (rise + time.delta * RISE_PER_SECOND) % RISE_PERIOD;
        const flames = Math.max(0, params.flames);
        const lickHeight = LICK_HEIGHT * flames;
        const flameTarget = wire();
        licksUniforms.set({
          cell: [1 / sim.width, 1 / sim.height],
          aspect,
          scale: LICK_SCALE,
          rise,
          reach: lickHeight,
          // The mip level at which one texel of the noise tile covers about one cell.
          lod: Math.max(0, Math.log2((LICK_SCALE * TEXELS_PER_CELL) / sim.height)),
        });
        licksUniforms.upload();
        renderFullscreen(
          encoder,
          flameTarget.write.view,
          licksPipeline,
          [group('licks', flameTarget)],
          {
            timestampWrites: profiler.pass('licks'),
          },
        );
        flameTarget.swap();

        uniforms.set({
          pixel: 1 / canvasHeight,
          // Beyond this distance from every element nothing can be alight, glowing or scorched.
          reach: jump / 2 + LICK_VISIBLE * lickHeight + 3 * sim.cell,
          glow: params.glow,
          scorch: params.scorch,
          demo: demo ? 1 : 0,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [group('display', flameTarget)], {
          timestampWrites: profiler.pass('fire'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        raise(false);
        dom.destroy();
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        sim.destroy();
        licks?.destroy();
        licksUniforms.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
