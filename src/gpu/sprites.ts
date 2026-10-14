import spriteLibrary from '../wgsl/sprite.wgsl';
import { CameraUniform } from './scene/camera.ts';
import { createShader, libraryChunks, withChunks, type ShaderSource } from './shader.ts';
import spritesShader from './sprites.wgsl';
import { createUniformBuffer, defineUniformStruct } from './uniforms.ts';

/*
 * Instanced additive sprites: embers, sparks, glow puffs. One camera-facing quad per instance,
 * six vertices each with no vertex buffer for the corners, added (`one`, `one`) to an HDR target
 * that already holds the scene.
 *
 *   const sprites = createSpriteRenderer(device, { capacity: 4096, camera: view.camera.buffer });
 *   // per frame
 *   sprites.update(data, count);                    // Float32Array, SPRITE_FLOATS per sprite
 *   sprites.settings.fadeScale = 1;                 // live settings, read at draw time
 *   sprites.draw(encoder, { target: tail.scene.view, depth: depth.view });
 *
 * Instance layout, 48 bytes (12 floats), little-endian f32 throughout:
 *
 *   float  0..2   position   world space, the sprite's centre
 *   float  3      size       half-width in world units (the quad is 2 * size across); 0 = unused slot
 *   float  4..6   velocity   world units per second; only its on-screen part stretches the quad
 *   float  7      param      free per-sprite value handed to the shading function (age, seed, kind)
 *   float  8..10  colour     linear RGB radiance at the sprite's peak (1.0 = paper white; HDR)
 *   float  11     alpha      multiplies the colour in the default shading; 0 = unused slot
 *
 * Depth. The sprite pass has NO depth attachment. The scene's depth texture is bound as a
 * `texture_depth_2d` and compared in the fragment stage, which is what the soft fade needs anyway:
 * it has to know how far behind the sprite the geometry is, not just whether it is. WebGPU would
 * also allow attaching the same texture read-only (`depthReadOnly: true`) while sampling it, which
 * buys early rejection of hidden pixels; it was left out because it ties the pipeline to the depth
 * format, needs a second pipeline for the no-depth case, and saves little for additive sprites
 * whose hidden pixels already leave the fragment stage after one texel load. The depth texture
 * must be the same size as the target, since it is read with `textureLoad` at the pixel position.
 *
 * Additive blending is order independent, so nothing is sorted. The target's alpha is left as it is.
 *
 * GPU-fed sprites. With `buffer` the instances come from a buffer a compute pass writes (it needs
 * VERTEX and STORAGE usage), and `draw({ indirect })` takes the instance count from an indirect
 * argument buffer the same compute work wrote, so a particle system never reads its live count back
 * (src/gpu/particles/renderer.ts does both).
 */

/** Floats per sprite in the instance data. */
export const SPRITE_FLOATS = 12;
/** Bytes per sprite in the instance buffer. */
export const SPRITE_STRIDE = SPRITE_FLOATS * 4;

/** Shapes the default shading knows, in the order of `SpriteSettings.shape` when it is a number. */
export const SPRITE_SHAPES = ['disc', 'gaussian', 'ember', 'streak'] as const;
export type SpriteShape = (typeof SPRITE_SHAPES)[number];

/** `none` ignores the scene depth, `hard` is the plain depth test, `soft` is the soft-particle fade. */
export type SpriteDepthMode = 'none' | 'hard' | 'soft';
const DEPTH_MODES: readonly SpriteDepthMode[] = ['none', 'hard', 'soft'];

export interface SpriteSettings {
  /** A named shape, or any number for a custom shading function to interpret. */
  shape: SpriteShape | number;
  /** Multiplies every instance's size. */
  sizeScale: number;
  /** Multiplies every sprite's radiance. */
  intensity: number;
  /** Seconds per world unit: the quad's length is `size * (1 + stretch * on-screen speed)`. */
  stretch: number;
  /** Upper limit of length / width. */
  maxStretch: number;
  /** 0 centres the stretched quad on the sprite (motion blur); 1 trails all of it behind (comet). */
  trail: number;
  /** Radiance is divided by `ratio ^ stretchDim`: 1 keeps a stretched sprite's total light, 0 its peak. */
  stretchDim: number;
  /** Needs a `depth` view at draw time; without one the sprites are drawn as `none`. */
  depth: SpriteDepthMode;
  /** Soft fade distance in world units. */
  fadeDistance: number;
  /** Soft fade distance in multiples of each sprite's size, added to `fadeDistance`. */
  fadeScale: number;
  /** 1 is a linear fade; 2 to 4 give the paper's S-curve, which hides where the fade starts. */
  fadeContrast: number;
  /** View-space distances between which a sprite fades in as it leaves the camera. */
  nearFade: readonly [number, number];
  /** Smallest on-screen radius in pixels; smaller sprites are enlarged and dimmed to match. 0 disables. */
  minPixels: number;
  /** Four free values for a custom shading function (`SpriteSample.user`). */
  user: readonly [number, number, number, number];
}

export const DEFAULT_SPRITE_SETTINGS: SpriteSettings = {
  shape: 'gaussian',
  sizeScale: 1,
  intensity: 1,
  stretch: 0,
  maxStretch: 8,
  trail: 0,
  stretchDim: 0,
  depth: 'soft',
  fadeDistance: 0,
  fadeScale: 1,
  fadeContrast: 1,
  nearFade: [0, 0],
  minPixels: 1,
  user: [0, 0, 0, 0],
};

/** The uniform block behind `SpriteSettings` in sprites.wgsl. */
export const SpriteSettingsUniform = defineUniformStruct('SpriteSettings', {
  size_scale: 'f32',
  intensity: 'f32',
  stretch: 'f32',
  max_stretch: 'f32',
  trail: 'f32',
  stretch_dim: 'f32',
  fade_distance: 'f32',
  fade_scale: 'f32',
  fade_contrast: 'f32',
  min_pixels: 'f32',
  near_fade: 'vec2f',
  shape: 'u32',
  depth_mode: 'u32',
  user: 'vec4f',
});

/**
 * The shading used when no `shade` is given: the instance colour times its alpha, shaped by
 * `settings.shape`. `ember` and `streak` push their cores towards white, as overexposed light does.
 * `streak` is a round dot at rest and blends into the streak as the stretch ratio grows from 1 to
 * 3 (a resting quad has no direction and would face +x as a comet); at a ratio of 3 or more it is
 * the plain streak.
 * A replacement is any WGSL that defines `fn shade_sprite(s: SpriteSample) -> vec3f` and returns
 * linear radiance; it may `#include` library chunks (pass them in the source's `chunks`).
 */
export const DEFAULT_SPRITE_SHADE: ShaderSource = {
  label: 'sprite-shade.wgsl',
  code: `// Default sprite shading: instance colour * alpha, shaped by settings.shape.
#include "sprite.wgsl"

fn shade_sprite(s: SpriteSample) -> vec3f {
  let base = s.color.rgb * s.color.a;
  let peak = max(base.r, max(base.g, base.b));
  switch (s.shape) {
    case 0u: {
      return base * sprite_disc(s.p, 0.5);
    }
    case 2u: {
      let ember = sprite_ember(s.p, 0.3, 0.12);
      return mix(base, vec3f(peak), 0.6 * ember.y) * ember.x;
    }
    case 3u: {
      let moving = clamp((s.ratio - 1.0) * 0.5, 0.0, 1.0);
      let streak = mix(sprite_gaussian(s.p, 5.0), sprite_streak(s.p, 0.5, 0.7), moving);
      return mix(base, vec3f(peak), 0.6 * streak * streak) * streak;
    }
    default: {
      return base * sprite_gaussian(s.p, 4.0);
    }
  }
}
`,
  chunks: libraryChunks(spriteLibrary),
};

/** One sprite, for `writeSprite`. */
export interface SpriteInstance {
  position: readonly [number, number, number];
  size: number;
  velocity?: readonly [number, number, number];
  param?: number;
  color: readonly [number, number, number];
  alpha?: number;
}

/** Writes sprite `index` into instance data laid out as described at the top of this file. */
export function writeSprite(data: Float32Array, index: number, sprite: SpriteInstance): void {
  const o = index * SPRITE_FLOATS;
  const [vx, vy, vz] = sprite.velocity ?? [0, 0, 0];
  data[o] = sprite.position[0];
  data[o + 1] = sprite.position[1];
  data[o + 2] = sprite.position[2];
  data[o + 3] = sprite.size;
  data[o + 4] = vx;
  data[o + 5] = vy;
  data[o + 6] = vz;
  data[o + 7] = sprite.param ?? 0;
  data[o + 8] = sprite.color[0];
  data[o + 9] = sprite.color[1];
  data[o + 10] = sprite.color[2];
  data[o + 11] = sprite.alpha ?? 1;
}

export interface SpriteRendererOptions {
  /** Most sprites one draw can hold. Fixed for the renderer's lifetime. */
  capacity: number;
  /** A buffer holding a `CameraUniform` (e.g. a forward renderer's `view.camera.buffer`). */
  camera: GPUBuffer;
  /** Format of the target the sprites are added to. Default `rgba16float`. */
  format?: GPUTextureFormat;
  /**
   * Draw from this buffer instead of creating one: at least `capacity * SPRITE_STRIDE` bytes with
   * `VERTEX` usage, e.g. one a compute pass writes, or another sprite renderer's `buffer`. The
   * caller keeps ownership; `update` still works if the buffer also has `COPY_DST`.
   */
  buffer?: GPUBuffer;
  /** Replaces the shading function; see `DEFAULT_SPRITE_SHADE`. */
  shade?: ShaderSource;
  label?: string;
}

export interface SpriteDrawOptions {
  /** View of the HDR target; it is loaded, not cleared, unless `clear` is given. */
  target: GPUTextureView;
  /** The scene's depth as a sampleable view, the same size as `target`. Omit to ignore depth. */
  depth?: GPUTextureView;
  /** Sprites to draw; defaults to the count of the last `update`. */
  count?: number;
  /** Restrict drawing to a pixel rectangle (x, y, width, height), e.g. for a split comparison. */
  scissor?: readonly [number, number, number, number];
  /**
   * Draw `drawIndirect` from four u32 at `offset` in `buffer` (vertex count 6, instance count,
   * first vertex 0, first instance 0), which a compute pass wrote: the instance count never visits
   * the CPU. `count` is then ignored. The buffer needs INDIRECT usage.
   */
  indirect?: { buffer: GPUBuffer; offset?: number };
  /** Clear the target to this colour first instead of loading it. Default: load. */
  clear?: GPUColor;
  label?: string;
  timestampWrites?: GPURenderPassTimestampWrites;
}

export interface SpriteRenderer {
  readonly capacity: number;
  /** The instance buffer, for a second renderer or a compute pass to share. */
  readonly buffer: GPUBuffer;
  /** Sprites the last `update` uploaded. */
  readonly count: number;
  /**
   * Live settings, uploaded by `draw`. They live in one uniform buffer, so every `draw` of this
   * renderer encoded before the same `queue.submit` sees the values of the LAST one. To draw the
   * same sprites two ways in one frame, make a second renderer with `buffer: first.buffer`.
   */
  readonly settings: SpriteSettings;
  /** Uploads the first `count` sprites of `data` (`SPRITE_FLOATS` floats each). */
  update(data: Float32Array, count: number): void;
  /** Encodes one render pass that adds the sprites to `target`. */
  draw(encoder: GPUCommandEncoder, options: SpriteDrawOptions): void;
  destroy(): void;
}

const INSTANCE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SPRITE_STRIDE,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x4' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
  ],
};

export function createSpriteRenderer(
  device: GPUDevice,
  options: SpriteRendererOptions,
): SpriteRenderer {
  const { capacity, camera, format = 'rgba16float', label = 'sprites' } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`Sprite capacity must be a positive integer, got ${capacity}`);
  }
  if (options.buffer && options.buffer.size < capacity * SPRITE_STRIDE) {
    throw new RangeError(
      `Sprite buffer holds ${Math.floor(options.buffer.size / SPRITE_STRIDE)} sprites, capacity is ${capacity}`,
    );
  }

  const ownsBuffer = options.buffer === undefined;
  const buffer =
    options.buffer ??
    device.createBuffer({
      label: `${label} instances`,
      size: capacity * SPRITE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  const uniforms = createUniformBuffer(device, SpriteSettingsUniform, `${label} settings`);
  const settings: SpriteSettings = { ...DEFAULT_SPRITE_SETTINGS };

  const shade = options.shade ?? DEFAULT_SPRITE_SHADE;
  const module = createShader(
    device,
    withChunks({ ...spritesShader, label: `${label}/sprites.wgsl` }, shade.chunks ?? {}, {
      'sprite-settings.wgsl': SpriteSettingsUniform.wgsl,
      'sprite-shade.wgsl': shade.code,
    }),
  );

  const layout = device.createBindGroupLayout({
    label: `${label} layout`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: CameraUniform.size },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: SpriteSettingsUniform.size },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
    ],
  });
  const additive: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    // Light adds nothing to coverage: the target keeps whatever alpha the scene wrote.
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  const pipeline = device.createRenderPipeline({
    label,
    layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [INSTANCE_LAYOUT] },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: additive }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });

  // Bound when no scene depth is given; `depth_mode` 0 never reads it.
  const noDepth = device.createTexture({
    label: `${label} no depth`,
    size: [1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const noDepthView = noDepth.createView();

  // The depth view changes when the effect resizes; one bind group per view seen last.
  let boundView: GPUTextureView | undefined;
  let bindGroup: GPUBindGroup | undefined;
  const groupFor = (view: GPUTextureView): GPUBindGroup => {
    if (bindGroup && boundView === view) return bindGroup;
    boundView = view;
    bindGroup = device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: { buffer: camera } },
        { binding: 1, resource: { buffer: uniforms.buffer } },
        { binding: 2, resource: view },
      ],
    });
    return bindGroup;
  };

  let count = 0;

  return {
    capacity,
    buffer,
    settings,
    get count() {
      return count;
    },

    update(data, newCount) {
      if (!Number.isInteger(newCount) || newCount < 0 || newCount > capacity) {
        throw new RangeError(`Sprite count must be 0..${capacity}, got ${newCount}`);
      }
      if (data.length < newCount * SPRITE_FLOATS) {
        throw new RangeError(
          `${newCount} sprites need ${newCount * SPRITE_FLOATS} floats, got ${data.length}`,
        );
      }
      count = newCount;
      if (count > 0) {
        device.queue.writeBuffer(
          buffer,
          0,
          data.buffer as ArrayBuffer,
          data.byteOffset,
          count * SPRITE_STRIDE,
        );
      }
    },

    draw(encoder, drawOptions) {
      const depthMode = drawOptions.depth ? DEPTH_MODES.indexOf(settings.depth) : 0;
      const shape =
        typeof settings.shape === 'number' ? settings.shape : SPRITE_SHAPES.indexOf(settings.shape);
      uniforms.set({
        size_scale: settings.sizeScale,
        intensity: settings.intensity,
        stretch: settings.stretch,
        max_stretch: settings.maxStretch,
        trail: settings.trail,
        stretch_dim: settings.stretchDim,
        fade_distance: settings.fadeDistance,
        fade_scale: settings.fadeScale,
        fade_contrast: settings.fadeContrast,
        min_pixels: settings.minPixels,
        near_fade: settings.nearFade,
        shape: Math.max(0, shape),
        depth_mode: Math.max(0, depthMode),
        user: settings.user,
      });
      uniforms.upload();

      const pass = encoder.beginRenderPass({
        label: drawOptions.label ?? label,
        colorAttachments: [
          {
            view: drawOptions.target,
            loadOp: drawOptions.clear ? 'clear' : 'load',
            clearValue: drawOptions.clear,
            storeOp: 'store',
          },
        ],
        timestampWrites: drawOptions.timestampWrites,
      });
      const indirect = drawOptions.indirect;
      if (indirect) {
        if (drawOptions.scissor) pass.setScissorRect(...drawOptions.scissor);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, groupFor(drawOptions.depth ?? noDepthView));
        pass.setVertexBuffer(0, buffer, 0, capacity * SPRITE_STRIDE);
        pass.drawIndirect(indirect.buffer, indirect.offset ?? 0);
        pass.end();
        return;
      }
      const instances = Math.min(drawOptions.count ?? count, capacity);
      if (instances > 0) {
        if (drawOptions.scissor) pass.setScissorRect(...drawOptions.scissor);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, groupFor(drawOptions.depth ?? noDepthView));
        pass.setVertexBuffer(0, buffer, 0, instances * SPRITE_STRIDE);
        pass.draw(6, instances);
      }
      pass.end();
    },

    destroy() {
      if (ownsBuffer) buffer.destroy();
      uniforms.destroy();
      noDepth.destroy();
    },
  };
}
