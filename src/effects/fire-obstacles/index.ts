import { trackDomRects, type Obstacle, type ObstacleRect } from '../../gpu/dom-rects.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS } from '../../gpu/sim/excitation.ts';
import { createFluid, type Fluid } from '../../gpu/sim/fluid.ts';
import { createAmbientIgnition, createPointerIgnition } from '../../gpu/sim/ignition.ts';
import {
  createObstacleShapes,
  OBSTACLE_CHUNKS,
  OBSTACLE_MAX_SHAPES,
  obstacleDistance,
  shapeFromRect,
  type ObstacleShape,
  type ObstacleShapes,
} from '../../gpu/sim/obstacle-shapes.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect, type EffectInstance } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

// Story 6.8: solid boundaries in the stable-fluids solver (src/gpu/sim/fluid.ts), from the page and
// from signed-distance shapes. A burner below the page puts heat (dye r) and smoke (dye b) into the
// fluid; buoyancy lifts by the heat, and the plume meets the page's marked elements as walls: it
// splits round them, curls over their top edges, and the smoke it carries pools under them.
//
// Where the walls come from: the rounded rectangles of the elements marked `data-ft-obstacle`
// (trackDomRects, in canvas uv) become rounded-box shapes (shapeFromRect), and createObstacleShapes
// draws the shape table into the solver's obstacle mask with one small render pass, only when the
// table changed. A change of layout re-rasterises the mask and touches nothing else: the cells the
// new mask covers lose their gas (the solver holds solid cells at zero), the cells it uncovers are
// born still and clear, and the flow everywhere else carries on. Without a page (tests, the bare
// canvas, a thumbnail) a stand-in set of rectangles takes the page's place, and the `shapes` select
// swaps in analytic test shapes so the flow round a solid can be judged on its own.

const Params = defineUniformStruct('Params', {
  cell: 'f32',
  rim_width: 'f32',
  glow: 'f32',
  heat_scale: 'f32',
  opacity: 'f32',
  rim: 'f32',
});

/** `page` is the marked DOM elements (stand-ins without a page); the rest are SDF test shapes. */
export const SHAPE_SETS = ['page', 'card row', 'circle', 'slanted plate'] as const;
export type ShapeSet = (typeof SHAPE_SETS)[number];
const RESOLUTIONS = ['96', '128', '160', '192'] as const;

/** The burner line, in uv: just above the bottom edge, so it still fits under an element that comes down nearly to it. */
export const BURNER_Y = 0.985;
/** Heat (dye r) per unit of burner level and second, and smoke per unit heat. */
const BURNER_HEAT = 4;
/** Full drive (scroll or sound at its loudest) raises the burner and the ember rate by these shares. */
export const DRIVE_HEAT = 0.6;
export const DRIVE_EMBERS = 1;
/** A pressed pointer adds this much heat a second where it is (times the ignition strength). */
const POINTER_HEAT = 5;
/** One stray ember is a puff of this much heat: a thermal that rises and rolls up on its own. */
const EMBER_HEAT = 0.8;
/** Smoke weighs this much against heat in the buoyancy (dye b against dye r). */
const SMOKE_WEIGHT = 0.05;
/** Seconds of burning run before the first frame, so a still frame is already a picture. */
export const WARM_UP_SECONDS = 2.5;

/**
 * Stand-in elements for a canvas with no marked DOM around it: a heading bar, a wide plate the plume
 * pools under, and a row of three cards over the burner with gaps it rises through. Canvas uv; radii
 * in canvas heights.
 */
export function standInRects(aspect: number): ObstacleRect[] {
  const radius = 0.016;
  if (aspect < 1) {
    return [
      { x: 0.08, y: 0.06, width: 0.6, height: 0.05, radius },
      { x: 0.1, y: 0.24, width: 0.8, height: 0.14, radius },
      { x: 0.08, y: 0.5, width: 0.36, height: 0.12, radius },
      { x: 0.56, y: 0.5, width: 0.36, height: 0.12, radius },
    ];
  }
  return [
    { x: 0.08, y: 0.08, width: 0.42, height: 0.08, radius },
    { x: 0.22, y: 0.28, width: 0.56, height: 0.17, radius },
    { x: 0.1, y: 0.56, width: 0.2, height: 0.16, radius },
    { x: 0.4, y: 0.56, width: 0.2, height: 0.16, radius },
    { x: 0.7, y: 0.56, width: 0.2, height: 0.16, radius },
  ];
}

/** The analytic test shapes, laid out for a canvas of this aspect (width / height). */
export function testShapes(set: Exclude<ShapeSet, 'page'>, aspect: number): ObstacleShape[] {
  switch (set) {
    case 'circle':
      return [{ kind: 'circle', x: 0.5, y: 0.5, size: [0.14, 0.14] }];
    case 'slanted plate':
      // Rising to the right (a negative angle turns it anticlockwise on screen): the gas slides up
      // its underside and spills off the high end.
      return [
        {
          kind: 'rounded-box',
          x: 0.5,
          y: 0.48,
          size: [Math.min(0.32, 0.36 * aspect), 0.022],
          radius: 0.012,
          rotation: -0.3,
        },
      ];
    case 'card row': {
      const width = 0.2;
      return [0.2, 0.5, 0.8].map((x) => ({
        kind: 'rounded-box' as const,
        x,
        y: 0.5,
        size: [(width * aspect) / 2, 0.09] as const,
        radius: 0.018,
      }));
    }
  }
}

/** Page rectangles (with their motion, if the tracker saw them move) as solver shapes. */
export function shapesFromObstacles(
  obstacles: readonly { rect: ObstacleRect; motion?: Obstacle['motion'] }[],
  aspect: number,
): ObstacleShape[] {
  return obstacles
    .slice(0, OBSTACLE_MAX_SHAPES)
    .map((obstacle) => shapeFromRect(obstacle.rect, aspect, obstacle.motion));
}

/**
 * Where the burner's tongues go: about one per 0.1 canvas heights (at least three) across the middle
 * `span` of the width, on the burner line, leaving out any that a solid covers. When solids cover the
 * whole span (an article that runs off the bottom of the canvas), the free places on the rest of the
 * line are used instead, so the fire comes up beside the element rather than vanishing under it.
 * `slot` numbers the places, so a tongue keeps its own clock while others come and go.
 */
export function burnerTongues(
  span: number,
  aspect: number,
  solids: readonly ObstacleShape[],
): { slot: number; x: number; spacing: number }[] {
  const spacing = Math.min(0.1 / aspect, span / 3);
  const reach = Math.floor(0.48 / spacing);
  // Half a cell of the default grid, in image heights: a tongue that close to a solid is under it.
  const margin = 0.008;
  const all: { slot: number; x: number; spacing: number; inSpan: boolean }[] = [];
  for (let j = -reach; j <= reach; j++) {
    const x = 0.5 + j * spacing;
    if (solids.some((shape) => obstacleDistance(shape, x, BURNER_Y, aspect) < margin)) continue;
    all.push({ slot: j + reach, x, spacing, inSpan: Math.abs(x - 0.5) <= span / 2 + 1e-6 });
  }
  const inside = all.filter((tongue) => tongue.inSpan);
  return (inside.length > 0 ? inside : all).map(({ slot, x }) => ({ slot, x, spacing }));
}

/** The running effect, with its solver exposed for tests. */
export interface FireObstaclesInstance extends EffectInstance {
  readonly fluid: Fluid;
  readonly shapes: ObstacleShapes;
  /** The rectangles in the mask now, when the `page` set is in use (the page's or the stand-ins). */
  readonly rects: readonly ObstacleRect[];
  /** True while the stand-in rectangles stand for a missing page. */
  readonly demo: boolean;
  /**
   * Replaces what the page reports (for tests and tools without a DOM): these rectangles are used as
   * if the tracker had measured them. `null` goes back to the page, or to the stand-ins.
   */
  layout(rects: readonly ObstacleRect[] | null): void;
}

export const effect = defineEffect({
  meta,
  params: {
    shapes: { type: 'select', default: 'page', options: SHAPE_SETS, label: 'solids' },
    burner: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'burner' },
    burnerWidth: {
      type: 'number',
      default: 0.7,
      min: 0.1,
      max: 1,
      step: 0.01,
      label: 'burner width',
    },
    buoyancy: { type: 'number', default: 2.4, min: 0, max: 4, step: 0.01 },
    cooling: {
      type: 'number',
      default: 0.6,
      min: 0.1,
      max: 5,
      step: 0.01,
      label: 'cooling (1 / s)',
    },
    smoke: { type: 'number', default: 0.8, min: 0, max: 2, step: 0.01, label: 'smoke per heat' },
    smokeFade: {
      type: 'number',
      default: 0.2,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'smoke fade (1 / s)',
    },
    vorticity: {
      type: 'number',
      default: 4,
      min: 0,
      max: 20,
      step: 0.5,
      label: 'vorticity confinement (1 / s)',
    },
    damping: {
      type: 'number',
      default: 0.6,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'velocity damping (1 / s)',
    },
    embers: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, label: 'embers / s' },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    opacity: { type: 'number', default: 2.4, min: 0, max: 6, step: 0.05, label: 'smoke opacity' },
    rim: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'firelight on solids' },
    resolution: {
      type: 'select',
      default: '128',
      options: RESOLUTIONS,
      label: 'velocity cells (long side)',
    },
    onTop: { type: 'boolean', default: true, label: 'canvas above content' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    burner: {},
    // Cooler, smokier gas that lingers: the smoke pools under the overhangs and spills round them.
    'smoke pools': {
      burner: 0.8,
      cooling: 1.6,
      smoke: 1.3,
      smokeFade: 0.08,
      buoyancy: 1.4,
      vorticity: 3,
      opacity: 2.4,
    },
    // No burner: stray embers under the page, each a puff of heat that finds its way round the solids.
    'embers only': { burner: 0, embers: 3, cooling: 0.7, smoke: 0.7, glow: 1.2 },
    'card row': { shapes: 'card row' },
    'round obstacle': { shapes: 'circle', burnerWidth: 0.3, burner: 1.3 },
    'slanted plate': { shapes: 'slanted plate', burnerWidth: 0.4, burner: 1.2 },
  },

  async create({ device, format, hdr, canvas, params, profiler }): Promise<FireObstaclesInstance> {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-obstacles' });
    const uniforms = createUniformBuffer(device, Params, 'fire-obstacles params');
    const sampler = device.createSampler({
      label: 'fire-obstacles sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { ...OBSTACLE_CHUNKS, 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });

    let width = Math.max(1, canvas.width || 16);
    let height = Math.max(1, canvas.height || 9);
    /** The aspect the grids were last made for; they follow the canvas only when it changes a lot. */
    let simAspect = width / height;
    const cells = () => Number(params.resolution) || 128;

    const fluid: Fluid = createFluid({
      device,
      resolution: cells(),
      dyeResolution: Math.min(1024, cells() * 4),
      width,
      height,
      params: { boundary: 'open', velocityScheme: 'maccormack', dyeScheme: 'maccormack' },
      profiler,
      label: 'fire-obstacles',
    });
    const shapes = createObstacleShapes({ device, fluid, profiler, label: 'fire-obstacles' });
    // Only moving elements push the gas; the drive pass is installed while one is moving.
    shapes.drive.maxSpeed = 1.5;
    shapes.drive.band = 2;

    // Where the page's marked elements are. Inert without a DOM. Movement under a quarter of a cell
    // is not a change, so sub-cell drift costs no re-rasterising.
    const domOptions = { epsilon: 1e-4 };
    const dom = trackDomRects(canvas, domOptions);
    let override: readonly ObstacleRect[] | null = null;
    let rects: readonly ObstacleRect[] = [];
    let demo = true;
    let shapesKey = '';
    let moving = false;

    const pointer = createPointerIgnition(canvas, { radius: 0.04 });
    const embers = createAmbientIgnition({
      rate: params.embers,
      radius: 0.045,
      region: [0.06, 0.55, 0.94, 0.97],
      seed: 61,
    });
    let drive = createExcitation(params.drive, canvas);

    // The mock pages put the canvas behind their content, and a real page may too. Fire round an
    // element has to be drawn over the page (the element's own pixels are left alone: inside a solid
    // only firelight on its edge is drawn), so the canvas is raised above its siblings while real
    // elements are the solids. This is the one thing the effect changes outside its own pixels.
    const style = canvas.style as Partial<CSSStyleDeclaration> | undefined;
    const before = { position: style?.position ?? '', zIndex: style?.zIndex ?? '' };
    let raised = false;
    const raise = (on: boolean) => {
      if (!style || on === raised) return;
      style.position = on ? 'relative' : before.position;
      style.zIndex = on ? '5' : before.zIndex;
      raised = on;
    };

    let clock = 0;
    let warmed = -1;
    const groups = new Map<string, GPUBindGroup>();
    let groupGeneration = -1;

    function displayGroup(): GPUBindGroup {
      if (groupGeneration !== fluid.generation) {
        groups.clear();
        groupGeneration = fluid.generation;
      }
      const key = `${fluid.dye.slot}`;
      let group = groups.get(key);
      if (!group) {
        group = device.createBindGroup({
          label: 'fire-obstacles display',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: fluid.dye.view },
            { binding: 2, resource: sampler },
            { binding: 3, resource: fluid.obstacles.view },
            { binding: 4, resource: { buffer: shapes.table } },
          ],
        });
        groups.set(key, group);
      }
      return group;
    }

    function sync() {
      const p = fluid.params;
      p.vorticity = params.vorticity;
      p.velocityDissipation = params.damping;
      p.buoyancy = params.buoyancy;
      p.buoyancyWeights = [1, 0, -SMOKE_WEIGHT, 0];
      p.dyeDissipation = [params.cooling, 0, params.smokeFade, 0];
      fluid.setResolution(cells(), Math.min(1024, cells() * 4));
    }

    /** Reads the page (or the override, or the stand-ins) and updates the shape table if it changed. */
    function layoutSolids(delta: number) {
      const aspect = fluid.grid.aspect;
      domOptions.epsilon = 0.25 / Math.max(fluid.grid.width, fluid.grid.height);
      const page = dom.update(delta);
      const set = params.shapes as ShapeSet;
      if (set !== 'page') {
        raise(false);
        const key = `${set}:${aspect.toFixed(4)}`;
        if (key !== shapesKey) {
          shapesKey = key;
          rects = [];
          demo = false;
          moving = false;
          shapes.set(testShapes(set, aspect));
        }
        return;
      }
      const source = override ? 'override' : page.rects.length > 0 ? 'dom' : 'demo';
      const key = `${source}:${aspect.toFixed(4)}`;
      const anyMotion = source === 'dom' && page.obstacles.some((o) => o.motion !== undefined);
      // A moving element is re-sent every frame (its velocity is in the table), and once more when it
      // stops, so the drive pass does not keep pushing with a stale velocity.
      if (key !== shapesKey || (source === 'dom' && (page.changed || anyMotion || moving))) {
        shapesKey = key;
        demo = source === 'demo';
        if (source === 'override') {
          rects = override!;
          shapes.set(
            shapesFromObstacles(
              rects.map((rect) => ({ rect })),
              aspect,
            ),
          );
        } else if (source === 'dom') {
          rects = page.rects;
          shapes.set(shapesFromObstacles(page.obstacles, aspect));
        } else {
          rects = standInRects(width / height);
          shapes.set(
            shapesFromObstacles(
              rects.map((rect) => ({ rect })),
              aspect,
            ),
          );
        }
        moving = anyMotion;
      }
      raise(params.onTop && source === 'dom');
      if (moving) shapes.attach();
      else shapes.detach();
    }

    /** The burner: tongues of heat and smoke along a line, each breathing on its own slow clock. */
    function feed(delta: number, level: number) {
      const strength = Math.max(0, params.burner) * (1 + DRIVE_HEAT * level);
      if (strength <= 0 || delta <= 0) return;
      const span = Math.min(1, Math.max(0.05, params.burnerWidth));
      const aspect = fluid.grid.aspect;
      for (const { slot, x: x0, spacing } of burnerTongues(span, aspect, shapes.shapes)) {
        const phase = clock * (0.8 + 0.19 * (slot % 5)) + slot * 2.3;
        const breathe = 0.55 + 0.45 * Math.sin(phase);
        // Each tongue wanders by up to a third of the spacing, slowly, so the columns never line up.
        const x =
          x0 +
          0.33 * spacing * Math.sin(clock * (0.11 + 0.023 * slot) + 1.7 * slot) +
          (0.01 / aspect) * Math.sin(phase * 1.3);
        const at: [number, number] = [x, BURNER_Y + 0.008 * Math.cos(phase)];
        const amount = strength * breathe * delta;
        fluid.addDye(at, at, 0.028, [BURNER_HEAT * amount, 0, params.smoke * amount, 0]);
        fluid.addForce(at, at, 0.03, [0.05 * Math.sin(phase * 0.7) * delta, -0.35 * amount]);
      }
      // A slow side wind that comes and goes, so the plume leans and the curls change sides.
      const gust = Math.sin(clock * 0.27) * Math.sin(clock * 0.13 + 1);
      if (Math.abs(gust) > 0.25) {
        const y = 0.5 + 0.15 * Math.sin(clock * 0.21);
        fluid.addForce([0.1, y], [0.9, y], 0.14, [gust * 0.2 * delta * strength, 0], 0.08);
      }
    }

    /** Pointer heat (a rate, while pressed) and stray embers (a puff each). */
    function ignite(delta: number, level: number, withPointer = true) {
      embers.rate = Math.max(0, params.embers) * (1 + DRIVE_EMBERS * level);
      for (const ig of withPointer ? pointer.collect(delta) : []) {
        const heat = POINTER_HEAT * ig.strength * delta;
        fluid.addDye([ig.fromX, ig.fromY], [ig.toX, ig.toY], ig.radius * 0.7, [
          heat,
          0,
          heat * Math.max(0.2, params.smoke),
          0,
        ]);
      }
      for (const ig of embers.collect(delta)) {
        const at: [number, number] = [ig.fromX, ig.fromY];
        const heat = EMBER_HEAT * ig.strength;
        fluid.addDye(at, at, ig.radius, [heat, 0, heat * params.smoke * 0.6, 0]);
      }
    }

    /*
     * Runs the fire for a while before the first frame (and after the grids are re-created), in
     * command buffers of its own, one step each: queued splats go through one buffer, so steps
     * that each need their own splats cannot share a submit.
     */
    function warmUp() {
      const steps = Math.round(WARM_UP_SECONDS / fluid.stepSeconds);
      for (let k = 0; k < steps; k++) {
        const encoder = device.createCommandEncoder({ label: 'fire-obstacles warm-up' });
        shapes.rasterize(encoder);
        clock += fluid.stepSeconds;
        ignite(fluid.stepSeconds, 0, false);
        feed(fluid.stepSeconds, 0);
        fluid.advance(encoder, 1);
        device.queue.submit([encoder.finish()]);
      }
    }

    return {
      get fluid() {
        return fluid;
      },
      shapes,
      get rects() {
        return rects;
      },
      get demo() {
        return demo;
      },
      layout(next) {
        override = next ? next.map((rect) => ({ ...rect })) : null;
        shapesKey = '';
      },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        tail.resize(width, height);
        // A small change of shape stretches the fluid rather than wiping it.
        const aspect = width / height;
        if (Math.abs(Math.log(aspect / simAspect)) > 0.06) {
          simAspect = aspect;
          fluid.resize(width, height);
        }
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        sync();
        layoutSolids(delta);
        if (warmed !== fluid.generation) {
          warmed = fluid.generation;
          warmUp();
        }
        if (params.drive !== drive.kind) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        clock += delta;
        shapes.rasterize(encoder);
        ignite(delta, level);
        feed(delta, level);
        fluid.update(encoder, delta);

        const grid = fluid.grid;
        uniforms.set({
          cell: grid.cellSize,
          rim_width: Math.max(2 / height, 0.35 * grid.cellSize),
          glow: params.glow,
          heat_scale: 0.9,
          opacity: params.opacity,
          rim: params.rim,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup()], {
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
        shapes.destroy();
        fluid.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
