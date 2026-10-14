import { createFixedStepper, type FixedStepper } from '../loop.ts';
import { noProfiler, type PassProfiler } from '../profiler.ts';
import { createShader, withChunks } from '../shader.ts';
import {
  createUniformBuffer,
  defineUniformStruct,
  uniformArray,
  type UniformBuffer,
} from '../uniforms.ts';
import reactShader from './fire3d-react.wgsl';
import {
  createFluid3d,
  type Fluid3d,
  type Fluid3dGrid,
  type Fluid3dParams,
  type Fluid3dTexture,
} from './fluid3d.ts';

/*
 * Fire in a 3D grid (story 6.11): the stable-fluids solver of fluid3d.ts carrying temperature, fuel and
 * smoke, with a combustion step after every advection (fire3d-react.wgsl). The model follows Nguyen,
 * Fedkiw and Jensen (2002) in its parts, simplified the way Crane, Llamas and Tariq (GPU Gems 3, ch. 30)
 * simplify it for a GPU: no level set for the blue core, just fields.
 *
 *   fuel F      injected at source capsules (logs, a burner), burns above an ignition temperature
 *   heat T      released by burning, lifts the gas (buoyancy), lost to the surroundings and by radiation
 *   smoke S     soot produced by burning, slightly heavy, thins out slowly
 *   rate R      fuel burnt per second: the gas expands where it burns (a divergence source)
 *
 * One solver step is: advect velocity -> buoyancy (T lifts, S weighs; leaning with `wind`) and vorticity
 * confinement -> pressure projection with the expansion source and an open top -> advect the four fields
 * (MacCormack) -> burn. The step runs on a fixed clock of its own (`stepRate`), independent of the display.
 *
 *   const fire = createFire3d({ device, resolution: 48, size: [2 / 3, 1, 2 / 3] });
 *   fire.setSources([{ from: [0.3, 0.05, 0.33], to: [0.37, 0.05, 0.33], radius: 0.03, fuel: 1 }]);
 *   fire.seed();                          // a lit fire, so the first frame is not an empty box
 *   // every frame:
 *   fire.update(encoder, delta);
 *   // sample fire.fields.view: r = T, g = F, b = S, a = R (cache bind groups by slot and generation)
 *
 * Positions are in the solver's length units: the box is [0, grid.size], y up, the longest side 1.
 * Heat and fuel come in through `addHeat` (the effect turns the shared ignition layer's pointer and
 * ambient embers into calls of it).
 */

/** Source capsules the combustion step reads. */
export const FIRE3D_MAX_SOURCES = 4;
/** Bounds the combustion step clamps to (temperature in units of 1000 K above ambient). */
export const FIRE3D_LIMITS = { temperature: 2.2, fuel: 4, smoke: 8, rate: 32 } as const;

type Vec3 = readonly [number, number, number];

/** A place fuel comes from: a capsule from `from` to `to` with a Gaussian edge of `radius`. */
export interface Fire3dSource {
  from: Vec3;
  to: Vec3;
  radius: number;
  /** Share of `fuelRate` this source emits at its centre. */
  fuel: number;
  /** Upward speed it pushes the gas at (a gas burner's jet), length per second. 0 for none. */
  jet?: number;
}

/** Live parameters, read on every update. */
export interface Fire3dParams {
  /** Simulation steps per second. Default 30. */
  stepRate: number;
  /** Fuel per second a source emits at weight 1. */
  fuelRate: number;
  /** Rate at which fuel above the ignition temperature burns, per second. */
  burn: number;
  /** Temperature at which burning starts, and the width over which it switches fully on. */
  ignition: number;
  soft: number;
  /** Temperature released per unit of fuel burnt. */
  heat: number;
  /** Smoke produced per unit of fuel burnt. */
  soot: number;
  /** Temperature the source keeps (glowing logs, a pilot); 0 lets only igniters light it. */
  bedTemperature: number;
  /** Heat loss, per second, at the floor; `heightCooling` is added in proportion to height. */
  cooling: number;
  heightCooling: number;
  /** Radiative loss: dT/dt = -radiation T^4. */
  radiation: number;
  /** Decay rates of smoke and of unburnt fuel, per second. */
  smokeDecay: number;
  fuelDecay: number;
  /** Upward acceleration per unit of temperature, length per second squared. */
  buoyancy: number;
  /** Downward pull of smoke per unit, as a share of the lift of one unit of temperature. */
  smokeWeight: number;
  /** Divergence per unit of burn rate (1 / s per unit of fuel burnt per second): gas expanding as it burns. */
  expansion: number;
  /** Sideways lean of the buoyancy, as a share of the lift (x direction). */
  wind: number;
  /** Vorticity confinement, 1 / s. */
  vorticity: number;
  /** Velocity decay, 1 / s. */
  velocityDissipation: number;
  /** Lumpiness of the fuel supply: noise frequency (per length unit), rise speed and depth. */
  noiseScale: number;
  noiseRise: number;
  noiseAmount: number;
}

export const DEFAULT_FIRE3D_PARAMS: Readonly<Fire3dParams> = {
  stepRate: 30,
  fuelRate: 5,
  burn: 7,
  ignition: 0.35,
  soft: 0.2,
  heat: 1.4,
  soot: 0.3,
  bedTemperature: 0.7,
  cooling: 0.5,
  heightCooling: 1.6,
  radiation: 0.35,
  smokeDecay: 0.25,
  fuelDecay: 0.6,
  buoyancy: 2.6,
  smokeWeight: 0.1,
  expansion: 0.6,
  wind: 0,
  vorticity: 3,
  velocityDissipation: 0.3,
  noiseScale: 14,
  noiseRise: 1.2,
  noiseAmount: 0.9,
};

export const Fire3dReactUniform = defineUniformStruct('Fire3dReact', {
  scalar_size: 'vec3u',
  source_count: 'u32',
  size: 'vec3f',
  dt: 'f32',
  time: 'f32',
  seed: 'u32',
  fuel_rate: 'f32',
  burn: 'f32',
  ignition: 'f32',
  soft: 'f32',
  heat: 'f32',
  soot: 'f32',
  bed_temperature: 'f32',
  cool: 'f32',
  cool_height: 'f32',
  radiate: 'f32',
  smoke_decay: 'f32',
  fuel_decay: 'f32',
  sponge: 'f32',
  sponge_depth: 'f32',
  noise_scale: 'f32',
  noise_rise: 'f32',
  noise_amount: 'f32',
  t_max: 'f32',
  f_max: 'f32',
  s_max: 'f32',
  r_max: 'f32',
  source_a: uniformArray('vec4f', FIRE3D_MAX_SOURCES),
  source_b: uniformArray('vec4f', FIRE3D_MAX_SOURCES),
});

export interface Fire3dOptions {
  device: GPUDevice;
  /** Cells along the longest side of the velocity grid. Default 48. */
  resolution?: number;
  /** Texels along the longest side of the field grid. Default 64. */
  scalarResolution?: number;
  /** Relative extents of the box. Default [2/3, 1, 2/3]: a tall box for a plume. */
  size?: Vec3;
  params?: Partial<Fire3dParams>;
  /** Most steps one `update` runs. Default 3. */
  maxStepsPerFrame?: number;
  profiler?: PassProfiler;
  label?: string;
}

export interface Fire3d {
  readonly params: Fire3dParams;
  /** The solver underneath, for its grid, velocity and pressure (do not change its params: `update` sets them). */
  readonly fluid: Fluid3d;
  readonly grid: Fluid3dGrid;
  /** r = temperature, g = fuel, b = smoke, a = burn rate; rgba16float, filterable. Changes every step. */
  readonly fields: Fluid3dTexture;
  /** Bumps whenever the textures are re-created. */
  readonly generation: number;
  /** Simulated seconds so far. */
  readonly time: number;
  setSources(sources: readonly Fire3dSource[]): void;
  /**
   * Queues heat (and fuel) along a segment, Gaussian footprint `radius`, applied before the next step.
   * False if the queue is full or an argument is not finite.
   */
  addHeat(from: Vec3, to: Vec3, radius: number, heat: number, fuel?: number): boolean;
  /** Fills the box with a fire already burning over the sources (no GPU work: a texture upload). */
  seed(): void;
  /** Advances by `delta` seconds of wall time at the fixed step rate. Returns the steps run. */
  update(encoder: GPUCommandEncoder, delta: number): number;
  /** Runs exactly `steps` steps (tests, benchmarks). */
  advance(encoder: GPUCommandEncoder, steps: number): void;
  setResolution(cells: number, scalarCells?: number): boolean;
  reset(): void;
  destroy(): void;
}

const finiteOr = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const nonNegative = (x: number) => Math.max(0, finiteOr(x, 0));

/** The solver parameters the fire needs, from its own. */
export function fire3dFluidParams(p: Fire3dParams): Partial<Fluid3dParams> {
  const wind = finiteOr(p.wind, 0);
  const length = Math.hypot(wind, 1);
  return {
    stepRate: clamp(finiteOr(p.stepRate, 30), 10, 120),
    buoyancy: nonNegative(p.buoyancy) * length,
    buoyancyDirection: [wind / length, 1 / length, 0],
    buoyancyWeights: [1, 0, -nonNegative(p.smokeWeight), 0],
    divergenceWeights: [0, 0, 0, nonNegative(p.expansion)],
    openTop: true,
    openSides: true,
    vorticity: nonNegative(p.vorticity),
    velocityDissipation: nonNegative(p.velocityDissipation),
    scalarDissipation: 0,
    scalarScheme: 'maccormack',
    velocityScheme: 'semi-lagrangian',
    gravity: [0, 0, 0],
  };
}

export function createFire3d(options: Fire3dOptions): Fire3d {
  const {
    device,
    maxStepsPerFrame = 3,
    profiler = noProfiler,
    label = 'fire3d',
    size = [2 / 3, 1, 2 / 3],
  } = options;
  const params: Fire3dParams = { ...DEFAULT_FIRE3D_PARAMS, ...options.params };

  const pipeline = device.createComputePipeline({
    label: `${label} react`,
    layout: 'auto',
    compute: {
      module: createShader(
        device,
        withChunks(reactShader, { 'fire3d-params.wgsl': Fire3dReactUniform.wgsl }),
      ),
      entryPoint: 'cs_react',
    },
  });

  // One uniform buffer per step index: every upload lands before the command buffer runs, so steps
  // encoded in the same frame would otherwise all see the last one's seed and time.
  const stepUniforms: UniformBuffer<typeof Fire3dReactUniform.fields>[] = [];
  const uniformFor = (step: number) => {
    while (stepUniforms.length <= step) {
      stepUniforms.push(
        createUniformBuffer(device, Fire3dReactUniform, `${label} react ${stepUniforms.length}`),
      );
    }
    return stepUniforms[step]!;
  };

  let sources: Fire3dSource[] = [];
  let simTime = 0;
  let stepCount = 0;
  let groups = new Map<string, GPUBindGroup>();
  let groupGeneration = -1;

  const fluid = createFluid3d({
    device,
    resolution: options.resolution ?? 48,
    scalarResolution: options.scalarResolution ?? 64,
    size,
    params: {
      ...fire3dFluidParams(params),
      pressureSolver: 'multigrid',
      pressureIterations: 1,
      scalarLimit: 64,
    },
    maxStepsPerFrame,
    profiler,
    label,
    reaction: {
      encode(pass, src, dst, step) {
        if (groupGeneration !== fluid.generation) {
          groups = new Map();
          groupGeneration = fluid.generation;
        }
        const uniforms = uniformFor(step);
        writeStep(uniforms, step);
        const key = `${src.slot}>${dst.slot}@${step}`;
        let group = groups.get(key);
        if (!group) {
          group = device.createBindGroup({
            label: `${label} react`,
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniforms.buffer } },
              { binding: 1, resource: src.view },
              { binding: 2, resource: dst.view },
            ],
          });
          groups.set(key, group);
        }
        const [sx, sy, sz] = fluid.grid.scalarSize;
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(sx / 4), Math.ceil(sy / 4), Math.ceil(sz / 4));
      },
    },
  });

  function writeStep(uniforms: UniformBuffer<typeof Fire3dReactUniform.fields>, step: number) {
    const dt = fluid.stepSeconds;
    const grid = fluid.grid;
    const count = Math.min(sources.length, FIRE3D_MAX_SOURCES);
    const a = new Float32Array(FIRE3D_MAX_SOURCES * 4);
    const b = new Float32Array(FIRE3D_MAX_SOURCES * 4);
    for (let i = 0; i < count; i++) {
      const s = sources[i]!;
      a.set([s.from[0], s.from[1], s.from[2], Math.max(s.radius, 1e-4)], i * 4);
      b.set([s.to[0], s.to[1], s.to[2], nonNegative(s.fuel)], i * 4);
    }
    uniforms.set({
      scalar_size: grid.scalarSize as [number, number, number],
      source_count: count,
      size: grid.size as [number, number, number],
      dt,
      // Wrapped so the noise keeps its precision in a long session; the noise has no period, so the
      // wrap is a jump in the pattern once every quarter of an hour.
      time: (simTime + step * dt) % 1000,
      seed: (stepCount + step) >>> 0,
      fuel_rate: nonNegative(params.fuelRate),
      burn: nonNegative(params.burn),
      ignition: nonNegative(params.ignition),
      soft: Math.max(finiteOr(params.soft, 0.2), 1e-3),
      heat: nonNegative(params.heat),
      soot: nonNegative(params.soot),
      bed_temperature: nonNegative(params.bedTemperature),
      cool: nonNegative(params.cooling),
      cool_height: nonNegative(params.heightCooling),
      radiate: nonNegative(params.radiation),
      smoke_decay: nonNegative(params.smokeDecay),
      fuel_decay: nonNegative(params.fuelDecay),
      sponge: 6,
      sponge_depth: 0.15,
      noise_scale: nonNegative(params.noiseScale),
      noise_rise: finiteOr(params.noiseRise, 1),
      noise_amount: nonNegative(params.noiseAmount),
      t_max: FIRE3D_LIMITS.temperature,
      f_max: FIRE3D_LIMITS.fuel,
      s_max: FIRE3D_LIMITS.smoke,
      r_max: FIRE3D_LIMITS.rate,
      source_a: a,
      source_b: b,
    });
    uniforms.upload();
  }

  let stepper: FixedStepper | undefined;
  let stepperSeconds = 0;

  function run(encoder: GPUCommandEncoder, steps: number) {
    Object.assign(fluid.params, fire3dFluidParams(params));
    const count = Math.max(0, Math.floor(finiteOr(steps, 0)));
    const dt = fluid.stepSeconds;
    // A burner's jet: an upward push near its nozzle, in proportion to the time simulated.
    if (count > 0) {
      for (const s of sources) {
        const jet = nonNegative(s.jet ?? 0);
        if (jet <= 0) continue;
        fluid.addImpulse(s.from, s.to, s.radius * 1.5, [0, jet * Math.min(1, count * dt * 8), 0]);
      }
    }
    fluid.advance(encoder, count);
    simTime += count * dt;
    stepCount += count;
  }

  return {
    params,
    fluid,
    get grid() {
      return fluid.grid;
    },
    get fields() {
      return fluid.density;
    },
    get generation() {
      return fluid.generation;
    },
    get time() {
      return simTime;
    },
    setSources(next) {
      sources = next.slice(0, FIRE3D_MAX_SOURCES).map((s) => ({ ...s }));
    },
    addHeat(from, to, radius, heat, fuel = 0) {
      return fluid.addDensity(from, to, radius, [heat, fuel, 0, 0], radius);
    },
    seed() {
      const h = fluid.grid.size[1];
      const weight = (x: number, y: number, z: number) => {
        let best = 0;
        for (const s of sources) {
          // Distance from the source's middle in the horizontal plane, and height above it.
          const cx = (s.from[0] + s.to[0]) / 2;
          const cz = (s.from[2] + s.to[2]) / 2;
          const cy = (s.from[1] + s.to[1]) / 2;
          const r = Math.hypot(x - cx, z - cz);
          const up = y - cy;
          if (up < -s.radius * 2) continue;
          const width = 0.06 + 0.08 * Math.max(up, 0);
          best = Math.max(best, Math.exp(-((r / width) ** 2)) * Math.exp(-Math.max(up, 0) / 0.35));
        }
        return best;
      };
      fluid.setDensity((x, y, z) => {
        const f = weight(x, y, z);
        const up = y / h;
        return [1.5 * f, 0.4 * f * Math.exp(-up / 0.1), 0.6 * f * up, 0];
      });
      fluid.setVelocity((x, y, z) => [0, 0.8 * weight(x, y, z), 0]);
    },
    update(encoder, delta) {
      // The solver's own step rate follows ours.
      fluid.params.stepRate = clamp(finiteOr(params.stepRate, 30), 10, 120);
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
    setResolution(cells, scalarCells) {
      return fluid.setResolution(cells, scalarCells);
    },
    reset() {
      fluid.reset();
      simTime = 0;
      stepCount = 0;
    },
    destroy() {
      fluid.destroy();
      for (const u of stepUniforms) u.destroy();
    },
  };
}
