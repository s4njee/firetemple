import { noProfiler, type PassProfiler } from '../profiler.ts';
import type { ShaderSource } from '../shader.ts';
import {
  createSpriteRenderer,
  SPRITE_STRIDE,
  type SpriteRenderer,
  type SpriteSettings,
} from '../sprites.ts';
import { createUniformBuffer } from '../uniforms.ts';
import { createComputePass } from './compute.ts';
import { ARGS, ParticleDrawUniform, type ParticleSystem } from './system.ts';

/*
 * Drawing a particle system with the shared sprite renderer (src/gpu/sprites.ts):
 *
 *   const renderer = createParticleRenderer(system, { camera: view.camera.buffer });
 *   renderer.style.intensity = 3;                 // live; see ParticleStyle
 *   renderer.sprites.settings.shape = 'ember';    // live sprite settings (shape, stretch, minPixels)
 *   // per frame, after system.advance:
 *   renderer.encode(encoder, time.delta);
 *   renderer.draw(encoder, { target: tail.scene.view, clear: { r: 0, g: 0, b: 0, a: 0 } });
 *
 * `encode` runs the `draw_sprites` kernel (kernels.wgsl) over the live particles, indirectly: one
 * thread per live particle writes one SPRITE_FLOATS instance, compacted to the front of the sprite
 * buffer. `draw` is an instanced `drawIndirect` whose instance count the system's `finish` kernel
 * wrote. Neither the count nor any particle visits the CPU.
 *
 * COLOUR. By default (`color: 'blackbody'`) a sprite's radiance is
 *     blackbody_radiance(T, tRef, gamma) * tint * intensity * twinkle * fade-in * fade-out
 * (blackbody.wgsl: luminance 1 at tRef, gamma 0.4 the tamed curve), so cooling alone carries a
 * particle from yellow through orange and deep red to nothing. `color: 'tint'` ignores the
 * temperature. `hook_sprite` (system hooks) can then change anything per particle.
 *
 * TWINKLE is `particle_twinkle`: per-particle, at most 4 Hz whatever `twinkleRate` asks for, so a
 * crowd of particles never adds up to a whole-frame flash. The renderer keeps its own clock in real
 * seconds (wrapped every 2048 s), separate from the simulation clock.
 *
 * EXTRAPOLATION. Positions are drawn `alpha * fixedStep` seconds ahead along the velocity (the part
 * of a step the accumulator holds back), so a 144 Hz display does not see 60 Hz steps.
 */

export type ParticleColorMode = 'blackbody' | 'tint';

/** Live style of the sprite-writing kernel. */
export interface ParticleStyle {
  color: ParticleColorMode;
  /** Radiance multiplier (linear HDR: embers 1..3, hot sparks more). */
  intensity: number;
  /** Temperature at which the blackbody colour has luminance 1. */
  tRef: number;
  /** blackbody_intensity gamma (0.4 tamed, 1 physical). */
  gamma: number;
  /** Linear RGB multiplier (the colour itself in 'tint' mode). */
  tint: [number, number, number];
  /** Brightness swing 0..1. */
  twinkle: number;
  /** Hz, capped at 4. */
  twinkleRate: number;
  /** Multiplies every particle's size. */
  sizeScale: number;
  /** particle_size_over_life curve: [birth, peak, death, peak at]. */
  sizeCurve: [number, number, number, number];
  /** Seconds over which a new particle fades in. */
  fadeIn: number;
  /** Share of the life over which it fades out at the end. */
  fadeOut: number;
  /** Draw ahead by the leftover part of a step. Default true. */
  extrapolate: boolean;
  /** Four vec4f `hook_sprite` reads as `ps_draw.user[i]`. */
  user: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
  ];
}

export const DEFAULT_PARTICLE_STYLE: Readonly<ParticleStyle> = {
  color: 'blackbody',
  intensity: 2,
  tRef: 1800,
  gamma: 0.4,
  tint: [1, 1, 1],
  twinkle: 0,
  twinkleRate: 2,
  sizeScale: 1,
  sizeCurve: [1, 1, 1, 0.5],
  fadeIn: 0.05,
  fadeOut: 0.1,
  extrapolate: true,
  user: [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
};

export interface ParticleRendererOptions {
  /** A buffer holding a `CameraUniform`: a forward view's `camera.buffer`, or one filled from `overlayCamera`. */
  camera: GPUBuffer;
  /** Format of the target. Default `rgba16float` (the tail's scene). */
  format?: GPUTextureFormat;
  /** Replaces the sprite shading function (sprites.ts `DEFAULT_SPRITE_SHADE`). */
  shade?: ShaderSource;
  profiler?: PassProfiler;
  label?: string;
}

export interface ParticleRenderer {
  readonly style: ParticleStyle;
  /** The sprite renderer underneath, for its live `settings`. */
  readonly sprites: SpriteRenderer;
  /** Instances, SPRITE_FLOATS per live particle, compacted. */
  readonly buffer: GPUBuffer;
  /** Writes this frame's sprite instances. `delta` advances the twinkle clock (real seconds). */
  encode(encoder: GPUCommandEncoder, delta: number): void;
  /** Draws the instances `encode` wrote (indirect). */
  draw(
    encoder: GPUCommandEncoder,
    options: {
      target: GPUTextureView;
      depth?: GPUTextureView;
      clear?: GPUColor;
      label?: string;
      timestampWrites?: GPURenderPassTimestampWrites;
    },
  ): void;
  destroy(): void;
}

const CLOCK_WRAP = 2048;

export function createParticleRenderer(
  system: ParticleSystem,
  options: ParticleRendererOptions,
): ParticleRenderer {
  const { device, capacity } = system;
  const label = options.label ?? `${system.label} sprites`;
  const profiler = options.profiler ?? noProfiler;
  const bytes = capacity * SPRITE_STRIDE;
  if (bytes > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)) {
    throw new RangeError(
      `${label}: ${capacity} sprite instances need ${bytes} bytes, over the device's storage binding limit`,
    );
  }
  const buffer = device.createBuffer({
    label: `${label} instances`,
    size: capacity * SPRITE_STRIDE,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const sprites = createSpriteRenderer(device, {
    capacity,
    camera: options.camera,
    format: options.format,
    buffer,
    shade: options.shade,
    label,
  });
  const uniforms = createUniformBuffer(device, ParticleDrawUniform, `${label} style`);
  const kernel = createComputePass(device, {
    label: system.source.label,
    code: system.source.code,
    chunks: system.source.chunks,
    entryPoint: 'draw_sprites',
  });
  const style: ParticleStyle = {
    ...DEFAULT_PARTICLE_STYLE,
    tint: [...DEFAULT_PARTICLE_STYLE.tint],
    sizeCurve: [...DEFAULT_PARTICLE_STYLE.sizeCurve],
    user: DEFAULT_PARTICLE_STYLE.user.map((v) => [...v]) as ParticleStyle['user'],
  };
  let clock = 0;

  return {
    style,
    sprites,
    buffer,
    encode(encoder, delta) {
      clock = (clock + Math.max(0, Math.min(delta, 0.25))) % CLOCK_WRAP;
      uniforms.set({
        list: system.list,
        capacity,
        dimension: system.dimension,
        color_mode: style.color === 'tint' ? 1 : 0,
        ahead: style.extrapolate ? system.alpha * system.params.fixedStep : 0,
        time: clock,
        intensity: style.intensity,
        t_ref: style.tRef,
        gamma: style.gamma,
        twinkle: style.twinkle,
        twinkle_rate: style.twinkleRate,
        size_scale: style.sizeScale,
        size_curve: style.sizeCurve,
        tint: style.tint,
        fade_in: style.fadeIn,
        fade_out: style.fadeOut,
        user: style.user.flat(),
      });
      uniforms.upload();
      const pass = encoder.beginComputePass({
        label: `${label} write`,
        timestampWrites: profiler.pass(`${label} write`) as
          GPUComputePassTimestampWrites | undefined,
      });
      kernel.dispatchIndirect(
        pass,
        [
          undefined,
          system.positions,
          system.velocities,
          system.attributes,
          system.user,
          system.lists,
          undefined,
          undefined,
          undefined,
          undefined,
          uniforms.buffer,
          buffer,
        ],
        system.args,
        ARGS.draw,
      );
      pass.end();
    },
    draw(encoder, drawOptions) {
      sprites.draw(encoder, {
        target: drawOptions.target,
        depth: drawOptions.depth,
        clear: drawOptions.clear,
        label: drawOptions.label ?? label,
        timestampWrites: drawOptions.timestampWrites,
        indirect: { buffer: system.args, offset: ARGS.indirect },
      });
    },
    destroy() {
      kernel.destroy();
      uniforms.destroy();
      sprites.destroy();
      buffer.destroy();
    },
  };
}

/** Re-exported for effects that tweak the renderer's sprite settings. */
export type { SpriteSettings };
