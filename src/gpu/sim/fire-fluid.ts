import { getNoiseTexture } from '../emission/noise-texture.ts';
import { createFixedStepper, type FixedStepper } from '../loop.ts';
import { noProfiler, type PassProfiler } from '../profiler.ts';
import { createShader, withChunks } from '../shader.ts';
import {
  createUniformBuffer,
  defineUniformStruct,
  uniformArray,
  type UniformBuffer,
} from '../uniforms.ts';
import expandShader from './fire-fluid-expand.wgsl';
import reactShader from './fire-fluid-react.wgsl';
import turbulenceShader from './fire-fluid-turbulence.wgsl';
import {
  createFluid,
  type Fluid,
  type FluidEdge,
  type FluidGrid,
  type FluidParams,
  type FluidScheme,
  type FluidTexture,
} from './fluid.ts';
import {
  collectIgniters,
  IgnitersUniform,
  writeIgniters,
  type Igniter,
  type IgnitionSource,
} from './ignition.ts';

/*
 * Fire as a fluid in 2D (Fire Temple stories 6.2 to 6.7): a combustion layer on the stable-fluids
 * solver of fluid.ts. It owns the solver's three hooks, the meaning of the four dye channels and the
 * emitters; the solver does the flow. After Nguyen, Fedkiw and Jensen (2002) in its parts, simplified the
 * way a GPU wants it: fields, no level set.
 *
 * THE DYE (rgba16float, 4 x finer than the velocity grid; see fire-fluid-react.wgsl):
 *   r  T  temperature above ambient (0 cold, a flame body 2-3, a core 4; capped at LIMITS.temperature)
 *   g  F  fuel, unburnt gas (1 is rich)
 *   b  S  soot, an optical amount
 *   a  R  burn rate, fuel burnt per second in the last step: the reaction zone
 *
 * ONE STEP (fluid.ts runs the flow, the hooks are this module's):
 *   forces      buoyancy  a = buoyancy (T - sootWeight S) along up, leaned by `wind` (the solver's
 *               built-in buoyancy: weights [1, 0, -sootWeight, 0]); vorticity confinement (the solver's)
 *   hooks.forces       procedural turbulence (fire-fluid-turbulence.wgsl), only when `turbulence` > 0
 *   hooks.divergence   gas expansion S = expansion * R per cell (fire-fluid-expand.wgsl): the projection
 *                      targets div u = S, so the gas swells outward where it burns
 *   projection, then the dye is advected; the solver's dyeDissipation cools T at `cooling`, thins
 *               soot at `sootFade` and unburnt fuel at `fuelFade` (0 by default: fuel only burns)
 *   hooks.dye   the reaction (fire-fluid-react.wgsl): burners and torches add fuel and heat, fuel above
 *               `ignition` burns at `burnRate`, releasing `heat` and `soot` per unit; radiation caps the
 *               hottest cores; every value is rounded stochastically to an exact half float.
 *
 * BOUNDARIES. The solver runs with `boundary: 'open'` (a divergence source in a closed box has no
 * solution) and, with `floor` (default), the bottom edge closed: the gas spreads along the ground and
 * leaves through the sides and the top.
 *
 *   const fire = createFireFluid({ device, width, height, resolution: 128 });
 *   fire.setSources([{ from: [0.3, 0.93], to: [0.7, 0.93], radius: 0.025, fuel: 1 }]);
 *   fire.ignition.torches.push(createPointerIgnition(canvas));   // press and drag to spray burning fuel
 *   fire.ignition.embers.push(createAmbientIgnition({ rate: 0.4, region: [0.3, 0.85, 0.7, 0.97] }));
 *   fire.seed();                                     // already burning, so a still frame is a fire
 *   // every frame:
 *   fire.update(encoder, delta);
 *   // sample fire.dye.view (cache bind groups by slot and fire.generation)
 *
 * Positions are canvas uv (top-left origin, y down); lengths are image heights; speeds image heights
 * per second; times seconds. To put this on a solver someone else made (obstacles, a different grid),
 * pass `fluid`: the module then sets its hooks and the parameters listed in `fireFluidSolverParams`,
 * and leaves the pressure solver, step rate and obstacles alone (and does not destroy it). Step it
 * through `fire.update` / `fire.advance`, never `fluid.update` directly: the hooks read per-step
 * uniforms (seed, time, igniters) that only those write.
 */

/** Burners the reaction step reads; more are ignored. */
export const FIRE_FLUID_MAX_SOURCES = 12;

/** What the reaction clamps the dye to. */
export const FIRE_FLUID_LIMITS = { temperature: 5, fuel: 4, soot: 8, rate: 64 } as const;

/** The largest expansion source a cell may ask for, 1 / s. */
const SOURCE_MAX = 12;

type Vec2 = readonly [number, number];

/** A burner: fuel (and a floor of heat) along a capsule. */
export interface FireFluidSource {
  /** Ends of the capsule in uv; equal for a point. */
  from: Vec2;
  to: Vec2;
  /** Gaussian radius, image heights. */
  radius: number;
  /** Share of `fuelRate` this burner emits at its centre. */
  fuel: number;
  /** Share of `bedTemperature` it holds (glowing logs 1, a cold nozzle 0). Default 1. */
  bed?: number;
  /** Upward gas speed it drives, image heights per second (a gas jet). Default 0. */
  jet?: number;
}

/** Live parameters, read on every update. */
export interface FireFluidParams {
  /** Fuel per second a burner of weight 1 emits at its centre. */
  fuelRate: number;
  /** How lumpy the supply is: 0 steady, 1 tongues (the baked noise rising through the burner). */
  lumps: number;
  /** Size of a lump, image heights, and how fast the lumps rise through the burner, image heights / s. */
  lumpScale: number;
  lumpRise: number;
  /** Temperature the burners hold (glowing logs, a pilot); below `ignition` only igniters light it. */
  bedTemperature: number;
  /** Temperature at which fuel starts to burn, and the width over which burning switches fully on. */
  ignition: number;
  soft: number;
  /** Rate at which fuel above ignition burns, 1 / s. */
  burnRate: number;
  /** Temperature released per unit of fuel burnt. */
  heat: number;
  /** Soot made per unit of fuel burnt. */
  soot: number;
  /** Expansion: divergence (1 / s) per unit of burn rate (fuel per second). 0 is incompressible. */
  expansion: number;
  /** Convective cooling of T, 1 / s (the solver's dye dissipation of r). */
  cooling: number;
  /** Radiative loss, dT/dt = -radiation T^4. */
  radiation: number;
  /** Thinning of soot and of unburnt fuel, 1 / s. */
  sootFade: number;
  fuelFade: number;
  /** Lift per unit of temperature, image heights / s^2. */
  buoyancy: number;
  /** Pull of a unit of soot, as a share of the lift of a unit of temperature. */
  sootWeight: number;
  /** Sideways lean of the lift, as a share of it (+ to the right). */
  wind: number;
  /** Vorticity confinement, 1 / s (keep it under about 14 x `velocityDissipation`). */
  vorticity: number;
  /** Velocity decay, 1 / s. */
  velocityDissipation: number;
  /** Advection scheme of velocity and dye. */
  scheme: FluidScheme;
  /** Procedural turbulence: acceleration in image heights / s^2 at full weight; 0 is off (no pass). */
  turbulence: number;
  /** Its wavelength, in velocity cells, and how fast it rises, image heights / s. */
  turbulenceScale: number;
  turbulenceRise: number;
  /** Fuel per second a pressed torch (pointer igniter) adds at its centre, and the temperature it holds. */
  torchFuel: number;
  torchHeat: number;
  /** How much of a drag's speed a torch gives the gas (0 none, 1 all). */
  torchPush: number;
  /** A wall under the fire, open sides and top. Otherwise every edge is open. */
  floor: boolean;
}

export const DEFAULT_FIRE_FLUID_PARAMS: Readonly<FireFluidParams> = {
  fuelRate: 3.5,
  lumps: 0.7,
  lumpScale: 0.06,
  lumpRise: 0.5,
  bedTemperature: 1.2,
  ignition: 0.8,
  soft: 0.3,
  burnRate: 2.2,
  heat: 3,
  soot: 0.25,
  expansion: 0.25,
  cooling: 0.9,
  radiation: 0.02,
  sootFade: 0.35,
  fuelFade: 0,
  buoyancy: 0.8,
  sootWeight: 0.1,
  wind: 0,
  vorticity: 4,
  velocityDissipation: 0.8,
  scheme: 'maccormack',
  turbulence: 3,
  turbulenceScale: 8,
  turbulenceRise: 0.4,
  torchFuel: 10,
  torchHeat: 2.6,
  torchPush: 0.5,
  floor: true,
};

/** The step's uniform block (fire-fluid-params.wgsl), one buffer per step of a frame. */
export const FireFluidStepUniform = defineUniformStruct('FireFluidStep', {
  dye_size: 'vec2u',
  grid: 'vec2u',
  dt: 'f32',
  time: 'f32',
  seed: 'u32',
  aspect: 'f32',
  source_count: 'u32',
  fuel_rate: 'f32',
  bed_temperature: 'f32',
  lumps: 'f32',
  lump_scale: 'f32',
  lump_rise: 'f32',
  ignition: 'f32',
  soft: 'f32',
  burn: 'f32',
  heat: 'f32',
  soot: 'f32',
  radiation: 'f32',
  torch_fuel: 'f32',
  torch_heat: 'f32',
  t_max: 'f32',
  f_max: 'f32',
  s_max: 'f32',
  r_max: 'f32',
  expansion: 'f32',
  source_max: 'f32',
  turbulence: 'f32',
  turb_scale: 'f32',
  turb_rise: 'f32',
  open_edges: 'u32',
  source_a: uniformArray('vec4f', FIRE_FLUID_MAX_SOURCES),
  source_b: uniformArray('vec4f', FIRE_FLUID_MAX_SOURCES),
});

export interface FireFluidOptions {
  device: GPUDevice;
  /** Attach to this solver instead of making one (its hooks are taken over; it is not destroyed). */
  fluid?: Fluid;
  /** For a solver made here: cells along the long side (default 128), dye texels (default 4 x). */
  resolution?: number;
  dyeResolution?: number;
  /** Canvas size, for the aspect. */
  width?: number;
  height?: number;
  params?: Partial<FireFluidParams>;
  /** Most steps one `update` runs. Default 3. */
  maxStepsPerFrame?: number;
  profiler?: PassProfiler;
  label?: string;
}

export interface FireFluid {
  readonly params: FireFluidParams;
  /** The solver underneath. `update` sets the parameters of `fireFluidSolverParams`; the rest are yours. */
  readonly fluid: Fluid;
  readonly grid: FluidGrid;
  /** r = temperature, g = fuel, b = soot, a = burn rate. Changes every step: cache by `slot` and `generation`. */
  readonly dye: FluidTexture;
  /** The expansion source of the last step (r32float, one texel per velocity cell, 1 / s; textureLoad). */
  readonly expansionSource: GPUTexture;
  /** Bumps whenever the solver's textures are re-created. */
  readonly generation: number;
  /** Simulated seconds so far. */
  readonly time: number;
  /** Steps run by the last update. */
  readonly lastSteps: number;
  /**
   * Where heat comes from besides the burners: `torches` add fuel (`torchFuel`) and hold `torchHeat`
   * (pointer igniters: press and drag to spray burning fuel), `embers` only hold their own strength as a
   * temperature (stray embers that relight a burner). Collected once per update that runs steps.
   */
  readonly ignition: { torches: IgnitionSource[]; embers: IgnitionSource[] };
  readonly sources: readonly FireFluidSource[];
  setSources(sources: readonly FireFluidSource[]): void;
  /** Lays a fire already burning over the burners (an upload: no GPU work is encoded). */
  seed(): void;
  /** Advances by `delta` seconds of wall time at the solver's step rate. Returns the steps run. */
  update(encoder: GPUCommandEncoder, delta: number): number;
  /** Runs exactly `steps` steps (tests, benchmarks). */
  advance(encoder: GPUCommandEncoder, steps: number): void;
  destroy(): void;
}

const finiteOr = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const nonNegative = (x: number) => Math.max(0, finiteOr(x, 0));

/** The solver parameters the fire sets on every update, from its own. */
export function fireFluidSolverParams(p: FireFluidParams): Partial<FluidParams> {
  const wind = clamp(finiteOr(p.wind, 0), -2, 2);
  const length = Math.hypot(wind, 1);
  const closedEdges: FluidEdge[] = p.floor ? ['bottom'] : [];
  return {
    boundary: 'open',
    closedEdges,
    buoyancy: nonNegative(p.buoyancy) * length,
    buoyancyDirection: [wind / length, -1 / length],
    buoyancyWeights: [1, 0, -nonNegative(p.sootWeight), 0],
    dyeDissipation: [nonNegative(p.cooling), nonNegative(p.fuelFade), nonNegative(p.sootFade), 0],
    dyeLimit: 16,
    vorticity: nonNegative(p.vorticity),
    velocityDissipation: nonNegative(p.velocityDissipation),
    velocityScheme: p.scheme,
    dyeScheme: p.scheme,
    gravity: [0, 0],
  };
}

// --- Pipelines, cached per device -------------------------------------------------------------------

interface Pipelines {
  react: GPUComputePipeline;
  expand: GPUComputePipeline;
  turbulence: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Pipelines>();

function getPipelines(device: GPUDevice): Pipelines {
  let found = pipelineCache.get(device);
  if (!found) {
    const chunks = { 'fire-fluid-params.wgsl': FireFluidStepUniform.wgsl };
    const make = (source: typeof reactShader, entryPoint: string) =>
      device.createComputePipeline({
        label: `fire-fluid ${entryPoint}`,
        layout: 'auto',
        compute: { module: createShader(device, withChunks(source, chunks)), entryPoint },
      });
    found = {
      react: make(reactShader, 'cs_react'),
      expand: make(expandShader, 'cs_expand'),
      turbulence: make(turbulenceShader, 'cs_turbulence'),
    };
    pipelineCache.set(device, found);
  }
  return found;
}

let nextId = 1;
const ids = new WeakMap<object, number>();
const idOf = (object: object) => {
  let id = ids.get(object);
  if (id === undefined) ids.set(object, (id = nextId++));
  return id;
};

/** The `open_edges` mask of the turbulence fade: every edge but a floor. */
const openEdges = (p: FireFluidParams) => (p.floor ? 1 | 2 | 4 : 1 | 2 | 4 | 8);

export function createFireFluid(options: FireFluidOptions): FireFluid {
  const { device, maxStepsPerFrame = 3, profiler = noProfiler, label = 'fire-fluid' } = options;
  const params: FireFluidParams = { ...DEFAULT_FIRE_FLUID_PARAMS, ...options.params };
  const owned = !options.fluid;
  const resolution = options.resolution ?? 128;
  const fluid =
    options.fluid ??
    createFluid({
      device,
      resolution,
      dyeResolution: options.dyeResolution ?? Math.min(1024, resolution * 4),
      width: options.width,
      height: options.height,
      params: { ...fireFluidSolverParams(params), pressureSolver: 'jacobi' },
      maxStepsPerFrame,
      profiler,
      label,
    });
  Object.assign(fluid.params, fireFluidSolverParams(params));

  const pipelines = getPipelines(device);
  const noise = getNoiseTexture(device);
  const sampler = device.createSampler({
    label: `${label} dye sampler`,
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const torchUniforms = createUniformBuffer(device, IgnitersUniform, `${label} torches`);
  const emberUniforms = createUniformBuffer(device, IgnitersUniform, `${label} embers`);
  // One uniform buffer per step index: every upload lands before the command buffer runs, so steps
  // encoded in the same frame would otherwise all see the last one's seed and time.
  const stepUniforms: UniformBuffer<typeof FireFluidStepUniform.fields>[] = [];
  const uniformFor = (step: number) => {
    while (stepUniforms.length <= step) {
      stepUniforms.push(
        createUniformBuffer(device, FireFluidStepUniform, `${label} step ${stepUniforms.length}`),
      );
    }
    return stepUniforms[step]!;
  };

  let sources: FireFluidSource[] = [];
  const ignition = { torches: [] as IgnitionSource[], embers: [] as IgnitionSource[] };
  let simTime = 0;
  let stepCount = 0;
  let lastSteps = 0;
  /** Index, within the current `advance`, of the step whose hooks run next. */
  let stepInRun = 0;
  let groups = new Map<string, GPUBindGroup>();
  let groupGeneration = -1;
  let copy: GPUTexture | undefined;
  let copyView: GPUTextureView | undefined;

  function ensureCopy(grid: FluidGrid) {
    if (copy && copy.width === grid.width && copy.height === grid.height) return;
    copy?.destroy();
    copy = device.createTexture({
      label: `${label} expansion source`,
      size: [grid.width, grid.height],
      format: 'r32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    copyView = copy.createView();
  }
  ensureCopy(fluid.grid);

  function group(
    pipeline: GPUComputePipeline,
    kind: string,
    step: number,
    entries: (GPUTextureView | GPUBuffer | GPUSampler)[],
  ): GPUBindGroup {
    if (groupGeneration !== fluid.generation) {
      groups = new Map();
      groupGeneration = fluid.generation;
    }
    const key = `${kind}@${step}|${entries.map(idOf).join(',')}`;
    let found = groups.get(key);
    if (!found) {
      found = device.createBindGroup({
        label: `${label} ${kind}`,
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map((resource, binding) => ({
          binding,
          resource: 'size' in resource ? { buffer: resource } : resource,
        })),
      });
      groups.set(key, found);
    }
    return found;
  }

  function timestamp(name: string): GPUComputePassTimestampWrites | undefined {
    return stepInRun === 0
      ? (profiler.pass(name) as GPUComputePassTimestampWrites | undefined)
      : undefined;
  }

  fluid.hooks.forces = ({ encoder, read, write, dye, grid }) => {
    if (!(params.turbulence > 0)) return false;
    const uniforms = uniformFor(stepInRun);
    const pass = encoder.beginComputePass({
      label: `${label} turbulence`,
      timestampWrites: timestamp('turbulence'),
    });
    pass.setPipeline(pipelines.turbulence);
    pass.setBindGroup(
      0,
      group(pipelines.turbulence, 'turbulence', stepInRun, [
        uniforms.buffer,
        read,
        write,
        dye,
        sampler,
        noise.view,
        noise.sampler,
      ]),
    );
    pass.dispatchWorkgroups(
      Math.ceil(grid.velocityWidth / 16),
      Math.ceil(grid.velocityHeight / 16),
    );
    pass.end();
    return true;
  };

  fluid.hooks.divergence = ({ encoder, write, dye, grid }) => {
    ensureCopy(grid);
    const uniforms = uniformFor(stepInRun);
    const pass = encoder.beginComputePass({
      label: `${label} expansion`,
      timestampWrites: timestamp('expansion'),
    });
    pass.setPipeline(pipelines.expand);
    pass.setBindGroup(
      0,
      group(pipelines.expand, 'expand', stepInRun, [
        uniforms.buffer,
        dye,
        sampler,
        write,
        copyView!,
      ]),
    );
    pass.dispatchWorkgroups(Math.ceil(grid.width / 16), Math.ceil(grid.height / 16));
    pass.end();
    return true;
  };

  fluid.hooks.dye = ({ encoder, read, write, grid }) => {
    const uniforms = uniformFor(stepInRun);
    const pass = encoder.beginComputePass({
      label: `${label} combustion`,
      timestampWrites: timestamp('combustion'),
    });
    pass.setPipeline(pipelines.react);
    pass.setBindGroup(
      0,
      group(pipelines.react, 'react', stepInRun, [
        uniforms.buffer,
        torchUniforms.buffer,
        emberUniforms.buffer,
        read,
        write,
        noise.view,
        noise.sampler,
      ]),
    );
    pass.dispatchWorkgroups(Math.ceil(grid.dyeWidth / 16), Math.ceil(grid.dyeHeight / 16));
    pass.end();
    stepInRun++;
    return true;
  };

  function writeStep(uniforms: UniformBuffer<typeof FireFluidStepUniform.fields>, step: number) {
    const dt = fluid.stepSeconds;
    const grid = fluid.grid;
    const count = Math.min(sources.length, FIRE_FLUID_MAX_SOURCES);
    const a = new Float32Array(FIRE_FLUID_MAX_SOURCES * 4);
    const b = new Float32Array(FIRE_FLUID_MAX_SOURCES * 4);
    for (let i = 0; i < count; i++) {
      const s = sources[i]!;
      a.set([s.from[0], s.from[1], s.to[0], s.to[1]], i * 4);
      b.set([Math.max(s.radius, 1e-4), nonNegative(s.fuel), nonNegative(s.bed ?? 1), 0], i * 4);
    }
    uniforms.set({
      dye_size: [grid.dyeWidth, grid.dyeHeight],
      grid: [grid.width, grid.height],
      dt,
      // Wrapped so the noise keeps its precision in a long session (a jump once every ~17 minutes).
      time: (simTime + step * dt) % 1000,
      seed: (stepCount + step) >>> 0,
      aspect: grid.aspect,
      source_count: count,
      fuel_rate: nonNegative(params.fuelRate),
      bed_temperature: nonNegative(params.bedTemperature),
      lumps: clamp(finiteOr(params.lumps, 0), 0, 2),
      lump_scale: Math.max(finiteOr(params.lumpScale, 0.06), 0.005),
      lump_rise: finiteOr(params.lumpRise, 0.5),
      ignition: nonNegative(params.ignition),
      soft: Math.max(finiteOr(params.soft, 0.3), 1e-3),
      burn: nonNegative(params.burnRate),
      heat: nonNegative(params.heat),
      soot: nonNegative(params.soot),
      radiation: nonNegative(params.radiation),
      torch_fuel: nonNegative(params.torchFuel),
      torch_heat: nonNegative(params.torchHeat),
      t_max: FIRE_FLUID_LIMITS.temperature,
      f_max: FIRE_FLUID_LIMITS.fuel,
      s_max: FIRE_FLUID_LIMITS.soot,
      r_max: FIRE_FLUID_LIMITS.rate,
      expansion: nonNegative(params.expansion),
      source_max: SOURCE_MAX,
      turbulence: nonNegative(params.turbulence),
      turb_scale: clamp(finiteOr(params.turbulenceScale, 8), 2, 64),
      turb_rise: finiteOr(params.turbulenceRise, 0.4),
      open_edges: openEdges(params),
      source_a: a,
      source_b: b,
    });
    uniforms.upload();
  }

  /** What the torches and embers report for these seconds; the torches' drags also push the gas. */
  function collect(seconds: number) {
    const aspect = fluid.grid.aspect;
    const torches: Igniter[] = collectIgniters(seconds, ...ignition.torches);
    const embers: Igniter[] = collectIgniters(seconds, ...ignition.embers);
    writeIgniters(torchUniforms, torches, aspect);
    writeIgniters(emberUniforms, embers, aspect);
    torchUniforms.upload();
    emberUniforms.upload();
    const push = clamp(finiteOr(params.torchPush, 0), 0, 1);
    if (push > 0 && seconds > 0) {
      for (const t of torches) {
        const dx = (t.toX - t.fromX) * aspect;
        const dy = t.toY - t.fromY;
        if (dx === 0 && dy === 0) continue;
        // The drag's speed in image heights per second, capped so a flick is not a shock wave.
        const speed = Math.min(3, Math.hypot(dx, dy) / seconds);
        const scale = (push * speed) / Math.hypot(dx, dy);
        fluid.addForce([t.fromX, t.fromY], [t.toX, t.toY], t.radius * 0.8, [
          dx * scale,
          dy * scale,
        ]);
      }
    }
  }

  function run(encoder: GPUCommandEncoder, steps: number) {
    Object.assign(fluid.params, fireFluidSolverParams(params));
    const count = Math.max(0, Math.floor(finiteOr(steps, 0)));
    lastSteps = count;
    const dt = fluid.stepSeconds;
    if (count > 0) {
      collect(count * dt);
      // A gas jet: an upward acceleration over its nozzle, in proportion to the time simulated.
      for (const s of sources) {
        const jet = nonNegative(s.jet ?? 0);
        if (jet <= 0) continue;
        fluid.addForce(s.from, s.to, s.radius * 1.5, [0, -jet * Math.min(1, count * dt * 6)]);
      }
    }
    for (let i = 0; i < count; i++) writeStep(uniformFor(i), i);
    stepInRun = 0;
    fluid.advance(encoder, count);
    simTime += count * dt;
    stepCount += count;
  }

  let stepper: FixedStepper | undefined;
  let stepperSeconds = 0;

  return {
    params,
    fluid,
    ignition,
    get grid() {
      return fluid.grid;
    },
    get dye() {
      return fluid.dye;
    },
    get expansionSource() {
      ensureCopy(fluid.grid);
      return copy!;
    },
    get generation() {
      return fluid.generation;
    },
    get time() {
      return simTime;
    },
    get lastSteps() {
      return lastSteps;
    },
    get sources() {
      return sources;
    },
    setSources(next) {
      sources = next.slice(0, FIRE_FLUID_MAX_SOURCES).map((s) => ({ ...s }));
    },
    seed() {
      const aspect = fluid.grid.aspect;
      // A tongue of flame over each burner: as wide as the burner at its base, narrowing to a point
      // 0.3 image heights up and cooling on the way. The fuel starts as a thin layer on the burner.
      const tongue = (x: number, y: number): { flame: number; fuel: number } => {
        let flame = 0;
        let fuel = 0;
        const px = x * aspect;
        for (const s of sources) {
          const ax = s.from[0] * aspect;
          const bx = s.to[0] * aspect;
          const share = Math.min(nonNegative(s.fuel), 1.5);
          const cx = (ax + bx) / 2;
          const cy = (s.from[1] + s.to[1]) / 2;
          const up = cy - y;
          // Distance to the burner itself, for the fuel layer.
          const t = bx === ax ? 0 : clamp((px - ax) / (bx - ax), 0, 1);
          const near = Math.hypot(
            px - (ax + (bx - ax) * t),
            y - (s.from[1] + (s.to[1] - s.from[1]) * t),
          );
          fuel = Math.max(fuel, share * Math.exp(-((near / s.radius) ** 2)));
          if (up < -2 * s.radius) continue;
          const rise = Math.max(up, 0) / 0.3;
          if (rise >= 1) continue;
          const half = Math.abs(bx - ax) / 2 + s.radius;
          const width = half * (1 - rise);
          const across = Math.exp(-(((px - cx) / width) ** 4));
          const below = Math.exp(-((Math.min(up, 0) / s.radius) ** 2));
          flame = Math.max(flame, share * across * below * (1 - rise) ** 0.7);
        }
        return { flame: Math.min(flame, 1), fuel };
      };
      fluid.setDye((x, y) => {
        const { flame, fuel } = tongue(x, y);
        return [2.8 * flame, 0.3 * fuel, 0.3 * params.soot * flame, 0];
      });
      fluid.setVelocity((x, y) => [0, -0.6 * tongue(x, y).flame]);
    },
    update(encoder, delta) {
      const dt = fluid.stepSeconds;
      if (!stepper || Math.abs(dt - stepperSeconds) > dt * 1e-3) {
        stepper = createFixedStepper(dt, { maxSteps: maxStepsPerFrame });
        stepperSeconds = dt;
      }
      const { steps } = stepper.advance(Number.isFinite(delta) ? delta : 0);
      run(encoder, steps);
      return steps;
    },
    advance(encoder, steps) {
      run(encoder, steps);
    },
    destroy() {
      fluid.hooks.forces = undefined;
      fluid.hooks.divergence = undefined;
      fluid.hooks.dye = undefined;
      if (owned) fluid.destroy();
      for (const u of stepUniforms) u.destroy();
      torchUniforms.destroy();
      emberUniforms.destroy();
      copy?.destroy();
    },
  };
}
