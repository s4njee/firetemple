import { getNoiseTexture } from '../emission/noise-texture.ts';
import { createFullscreenPipeline, renderFullscreen } from '../fullscreen.ts';
import { withChunks } from '../shader.ts';
import { createRenderTarget, type RenderTarget } from '../targets.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../uniforms.ts';
import layShader from './combustion-lay.wgsl';
import stepShader from './combustion-step.wgsl';
import { IgnitersUniform, writeIgniters, type Igniter } from './ignition.ts';

/*
 * Reaction-diffusion combustion (story 5.6): fire as a travelling front in two continuous fields.
 *
 *   dT/dt = D lap(T) + Q R - C T          temperature above ambient
 *   dF/dt = -R + regrow F0 [cold, F < F0] fuel, growing back to its capacity F0 on cold ground
 *   R     = k F g(T)                      reaction rate; g switches on with temperature
 *
 * Heat diffuses into unburnt fuel, the fuel ignites, burning releases heat. Nothing sets the speed
 * of the front: it comes out as about sqrt(D k) times a number that depends on Q, C / k and the
 * ignition law, and the front is about sqrt(D / k) cells thick.
 *
 *   const sim = createCombustionSim(device, { width: 455, height: 256 });
 *   sim.lay({ patchiness: 0.5, scale: 3 });                        // fuel map; needs no encoder
 *   // each frame, for `seconds` of simulated time:
 *   sim.advance(encoder, seconds, settings, igniters, canvasAspect);
 *   // then sample sim.state.view (r = T, g = F, b = F0, a = reaction rate)
 *
 * Units: lengths are cells, times are seconds, T is in units of the temperature rise of fully
 * burnt, loss-free fuel at Q = 1. `sim.state` and `sim.generation` change when a call says so:
 * rebuild bind groups that hold the view.
 *
 * Stability. Only diffusion is integrated explicitly, so only it can blow up: the scheme needs
 * alpha = D dt <= 3/8 with the 9-point stencil and <= 1/4 with the 5-point one (it also stops
 * being monotone, i.e. starts to overshoot, above 3/10 and 1/4). `planCombustion` splits the time
 * it is given into enough sub-steps to keep alpha at or below `COMBUSTION_ALPHA_MAX` = 1/4, and
 * when that would take more than `maxSubsteps` it lowers D instead and says so. Reaction, cooling
 * and regrowth are integrated exactly, so no rate can overshoot whatever the step.
 */

/** Largest D dt / dx^2 a sub-step is allowed. */
export const COMBUSTION_ALPHA_MAX = 0.25;
/** Sub-steps one `advance` may take before it lowers D instead. */
export const COMBUSTION_MAX_SUBSTEPS = 16;
/** T is clamped to 0..this. A free front peaks below Q; igniters and converging fronts go higher. */
export const COMBUSTION_T_MAX = 4;
/** Width of the ignition switch: the rate goes from 0 at `ignition` to k at `ignition` + this. */
export const COMBUSTION_SOFT = 0.15;
/** Ambient temperature for the Arrhenius law, in units of T: 300 K under a 1500 K rise. */
export const COMBUSTION_THETA0 = 0.2;
/** Fronts `lay` can put down ready-made. */
export const COMBUSTION_MAX_FRONTS = 4;

export const COMBUSTION_KINETICS = ['threshold', 'arrhenius'] as const;
export type CombustionKinetics = (typeof COMBUSTION_KINETICS)[number];

export interface CombustionSettings {
  /** D: thermal diffusivity, in cells squared per second. */
  diffusion: number;
  /** Q: temperature rise from burning one unit of fuel. */
  release: number;
  /** k: reaction rate constant, per second. */
  rate: number;
  /** C: Newtonian cooling toward ambient, per second. */
  cooling: number;
  /**
   * Share of its capacity a cell's fuel gets back per second where the ground is cold: burnt
   * ground is full again 1 / regrow seconds after it has cooled.
   */
  regrow: number;
  /**
   * `threshold`: g = smoothstep(ignition, ignition + COMBUSTION_SOFT, T), exactly 0 below the
   * ignition temperature. `arrhenius`: g = exp(Ea / theta_b - Ea / theta), 1 at the adiabatic
   * flame temperature and falling steeply below it.
   */
  kinetics: CombustionKinetics;
  /** Ignition temperature of the threshold law. */
  ignition: number;
  /**
   * Zeldovich number of the Arrhenius law: Ea Q / theta_b^2, how many times the rate e-folds
   * between the flame temperature and a little below it. Fronts pulsate above about 8.
   */
  activation: number;
  /** 9 (isotropic, default) or 5 points for the Laplacian. */
  stencil?: 5 | 9;
}

export interface CombustionPlan {
  substeps: number;
  /** Seconds per sub-step. */
  dt: number;
  /** D dt / dx^2 of each sub-step. */
  alpha: number;
  /** The diffusivity actually simulated: lower than asked when `clamped`. */
  diffusion: number;
  clamped: boolean;
}

export interface CombustionAdvanceOptions {
  /** Timestamp writes for each sub-step's pass, e.g. `() => profiler.pass('step')`. */
  timestampWrites?: () => GPURenderPassTimestampWrites | undefined;
  /** Default `COMBUSTION_MAX_SUBSTEPS`. */
  maxSubsteps?: number;
  /**
   * Default `COMBUSTION_ALPHA_MAX`. Raising it past the stability limit is how the tests show
   * that the limit is real; nothing else should.
   */
  alphaMax?: number;
}

/** How `seconds` of simulated time are split so that diffusion stays stable. */
export function planCombustion(
  diffusion: number,
  seconds: number,
  maxSubsteps = COMBUSTION_MAX_SUBSTEPS,
  alphaMax = COMBUSTION_ALPHA_MAX,
): CombustionPlan {
  const d = Number.isFinite(diffusion) ? Math.max(0, diffusion) : 0;
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const limit = Math.max(1, Math.floor(maxSubsteps));
  if (time === 0) return { substeps: 0, dt: 0, alpha: 0, diffusion: d, clamped: false };
  // The epsilon keeps D dt = 1 from becoming five sub-steps through rounding.
  const wanted = Math.max(1, Math.ceil((d * time) / alphaMax - 1e-9));
  const substeps = Math.min(wanted, limit);
  const dt = time / substeps;
  const alpha = Math.min(d * dt, alphaMax);
  return { substeps, dt, alpha, diffusion: alpha / dt, clamped: wanted > limit };
}

export interface CombustionFuel {
  /** 0: uniform fuel. 1: a quarter of the ground bare or too poor to burn. */
  patchiness: number;
  /** Noise cells across the canvas height: how many patches. */
  scale: number;
  /** Where in the noise the map is taken from, in noise cells. Default [0, 0]. */
  offset?: readonly [number, number];
  /**
   * Fronts that are already burning when the fuel is laid, as [x, y, radius]: uv and canvas
   * heights. Ignored when the old state is kept.
   */
  fronts?: readonly (readonly [number, number, number])[];
  /** Peak temperature of those fronts. Default 0.8. */
  peak?: number;
  /** How far behind those fronts the fuel has grown back, in canvas heights. Default 0.35. */
  heal?: number;
}

export interface CombustionSimOptions {
  /** Grid size in cells. Make the cells square: width = height * canvas aspect. */
  width: number;
  height: number;
  label?: string;
}

export interface CombustionSim {
  readonly width: number;
  readonly height: number;
  /** Bumps whenever the grid's textures are re-created. */
  readonly generation: number;
  /** The current state. Which texture this is changes with every sub-step: read it each frame. */
  readonly state: RenderTarget;
  /** Both textures the state alternates between, for building bind groups once per generation. */
  readonly targets: readonly [RenderTarget, RenderTarget];
  /**
   * Lays the fuel map and submits it at once. With `keep` (default false) temperature and the
   * burnt share of each cell survive; without it the state starts cold and full.
   */
  lay(fuel: CombustionFuel, keep?: boolean): void;
  /**
   * Changes the grid size, carrying the state across (resampled). Returns whether it re-created
   * the textures; `lay` has then been called with `fuel` and `generation` has gone up.
   */
  resize(width: number, height: number, fuel: CombustionFuel): boolean;
  /** Encodes the sub-steps for `seconds` of simulated time and returns the plan it followed. */
  advance(
    encoder: GPUCommandEncoder,
    seconds: number,
    settings: CombustionSettings,
    igniters: readonly Igniter[],
    aspect: number,
    options?: CombustionAdvanceOptions,
  ): CombustionPlan;
  destroy(): void;
}

const StepParams = defineUniformStruct('CombustionStep', {
  alpha: 'f32',
  k_dt: 'f32',
  release: 'f32',
  cool: 'f32',
  regrow: 'f32',
  ignition: 'f32',
  soft: 'f32',
  kinetics: 'f32',
  activation: 'f32',
  theta0: 'f32',
  inv_theta_b: 'f32',
  t_max: 'f32',
  stencil: 'f32',
  seed: 'i32',
});

const LayParams = defineUniformStruct('CombustionLay', {
  offset: 'vec2f',
  aspect: 'f32',
  scale: 'f32',
  patchiness: 'f32',
  keep: 'f32',
  peak: 'f32',
  heal: 'f32',
  count: 'u32',
  fronts: uniformArray('vec4f', COMBUSTION_MAX_FRONTS),
});

const FORMAT: GPUTextureFormat = 'rgba16float';
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function createCombustionSim(
  device: GPUDevice,
  options: CombustionSimOptions,
): CombustionSim {
  const label = options.label ?? 'combustion';
  const noise = getNoiseTexture(device);
  const stepUniforms = createUniformBuffer(device, StepParams, `${label} step`);
  const layUniforms = createUniformBuffer(device, LayParams, `${label} lay`);
  const igniterUniforms = createUniformBuffer(device, IgnitersUniform, `${label} igniters`);
  const stepPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(stepShader, { 'combustion-step-params.wgsl': StepParams.wgsl }),
    format: FORMAT,
  });
  const layPipeline = createFullscreenPipeline(device, {
    fragment: withChunks(layShader, { 'combustion-lay-params.wgsl': LayParams.wgsl }),
    format: FORMAT,
  });
  const sampler = device.createSampler({
    label: `${label} resample`,
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const allocate = (width: number, height: number, name: string) =>
    createRenderTarget(device, {
      label: `${label} ${name}`,
      format: FORMAT,
      width,
      height,
      // COPY_SRC lets tests and tools read the fields back; it costs nothing.
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  const size = (value: number) => clamp(Math.round(finite(value, 1)), 1, 4096);

  let targets: [RenderTarget, RenderTarget] = [
    allocate(size(options.width), size(options.height), 'A'),
    allocate(size(options.width), size(options.height), 'B'),
  ];
  let current: 0 | 1 = 0;
  let generation = 0;
  let stepGroups: [GPUBindGroup, GPUBindGroup] | undefined;
  let seed = 1;
  let destroyed = false;

  /** `stepGroups[i]` reads `targets[i]`. */
  const groups = () =>
    (stepGroups ??= targets.map((target, index) =>
      device.createBindGroup({
        label: `${label} step ${index}`,
        layout: stepPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: stepUniforms.buffer } },
          { binding: 1, resource: { buffer: igniterUniforms.buffer } },
          { binding: 2, resource: target.view },
        ],
      }),
    ) as [GPUBindGroup, GPUBindGroup]);

  /** Renders a new state into `into`, reading the old one from `from`. */
  const layInto = (into: RenderTarget, from: RenderTarget, fuel: CombustionFuel, keep: boolean) => {
    const fronts = new Float32Array(COMBUSTION_MAX_FRONTS * 4);
    const count = Math.min(fuel.fronts?.length ?? 0, COMBUSTION_MAX_FRONTS);
    for (let i = 0; i < count; i++) fronts.set(fuel.fronts![i]!, i * 4);
    const offset = fuel.offset ?? [0, 0];
    layUniforms.set({
      offset: [offset[0], offset[1]],
      aspect: into.width / into.height,
      scale: Math.max(0, finite(fuel.scale, 1)),
      patchiness: clamp(finite(fuel.patchiness, 0), 0, 1),
      keep: keep ? 1 : 0,
      peak: clamp(fuel.peak ?? 0.8, 0, COMBUSTION_T_MAX),
      heal: Math.max(1e-3, fuel.heal ?? 0.35),
      count,
      fronts,
    });
    layUniforms.upload();
    const group = device.createBindGroup({
      label: `${label} lay`,
      layout: layPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: layUniforms.buffer } },
        { binding: 1, resource: noise.view },
        { binding: 2, resource: noise.sampler },
        { binding: 3, resource: from.view },
        { binding: 4, resource: sampler },
      ],
    });
    const encoder = device.createCommandEncoder({ label: `${label} lay` });
    renderFullscreen(encoder, into.view, layPipeline, [group]);
    device.queue.submit([encoder.finish()]);
  };

  return {
    get width() {
      return targets[0].width;
    },
    get height() {
      return targets[0].height;
    },
    get generation() {
      return generation;
    },
    get state() {
      return targets[current];
    },
    get targets() {
      return targets;
    },
    lay(fuel, keep = false) {
      if (destroyed) return;
      const other = current === 0 ? 1 : 0;
      layInto(targets[other], targets[current], fuel, keep);
      current = other;
    },
    resize(width, height, fuel) {
      const w = size(width);
      const h = size(height);
      if (destroyed || (w === targets[0].width && h === targets[0].height)) return false;
      const old = targets;
      const next: [RenderTarget, RenderTarget] = [allocate(w, h, 'A'), allocate(w, h, 'B')];
      layInto(next[0], old[current], fuel, true);
      // The lay pass is already submitted, so the old textures can go.
      old[0].destroy();
      old[1].destroy();
      targets = next;
      current = 0;
      stepGroups = undefined;
      generation++;
      return true;
    },
    advance(encoder, seconds, settings, igniters, aspect, advanceOptions = {}) {
      const plan = planCombustion(
        settings.diffusion,
        seconds,
        advanceOptions.maxSubsteps,
        advanceOptions.alphaMax,
      );
      if (destroyed || plan.substeps === 0) return plan;
      const { dt } = plan;
      const release = clamp(finite(settings.release, 0), 0, COMBUSTION_T_MAX);
      const thetaB = COMBUSTION_THETA0 + Math.max(release, 1e-3);
      // Zeldovich number Ea Q / theta_b^2, turned back into the activation temperature Ea.
      const activation =
        (clamp(finite(settings.activation, 0), 0, 40) * thetaB * thetaB) / Math.max(release, 1e-3);
      seed = (seed + 1) % 0x7fffffff;
      stepUniforms.set({
        alpha: plan.alpha,
        k_dt: Math.max(0, finite(settings.rate, 0)) * dt,
        release,
        cool: Math.exp(-Math.max(0, finite(settings.cooling, 0)) * dt),
        regrow: Math.min(1, Math.max(0, finite(settings.regrow, 0)) * dt),
        ignition: clamp(finite(settings.ignition, 0), 0, COMBUSTION_T_MAX),
        soft: COMBUSTION_SOFT,
        kinetics: settings.kinetics === 'arrhenius' ? 1 : 0,
        activation,
        theta0: COMBUSTION_THETA0,
        inv_theta_b: 1 / thetaB,
        t_max: COMBUSTION_T_MAX,
        stencil: settings.stencil === 5 ? 0 : 1,
        seed,
      });
      stepUniforms.upload();
      writeIgniters(igniterUniforms, igniters, aspect);
      igniterUniforms.upload();

      const bind = groups();
      for (let i = 0; i < plan.substeps; i++) {
        const other = current === 0 ? 1 : 0;
        renderFullscreen(encoder, targets[other].view, stepPipeline, [bind[current]], {
          label: `${label} step`,
          timestampWrites: advanceOptions.timestampWrites?.(),
        });
        current = other;
      }
      return plan;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      targets[0].destroy();
      targets[1].destroy();
      stepUniforms.destroy();
      layUniforms.destroy();
      igniterUniforms.destroy();
    },
  };
}
