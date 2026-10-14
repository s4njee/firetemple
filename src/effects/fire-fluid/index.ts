import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createFireFluid, type FireFluid, type FireFluidSource } from '../../gpu/sim/fire-fluid.ts';
import type { FluidScheme } from '../../gpu/sim/fluid.ts';
import {
  createAmbientIgnition,
  createPointerIgnition,
  type Igniter,
  type IgnitionSource,
  type PointerIgnition,
} from '../../gpu/sim/ignition.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import shader from './scene.wgsl';

// Stories 6.2 to 6.7: fire as a fluid. The combustion layer (temperature, fuel, soot, the reaction,
// buoyancy, expansion, turbulence and the emitters) is src/gpu/sim/fire-fluid.ts on the stable-fluids
// solver of fluid.ts; this file chooses burners, colours and presets, and scene.wgsl draws the fields.

const Params = defineUniformStruct('Params', {
  grid: 'vec2f',
  light_pos: 'vec2f',
  light_colour: 'vec3f',
  aspect: 'f32',
  reaction_tint: 'vec3f',
  view: 'f32',
  palette: 'f32',
  kelvin_per_unit: 'f32',
  kelvin_ref: 'f32',
  flame: 'f32',
  emissivity: 'f32',
  knee: 'f32',
  reaction_glow: 'f32',
  premix: 'f32',
  opacity: 'f32',
  sootiness: 'f32',
  light_radius: 'f32',
  debug_gain: 'f32',
});

const VIEWS = [
  'fire',
  'temperature',
  'fuel',
  'soot',
  'reaction',
  'expansion',
  'velocity',
  'vorticity',
] as const;
const BURNERS = ['logs', 'line', 'ring', 'jet', 'none'] as const;
type Burner = (typeof BURNERS)[number];
/** Index = `palette` in scene.wgsl: 0 is the black body, 1.. are ramp_select kinds (gas, copper, ...). */
const PALETTES = ['wood', 'gas', 'copper', 'sodium', 'potassium', 'lithium'] as const;
const SCHEMES = ['maccormack', 'bfecc', 'semi-lagrangian'] as const;
const RESOLUTIONS = ['96', '128', '160', '192'] as const;

/** How much of the calm fuel rate a full drive level adds. */
const DRIVE_FUEL = 0.4;
/** Seconds without a press before the autopilot torch takes over (when it is on). */
const AUTOPILOT_WAIT = 1.5;

/** The burners of each kind, in uv, for a canvas of this aspect (lengths are image heights). */
export function burnerSources(kind: Burner, aspect: number): FireFluidSource[] {
  const a = Math.max(aspect, 0.2);
  const x = (offset: number) => 0.5 + offset / a;
  switch (kind) {
    case 'logs': {
      // A row of four logs on the floor, their ends charred less than their middles.
      const logs: FireFluidSource[] = [];
      for (let i = 0; i < 4; i++) {
        const centre = (i - 1.5) * 0.15;
        logs.push({
          from: [x(centre - 0.055), 0.955 - 0.012 * (i % 2)],
          to: [x(centre + 0.055), 0.95 - 0.012 * ((i + 1) % 2)],
          radius: 0.022,
          fuel: i === 1 || i === 2 ? 1 : 0.75,
        });
      }
      return logs;
    }
    case 'line': {
      // A strip burner along the bottom, most of the canvas wide.
      const half = Math.min(0.42 * a, 1.4) / a;
      return [{ from: [0.5 - half, 0.965], to: [0.5 + half, 0.965], radius: 0.014, fuel: 0.55 }];
    }
    case 'ring': {
      const ring: FireFluidSource[] = [];
      const n = 12;
      const radius = 0.2;
      for (let i = 0; i < n; i++) {
        const t0 = (i / n) * 2 * Math.PI;
        const t1 = ((i + 1) / n) * 2 * Math.PI;
        ring.push({
          from: [x(radius * Math.cos(t0)), 0.56 + radius * Math.sin(t0)],
          to: [x(radius * Math.cos(t1)), 0.56 + radius * Math.sin(t1)],
          radius: 0.013,
          fuel: 0.45,
        });
      }
      return ring;
    }
    case 'jet':
      return [{ from: [0.5, 0.95], to: [0.5, 0.93], radius: 0.018, fuel: 2.2, jet: 1.2 }];
    default:
      return [];
  }
}

/** Centre and size of the burners, for lighting the smoke and placing the embers. */
function burnerBounds(sources: readonly FireFluidSource[]): {
  centre: [number, number];
  box: [number, number, number, number];
} {
  if (sources.length === 0) return { centre: [0.5, 0.9], box: [0.3, 0.75, 0.7, 0.95] };
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const s of sources) {
    for (const [px, py] of [s.from, s.to]) {
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  }
  return { centre: [(x0 + x1) / 2, (y0 + y1) / 2], box: [x0, y0 - 0.02, x1, y1 + 0.01] };
}

/**
 * A torch that draws by itself while nobody does: a slow figure of eight, for the `torch` preset, so
 * the scene shows what a drag does before anyone tries it. Stops as soon as a pointer is pressed.
 */
function createAutopilot(
  pointer: PointerIgnition,
  enabled: () => boolean,
  radius: () => number,
): IgnitionSource {
  let clock = 0;
  let idle = AUTOPILOT_WAIT;
  let last: [number, number] | undefined;
  const at = (t: number): [number, number] => [
    0.5 + 0.28 * Math.sin(0.45 * t),
    0.68 + 0.14 * Math.sin(0.9 * t + 0.6),
  ];
  return {
    collect(dt) {
      clock += dt;
      idle = pointer.pressed > 0 ? 0 : idle + dt;
      if (!enabled() || idle < AUTOPILOT_WAIT) {
        last = undefined;
        return [];
      }
      const now = at(clock);
      const from = last ?? now;
      last = now;
      const igniter: Igniter = {
        fromX: from[0],
        fromY: from[1],
        toX: now[0],
        toY: now[1],
        radius: radius(),
        strength: 1,
      };
      return [igniter];
    },
    destroy() {},
  };
}

export const effect = defineEffect({
  meta,
  params: {
    view: { type: 'select', default: 'fire', options: VIEWS, label: 'diagnostic' },
    burner: { type: 'select', default: 'logs', options: BURNERS },
    palette: { type: 'select', default: 'wood', options: PALETTES, label: 'colour' },
    fuel: { type: 'number', default: 3.5, min: 0, max: 8, step: 0.05, label: 'fuel rate' },
    lumps: { type: 'number', default: 0.7, min: 0, max: 1.5, step: 0.01 },
    bed: {
      type: 'number',
      default: 1.2,
      min: 0,
      max: 2.5,
      step: 0.01,
      label: 'burner temperature',
    },
    ignition: { type: 'number', default: 0.8, min: 0.2, max: 2, step: 0.01 },
    burnRate: {
      type: 'number',
      default: 2.2,
      min: 1,
      max: 20,
      step: 0.1,
      label: 'burn rate (1 / s)',
    },
    heat: { type: 'number', default: 3, min: 0.5, max: 5, step: 0.05, label: 'heat release' },
    expansion: {
      type: 'number',
      default: 0.25,
      min: 0,
      max: 1.5,
      step: 0.01,
      label: 'gas expansion',
    },
    buoyancy: { type: 'number', default: 0.8, min: 0, max: 4, step: 0.01 },
    cooling: {
      type: 'number',
      default: 0.9,
      min: 0.2,
      max: 4,
      step: 0.01,
      label: 'cooling (1 / s)',
    },
    soot: { type: 'number', default: 0.25, min: 0, max: 1.5, step: 0.01, label: 'soot yield' },
    sootFade: {
      type: 'number',
      default: 0.35,
      min: 0,
      max: 2,
      step: 0.01,
      label: 'soot fade (1 / s)',
    },
    wind: { type: 'number', default: 0, min: -1, max: 1, step: 0.01 },
    scheme: { type: 'select', default: 'maccormack', options: SCHEMES, label: 'advection' },
    vorticity: {
      type: 'number',
      default: 4,
      min: 0,
      max: 10,
      step: 0.1,
      label: 'vorticity confinement (1 / s)',
    },
    damping: {
      type: 'number',
      default: 0.8,
      min: 0.1,
      max: 3,
      step: 0.01,
      label: 'velocity damping (1 / s)',
    },
    turbulence: {
      type: 'number',
      default: 3,
      min: 0,
      max: 12,
      step: 0.1,
      label: 'procedural turbulence',
    },
    turbulenceScale: {
      type: 'number',
      default: 8,
      min: 3,
      max: 24,
      step: 0.5,
      label: 'turbulence wavelength (cells)',
    },
    resolution: {
      type: 'select',
      default: '128',
      options: RESOLUTIONS,
      label: 'velocity cells (long side)',
    },
    embers: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.05, label: 'stray embers / s' },
    torchFuel: {
      type: 'number',
      default: 10,
      min: 0,
      max: 30,
      step: 0.5,
      label: 'torch fuel / s',
    },
    torch: {
      type: 'number',
      default: 0.03,
      min: 0.01,
      max: 0.08,
      step: 0.001,
      label: 'torch radius',
    },
    autopilot: { type: 'boolean', default: false, label: 'draw by itself when idle' },
    floor: { type: 'boolean', default: true, label: 'floor (open sides and top)' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01 },
    kelvin: {
      type: 'number',
      default: 520,
      min: 300,
      max: 900,
      step: 5,
      label: 'kelvin per unit of T',
    },
    opacity: { type: 'number', default: 2.5, min: 0, max: 8, step: 0.05, label: 'soot opacity' },
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
    campfire: {},
    // Premixed gas from a strip burner: no soot, a blue reaction zone, short fast flames.
    'gas burner': {
      burner: 'line',
      palette: 'gas',
      fuel: 4,
      lumps: 0.6,
      bed: 1.4,
      burnRate: 10,
      heat: 2,
      soot: 0,
      expansion: 0.35,
      buoyancy: 1.6,
      cooling: 1.6,
      vorticity: 1,
      turbulence: 0.6,
      embers: 0,
    },
    // No burner: press and drag to spray burning fuel. Idle, it draws a slow figure of eight itself.
    torch: {
      burner: 'none',
      autopilot: true,
      torch: 0.035,
      torchFuel: 14,
      burnRate: 1.3,
      cooling: 0.6,
      buoyancy: 0.6,
      soot: 0.35,
      embers: 0,
    },
    // Cool, slow and sooty: logs that barely keep alight, relit by stray embers, under a pall of smoke.
    'smoky smoulder': {
      fuel: 1.8,
      bed: 0.9,
      ignition: 0.7,
      burnRate: 2.5,
      heat: 1.8,
      soot: 1,
      sootFade: 0.12,
      buoyancy: 0.9,
      cooling: 0.9,
      embers: 1.5,
      opacity: 3.5,
      vorticity: 3,
    },
    // A ring of copper-green flame, for an avatar or a portal.
    'copper ring': {
      burner: 'ring',
      palette: 'copper',
      fuel: 2.5,
      soot: 0.05,
      cooling: 1.8,
      lumps: 0.5,
    },
    // Detail preservation (story 6.5), each against the same campfire: everything off, then one at a time.
    'detail: none': { scheme: 'semi-lagrangian', vorticity: 0, turbulence: 0 },
    'detail: confinement only': { scheme: 'semi-lagrangian', vorticity: 6, turbulence: 0 },
    'detail: MacCormack only': { scheme: 'maccormack', vorticity: 0, turbulence: 0 },
    'detail: BFECC only': { scheme: 'bfecc', vorticity: 0, turbulence: 0 },
    'detail: turbulence only': { scheme: 'semi-lagrangian', vorticity: 0, turbulence: 5 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'fire-fluid' });
    const uniforms = createUniformBuffer(device, Params, 'fire-fluid params');
    const sampler = device.createSampler({
      label: 'fire-fluid sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const layout = device.createBindGroupLayout({
      label: 'fire-fluid display layout',
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

    let width = Math.max(1, canvas.width || 16);
    let height = Math.max(1, canvas.height || 9);
    /** The aspect the grids were last made for; they follow the canvas only when it changes a lot. */
    let simAspect = width / height;
    const cells = () => Number(params.resolution) || 128;

    const fire: FireFluid = createFireFluid({
      device,
      resolution: cells(),
      width,
      height,
      profiler,
      label: 'fire-fluid',
    });

    const pointer = createPointerIgnition(canvas, { radius: params.torch, strength: 1 });
    const autopilot = createAutopilot(
      pointer,
      () => params.autopilot,
      () => params.torch,
    );
    const embers = createAmbientIgnition({ rate: params.embers, radius: 0.02, seed: 11 });
    fire.ignition.torches.push(pointer, autopilot);
    fire.ignition.embers.push(embers);
    let drive: Excitation = createExcitation(params.drive, canvas);

    let seeded = -1;
    let burner = '';
    let lightPos: [number, number] = [0.5, 0.9];
    const groups = new Map<number, GPUBindGroup>();
    let groupGeneration = -1;

    function displayGroup(): GPUBindGroup {
      if (groupGeneration !== fire.generation) {
        groups.clear();
        groupGeneration = fire.generation;
      }
      const slot = fire.dye.slot;
      let group = groups.get(slot);
      if (!group) {
        group = device.createBindGroup({
          label: 'fire-fluid display',
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniforms.buffer } },
            { binding: 1, resource: fire.dye.view },
            { binding: 2, resource: sampler },
            { binding: 3, resource: fire.fluid.fieldsView },
            { binding: 4, resource: fire.expansionSource.createView() },
          ],
        });
        groups.set(slot, group);
      }
      return group;
    }

    /** The burners for the current kind and canvas shape, and where the embers fall. */
    function placeBurners() {
      const key = `${params.burner}@${fire.grid.aspect.toFixed(3)}`;
      if (key === burner) return;
      burner = key;
      const sources = burnerSources(params.burner as Burner, fire.grid.aspect);
      fire.setSources(sources);
      const bounds = burnerBounds(sources);
      lightPos = bounds.centre;
      embers.region = bounds.box;
    }

    function sync(level: number) {
      const p = fire.params;
      p.fuelRate = params.fuel * (1 + DRIVE_FUEL * level);
      p.lumps = params.lumps;
      p.bedTemperature = params.bed;
      p.ignition = params.ignition;
      p.burnRate = params.burnRate;
      p.heat = params.heat;
      p.expansion = params.expansion;
      p.buoyancy = params.buoyancy;
      p.cooling = params.cooling;
      p.soot = params.soot;
      p.sootFade = params.sootFade;
      p.wind = params.wind;
      p.scheme = params.scheme as FluidScheme;
      p.vorticity = params.vorticity;
      p.velocityDissipation = params.damping;
      p.turbulence = params.turbulence;
      p.turbulenceScale = params.turbulenceScale;
      p.floor = params.floor;
      p.torchFuel = params.torchFuel;
      pointer.radius = params.torch;
      // Embers light what they land on: hot enough to pass the ignition switch, not a white flash.
      embers.rate = params.embers;
      embers.strength = params.ignition + p.soft + 0.3;
      fire.fluid.setResolution(cells(), Math.min(1024, cells() * 4));
      placeBurners();
    }

    return {
      /** The combustion module, for tests and tools. */
      get fire() {
        return fire;
      },
      resize(w, h) {
        width = Math.max(1, Math.round(w));
        height = Math.max(1, Math.round(h));
        tail.resize(width, height);
        // Dragging a window edge changes the aspect a little at a time; re-creating the grids for each
        // pixel would put the fire out, so the fluid follows only a real change of shape.
        const aspect = width / height;
        if (Math.abs(Math.log(aspect / simAspect)) > 0.06) {
          simAspect = aspect;
          fire.fluid.resize(width, height);
        }
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        // The drive feeds the fire, never its clock: more fuel, as a share of the calm rate.
        sync(drive.update(delta));
        if (seeded !== fire.generation) {
          seeded = fire.generation;
          placeBurners();
          fire.seed();
        }
        fire.update(encoder, delta);

        const grid = fire.grid;
        const palette = Math.max(0, PALETTES.indexOf(params.palette as (typeof PALETTES)[number]));
        const gas = palette === 1;
        uniforms.set({
          grid: [grid.width, grid.height],
          light_pos: lightPos,
          light_colour: gas ? [0.5, 0.7, 1.6] : [3.2, 1.3, 0.4],
          aspect: grid.aspect,
          reaction_tint: gas ? [0.16, 0.36, 1] : [0.25, 0.4, 1],
          view: Math.max(0, VIEWS.indexOf(params.view as (typeof VIEWS)[number])),
          palette,
          kelvin_per_unit: params.kelvin,
          kelvin_ref: 1800,
          flame: 7 * params.glow,
          emissivity: 1,
          knee: 9,
          reaction_glow: gas ? 0.6 * params.glow : 0,
          premix: gas ? 0.1 * params.glow : 0,
          opacity: params.opacity,
          sootiness: 0.75,
          light_radius: 0.12,
          debug_gain: params.debugGain,
        });
        uniforms.upload();
        renderFullscreen(encoder, tail.scene.view, pipeline, [displayGroup()], {
          timestampWrites: profiler.pass('fire'),
        });
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        pointer.destroy();
        embers.destroy();
        drive.destroy();
        fire.destroy();
        uniforms.destroy();
        tail.destroy();
      },
    };
  },
});
