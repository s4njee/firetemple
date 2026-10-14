import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createFixedStepper } from '../../gpu/loop.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import {
  createCombustionSim,
  type CombustionFuel,
  type CombustionPlan,
  type CombustionSim,
} from '../../gpu/sim/combustion.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import {
  collectIgniters,
  createAmbientIgnition,
  createPointerIgnition,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

const Params = defineUniformStruct('Params', {
  view: 'f32',
  aspect: 'f32',
  glow: 'f32',
  kelvin: 'f32',
  flare: 'f32',
  char_amount: 'f32',
  fuel: 'f32',
});

/** What the picture shows; the index is `VIEW_*` in scene.wgsl. */
const VIEWS = ['fire', 'temperature', 'fuel', 'reaction rate'] as const;
const LAPLACIANS = ['9-point', '5-point'] as const;

/** Simulation steps per second, whatever the display rate. */
const STEPS_PER_SECOND = 60;
/** Steps one frame may run: a 30 fps frame takes two, anything slower drops time instead. */
const MAX_STEPS = 2;
/** Sub-steps one step may take before the diffusivity is lowered instead. */
const SUBSTEPS_PER_STEP = 8;
/**
 * The grid the physical constants are quoted for. `diffusion` is in cells squared per second of
 * a grid this many rows high; on another grid it is rescaled, so a front crosses the canvas in
 * the same time whatever the `grid` setting.
 */
export const REFERENCE_ROWS = 384;
/** A very wide canvas gets fewer rows rather than more columns than this. */
const MAX_COLUMNS = 1024;
/** Temperature an ember or a touch holds the ground at: well above any ignition setting. */
const IGNITER_TEMPERATURE = 1.5;
/** Stray embers are cooler: enough to light full fuel, not a white flash where they land. */
const EMBER_TEMPERATURE = 0.8;
/** How much of the calm ember rate, and of the heat release, a full drive level adds. */
const DRIVE_EMBERS = 0.8;
const DRIVE_RELEASE = 0.2;

/** Fronts already burning when the fuel is first laid: [x, y, radius] in uv and canvas heights. */
const FIRST_FRONTS = [
  [0.27, 0.62, 0.17],
  [0.76, 0.3, 0.27],
  [0.6, 1.02, 0.12],
] as const;

/** The grid for a canvas of this shape: square cells, `rows` high unless that is too wide. */
export function gridSize(rows: number, aspect: number): { width: number; height: number } {
  const shape = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let height = Math.min(
    512,
    Math.max(32, Math.round(Number.isFinite(rows) ? rows : REFERENCE_ROWS)),
  );
  if (height * shape > MAX_COLUMNS) height = Math.max(32, Math.round(MAX_COLUMNS / shape));
  return { width: Math.min(MAX_COLUMNS, Math.max(8, Math.round(height * shape))), height };
}

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'fire', options: VIEWS, label: 'diagnostic' },
    diffusion: { type: 'number', default: 14, min: 2, max: 60, step: 0.5, label: 'D diffusion' },
    release: { type: 'number', default: 1, min: 0.3, max: 2, step: 0.01, label: 'Q heat release' },
    rate: { type: 'number', default: 6, min: 0.5, max: 32, step: 0.1, label: 'k reaction rate' },
    ignition: { type: 'number', default: 0.25, min: 0.02, max: 0.8, step: 0.01 },
    cooling: { type: 'number', default: 0.6, min: 0, max: 6, step: 0.01, label: 'C cooling' },
    regrow: { type: 'number', default: 0.1, min: 0, max: 0.5, step: 0.005 },
    embers: { type: 'number', default: 0.45, min: 0, max: 4, step: 0.05 },
    patchiness: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    patches: { type: 'number', default: 3, min: 0.5, max: 10, step: 0.1 },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    grid: { type: 'number', default: 384, min: 192, max: 512, step: 64 },
    laplacian: { type: 'select', default: '9-point', options: LAPLACIANS },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    kelvin: { type: 'number', default: 2000, min: 1300, max: 3200, step: 10 },
    flare: { type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.01 },
    char: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    fuel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'show fuel' },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    burn: {},
    // Half the speed and twice the wait: one front at a time, crossing slowly.
    'steady creep': {
      diffusion: 7,
      rate: 3,
      cooling: 0.3,
      regrow: 0.06,
      embers: 0.25,
      patchiness: 0.15,
    },
    // Poor, broken fuel and a high ignition temperature: fronts finger through what will burn.
    'patchy smoulder': {
      diffusion: 10,
      rate: 5,
      cooling: 0.5,
      ignition: 0.3,
      patchiness: 0.8,
      patches: 5,
      regrow: 0.05,
      embers: 0.8,
      kelvin: 1750,
      flare: 0.3,
      fuel: 0.5,
    },
    // Fast fronts, fast regrowth and many embers: the same ground burns every few seconds.
    'fast cycle': {
      diffusion: 20,
      rate: 8,
      cooling: 1,
      regrow: 0.4,
      embers: 1.2,
      patchiness: 0.5,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'combustion-front' });
    const noise = getNoiseTexture(device);
    const uniforms = createUniformBuffer(device, Params, 'combustion-front params');
    const pipeline = createFullscreenPipeline(device, {
      fragment: withChunks(shader, { 'params.wgsl': Params.wgsl }),
      format: tail.scene.format,
    });
    const sampler = device.createSampler({
      label: 'combustion-front state',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    const pointer = createPointerIgnition(canvas, {
      radius: 0.035,
      strength: IGNITER_TEMPERATURE,
    });
    const embers = createAmbientIgnition({
      rate: params.embers,
      radius: 0.022,
      strength: EMBER_TEMPERATURE,
      seed: 7,
    });
    const stepper = createFixedStepper(1 / STEPS_PER_SECOND, { maxSteps: MAX_STEPS });
    let drive: Excitation = createExcitation(params.drive, canvas);

    let aspect = 16 / 9;
    let sim: CombustionSim | undefined;
    let generation = 0;
    /** One bind group per state texture of the current grid, by index into `sim.targets`. */
    let groups: GPUBindGroup[] = [];
    let groupsFor = -1;
    let laid: { patchiness: number; patches: number } | undefined;
    let plan: CombustionPlan | undefined;

    const fuel = (first: boolean): CombustionFuel => ({
      patchiness: params.patchiness,
      scale: params.patches,
      fronts: first ? FIRST_FRONTS : undefined,
      peak: 0.72 * params.release,
    });

    /** Brings the grid in line with the canvas shape and the `grid` and fuel parameters. */
    const ensureGrid = () => {
      const size = gridSize(params.grid, aspect);
      if (!sim) {
        sim = createCombustionSim(device, { ...size, label: 'combustion-front' });
        sim.lay(fuel(true));
      } else if (sim.resize(size.width, size.height, fuel(false))) {
        generation++;
      } else if (laid?.patchiness !== params.patchiness || laid.patches !== params.patches) {
        sim.lay(fuel(false), true);
      }
      laid = { patchiness: params.patchiness, patches: params.patches };
      return sim;
    };

    const instance = {
      /** Bumps when the simulation grid is re-created (a new `grid` setting or canvas shape). */
      get generation() {
        return generation;
      },
      /** The grid in use and how the last step was split, for tests and tools. */
      get grid() {
        return sim ? { width: sim.width, height: sim.height, plan } : undefined;
      },
      resize(width: number, height: number) {
        tail.resize(width, height);
        aspect = width / Math.max(1, height);
        ensureGrid();
      },
      frame(
        time: { time: number; delta: number; frame: number },
        encoder: GPUCommandEncoder,
        target: GPUTextureView,
      ) {
        const grid = ensureGrid();

        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        // The drive feeds the fire, never its clock: more embers and a little more heat.
        const level = drive.update(time.delta);
        embers.rate = params.embers * (1 + DRIVE_EMBERS * level);

        const { steps } = stepper.advance(time.delta);
        if (steps > 0) {
          const seconds = steps / STEPS_PER_SECOND;
          // Cells of this grid per reference cell: D is an area per second, so it scales squared.
          const scale = grid.height / REFERENCE_ROWS;
          plan = grid.advance(
            encoder,
            seconds,
            {
              diffusion: params.diffusion * scale * scale,
              release: params.release * (1 + DRIVE_RELEASE * level),
              rate: params.rate,
              cooling: params.cooling,
              regrow: params.regrow,
              // The module also has an Arrhenius law. It is measured in the notes and not
              // offered here: no ember can light it, and any useful cooling puts it out.
              kinetics: 'threshold',
              ignition: params.ignition,
              activation: 0,
              stencil: params.laplacian === '5-point' ? 5 : 9,
            },
            collectIgniters(seconds, pointer, embers),
            aspect,
            {
              maxSubsteps: SUBSTEPS_PER_STEP * steps,
              timestampWrites: () => profiler.pass('step'),
            },
          );
        }

        uniforms.set({
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
          aspect,
          glow: params.glow,
          kelvin: params.kelvin,
          flare: params.flare,
          char_amount: params.char,
          fuel: params.fuel,
        });
        uniforms.upload();

        if (groupsFor !== grid.generation) {
          groups = grid.targets.map((state, index) =>
            device.createBindGroup({
              label: `combustion-front scene ${index}`,
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniforms.buffer } },
                { binding: 1, resource: state.view },
                { binding: 2, resource: sampler },
                { binding: 3, resource: noise.view },
                { binding: 4, resource: noise.sampler },
              ],
            }),
          );
          groupsFor = grid.generation;
        }
        const current = grid.state === grid.targets[0] ? 0 : 1;
        renderFullscreen(encoder, tail.scene.view, pipeline, [groups[current]!], {
          timestampWrites: profiler.pass('fire'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },
      destroy() {
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        sim?.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
    return instance;
  },
});
