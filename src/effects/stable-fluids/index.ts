import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { trackPointers, type MultiPointerTracker } from '../../gpu/pointer.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import {
  createFluid,
  type Fluid,
  type FluidPressureSolver,
  type FluidScheme,
} from '../../gpu/sim/fluid.ts';
import { createFluidStirrer, type FluidStroke } from '../../gpu/sim/fluid-stir.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import shader from './display.wgsl';
import { meta } from './meta.ts';

// Story 6.1's validation scene: the stable-fluids solver ported from Water Temple (src/gpu/sim/fluid.ts),
// shown doing what Epic 6 will ask of it. A smouldering bed at the bottom puts heat (dye r) and smoke
// (dye b) into the fluid; the solver's buoyancy lifts by the heat and weighs down a little by the
// smoke (`buoyancyWeights`), the heat cools and the smoke thins at their own rates (per-channel
// `dyeDissipation`), and the bed's gas expands (a standing divergence source, `expansion`). The pointer
// stirs through fluid-stir.ts: a press lays glowing embers and smoke, a hover pushes and lays smoke.

const Params = defineUniformStruct('Params', {
  bed: 'vec2f',
  grid: 'vec2f',
  aspect: 'f32',
  view: 'f32',
  glow: 'f32',
  heat_scale: 'f32',
  opacity: 'f32',
  bed_light: 'f32',
  debug_gain: 'f32',
});

const SCHEMES = ['maccormack', 'bfecc', 'semi-lagrangian'] as const;
const SOLVERS = ['jacobi', 'sor', 'multigrid'] as const;
const RESOLUTIONS = ['64', '96', '128', '192', '256'] as const;
const VIEWS = ['smoke', 'velocity', 'vorticity', 'pressure', 'divergence'] as const;

/** Where the bed is, in uv: centre and half width. */
const BED: readonly [number, number] = [0.5, 0.86];
const BED_HALF_WIDTH = 0.1;
/** Tongues of heat along the bed, each wandering on its own slow clock. */
const TONGUES = 5;
/** Smoke weighs this much against heat in the buoyancy (dye b against dye r). */
const SMOKE_WEIGHT = 0.05;
/** Radius of the expanding region at the bed, image heights. */
const EXPANSION_RADIUS = 0.08;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The plume the scene starts with, so a still frame (reduced motion, poster) is already a picture. */
function firstPlume(aspect: number) {
  return (x: number, y: number): [number, number, number, number] => {
    const dx = (x - BED[0]) * aspect;
    const rise = BED[1] - y;
    if (rise < -0.04) return [0, 0, 0, 0];
    // A column that widens and wavers as it rises, hot at the bottom and smoky above.
    const sway = 0.03 * Math.sin(rise * 9) * rise * 3;
    const width = 0.05 + 0.18 * Math.max(0, rise);
    const across = Math.exp(-(((dx - sway) / width) ** 2));
    const along = smoothstep(-0.04, 0.03, rise) * (1 - smoothstep(0.55, 0.85, rise));
    const heat = across * Math.exp(-Math.max(0, rise) / 0.08) * 1.4;
    const smoke = across * along * 1.1 * smoothstep(0.0, 0.25, rise);
    return [heat, 0, smoke, 0];
  };
}

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'smoke', options: VIEWS, label: 'diagnostic' },
    scheme: { type: 'select', default: 'maccormack', options: SCHEMES, label: 'advection' },
    vorticity: {
      type: 'number',
      default: 3,
      min: 0,
      max: 40,
      step: 0.5,
      label: 'vorticity confinement (1 / s)',
    },
    damping: {
      type: 'number',
      default: 0.9,
      min: 0,
      max: 4,
      step: 0.01,
      label: 'velocity damping (1 / s)',
    },
    pressureSolver: {
      type: 'select',
      default: 'jacobi',
      options: SOLVERS,
      label: 'pressure solver',
    },
    pressureIterations: {
      type: 'number',
      default: 30,
      min: 4,
      max: 120,
      step: 1,
      label: 'pressure iterations (V-cycles / 10 for multigrid)',
    },
    resolution: {
      type: 'select',
      default: '128',
      options: RESOLUTIONS,
      label: 'velocity cells (long side)',
    },
    source: { type: 'number', default: 1, min: 0, max: 2.5, step: 0.01, label: 'bed strength' },
    buoyancy: { type: 'number', default: 1.6, min: 0, max: 4, step: 0.01 },
    expansion: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 6,
      step: 0.05,
      label: 'gas expansion at the bed (1 / s)',
    },
    cooling: {
      type: 'number',
      default: 0.7,
      min: 0.1,
      max: 5,
      step: 0.01,
      label: 'cooling (1 / s)',
    },
    smokeFade: {
      type: 'number',
      default: 0.25,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'smoke fade (1 / s)',
    },
    opacity: { type: 'number', default: 2.2, min: 0, max: 6, step: 0.05, label: 'smoke opacity' },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    radius: {
      type: 'number',
      default: 0.04,
      min: 0.01,
      max: 0.12,
      step: 0.001,
      label: 'stir radius',
    },
    force: { type: 'number', default: 0.8, min: 0, max: 3, step: 0.01, label: 'stir push' },
    debugGain: {
      type: 'number',
      default: 1,
      min: 0.1,
      max: 10,
      step: 0.1,
      label: 'diagnostic gain',
    },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    smoulder: {},
    // Less heat, more swirl: smoke a visitor pushes around, and confinement keeps the curls tight.
    'stirred smoke': {
      source: 0.5,
      buoyancy: 0.6,
      vorticity: 12,
      damping: 1.2,
      cooling: 2.5,
      smokeFade: 0.12,
      expansion: 0,
      radius: 0.05,
      force: 1.1,
    },
    // What MacCormack and vorticity confinement add: switch them off and the plume goes soft.
    'semi-Lagrangian, no confinement': { scheme: 'semi-lagrangian', vorticity: 0 },
    // A finer grid solved by multigrid: the solver at its most expensive setting.
    'fine multigrid': {
      resolution: '256',
      pressureSolver: 'multigrid',
      pressureIterations: 20,
    },
    // Strong expansion at the bed: the gas pushes outward before it rises.
    expanding: { expansion: 4, source: 1.4, buoyancy: 0.9 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'stable-fluids' });
    const uniforms = createUniformBuffer(device, Params, 'stable-fluids params');
    const sampler = device.createSampler({
      label: 'stable-fluids sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    // The divergence is r32float, read with textureLoad: the layout is written out, not derived.
    const layout = device.createBindGroupLayout({
      label: 'stable-fluids display layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
      layout: [layout],
    });

    // There is no DOM in the tests: the stirrer then simply has no pointers.
    const pointers: MultiPointerTracker | undefined =
      typeof canvas.addEventListener === 'function'
        ? trackPointers(canvas, { capture: true })
        : undefined;
    const stirrer = createFluidStirrer();

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
      params: { boundary: 'open' },
      profiler,
      label: 'stable-fluids',
    });

    let seeded = -1;
    let expansion = Number.NaN;
    let clock = 0;
    const groups = new Map<number, GPUBindGroup>();
    let groupGeneration = -1;

    function displayGroup(): GPUBindGroup {
      if (groupGeneration !== fluid.generation) {
        groups.clear();
        groupGeneration = fluid.generation;
      }
      const slot = fluid.dye.slot;
      let group = groups.get(slot);
      if (!group) {
        group = device.createBindGroup({
          label: 'stable-fluids display',
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: fluid.dye.view },
            { binding: 2, resource: sampler },
            { binding: 3, resource: fluid.fieldsView },
            { binding: 4, resource: fluid.divergence.createView() },
          ],
        });
        groups.set(slot, group);
      }
      return group;
    }

    function sync() {
      const p = fluid.params;
      const scheme = params.scheme as FluidScheme;
      p.velocityScheme = scheme;
      p.dyeScheme = scheme;
      p.vorticity = params.vorticity;
      p.velocityDissipation = params.damping;
      p.pressureSolver = params.pressureSolver as FluidPressureSolver;
      p.pressureIterations = params.pressureIterations;
      p.multigridCycles = Math.max(1, Math.round(params.pressureIterations / 10));
      p.buoyancy = params.buoyancy;
      p.buoyancyWeights = [1, 0, -SMOKE_WEIGHT, 0];
      p.dyeDissipation = [params.cooling, 0, params.smokeFade, 0];
      fluid.setResolution(cells(), Math.min(1024, cells() * 4));
      if (params.expansion !== expansion) {
        expansion = params.expansion;
        const strength = expansion;
        fluid.setDivergenceSource(
          strength > 0
            ? (x, y) =>
                Math.hypot((x - BED[0]) * fluid.grid.aspect, y - BED[1]) < EXPANSION_RADIUS
                  ? strength
                  : 0
            : null,
        );
      }
    }

    /** The bed: tongues of heat and smoke along a short line, each breathing on its own slow clock. */
    function feed(delta: number) {
      const level = params.source;
      if (level <= 0 || delta <= 0) return;
      for (let k = 0; k < TONGUES; k++) {
        const phase = clock * (0.9 + 0.23 * k) + k * 2.1;
        const breathe = 0.6 + 0.4 * Math.sin(phase);
        const x =
          BED[0] + BED_HALF_WIDTH * ((k / (TONGUES - 1)) * 2 - 1) + 0.012 * Math.sin(phase * 1.3);
        const at: [number, number] = [x, BED[1] + 0.01 * Math.cos(phase)];
        const amount = level * breathe * delta;
        fluid.addDye(at, at, 0.03, [2.4 * amount, 0, 1.4 * amount, 0]);
        fluid.addForce(at, at, 0.035, [0.06 * Math.sin(phase * 0.7) * delta, -0.4 * amount]);
      }
      // A slow side wind that comes and goes, so the plume leans and curls rather than standing still.
      const gust = Math.sin(clock * 0.31) * Math.sin(clock * 0.17 + 1);
      if (Math.abs(gust) > 0.2) {
        const y = 0.45 + 0.1 * Math.sin(clock * 0.23);
        fluid.addForce([0.2, y], [0.8, y], 0.12, [gust * 0.6 * delta * level, 0], 0.06);
      }
    }

    function stroke(s: FluidStroke): [number, number, number, number] {
      // A press lays glowing embers and smoke; a hover only smoke, and no heat (fire is lit by a press).
      return s.hover ? [0, 0, 0.8, 0] : [1.6, 0, 0.6, 0];
    }

    return {
      /** The solver, for tests and tools. */
      get fluid() {
        return fluid;
      },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        tail.resize(width, height);
        // Dragging a window edge changes the aspect a little at a time; re-creating the grids for each
        // pixel would wipe the smoke, so the fluid follows only a real change of shape.
        const aspect = width / height;
        if (Math.abs(Math.log(aspect / simAspect)) > 0.06) {
          simAspect = aspect;
          fluid.resize(width, height);
        }
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        clock += delta;
        sync();
        const aspect = width / height;
        if (seeded !== fluid.generation) {
          seeded = fluid.generation;
          fluid.setDye(firstPlume(fluid.grid.aspect));
        }
        stirrer.stir(fluid, pointers?.poll() ?? [], aspect, delta, {
          mode: 'hover and press',
          radius: params.radius,
          force: params.force,
          dyeAmount: 1,
          colour: stroke,
          hoverDye: 0.3,
        });
        feed(delta);
        fluid.update(encoder, delta);

        const grid = fluid.grid;
        uniforms.set({
          bed: [BED[0], BED[1]],
          grid: [grid.width, grid.height],
          aspect,
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
          glow: params.glow,
          heat_scale: 0.6,
          opacity: params.opacity,
          bed_light: 0.6 * params.source * params.glow,
          debug_gain: params.debugGain,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup()], {
          timestampWrites: profiler.pass('smoke'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        pointers?.destroy();
        fluid.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
