import { describe, expect, it, vi } from 'vitest';
import {
  CameraUniform,
  computeCamera,
  linearizeDepth,
  projectPoint,
  setCameraUniform,
  type CameraMatrices,
} from '../src/gpu/scene/camera.ts';
import { createDepthTarget } from '../src/gpu/scene/depth.ts';
import {
  createSpriteRenderer,
  SPRITE_FLOATS,
  SPRITE_STRIDE,
  SpriteSettingsUniform,
  writeSprite,
  type SpriteInstance,
  type SpriteRenderer,
} from '../src/gpu/sprites.ts';
import { createUniformBuffer } from '../src/gpu/uniforms.ts';
import {
  MAX_SPARKS_AND_EMBERS,
  MAX_SPRITES,
  simulate,
} from '../src/effects/soft-sprites/particles.ts';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';
import { mountHeadless } from './headless.ts';
import { gpuF32, lane, rowsOf } from './wgsl-eval.ts';

vi.setConfig({ testTimeout: 30_000 });

const INCLUDE = '#include "sprite.wgsl"\n';
const near = (actual: number, expected: number, tolerance = 1e-5) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

/** Points on the border of the quad, where every shape has to have reached zero, and outside it. */
function borderPoints(): number[][] {
  const points: number[][] = [];
  for (let t = -1; t <= 1; t += 0.125) {
    points.push([1, t], [-1, t], [t, 1], [t, -1]);
  }
  points.push([1.5, 0], [0, -1.5], [-3, 0.2], [0.72, 0.72], [2, 2]);
  return points;
}

// Every shape in one pass: x = disc, y = gaussian, z = ember intensity, w = streak.
const SHAPES = `${INCLUDE}
fn f(x: vec4f) -> vec4f {
  return vec4f(
    sprite_disc(x.xy, 0.5),
    sprite_gaussian(x.xy, 4.0),
    sprite_ember(x.xy, 0.3, 0.15).x,
    sprite_streak(x.xy, 0.5, 0.7),
  );
}`;

describe('sprite.wgsl shapes', () => {
  it('builds a quad from six vertices as two counter-clockwise triangles', async () => {
    const out = await gpuF32(
      `${INCLUDE} fn f(x: vec4f) -> vec4f { return vec4f(sprite_corner(u32(x.x)), 0.0, 0.0); }`,
      rowsOf([[0], [1], [2], [3], [4], [5], [6]]),
    );
    const corners = lane(out, 0).map((x, i) => [x, lane(out, 1)[i]]);
    expect(corners).toEqual([
      [-1, -1],
      [1, -1],
      [-1, 1],
      [-1, 1],
      [1, -1],
      [1, 1],
      [-1, -1],
    ]);
    // Signed area of each triangle is positive: counter-clockwise with y up.
    const area = (a: number[], b: number[], c: number[]) =>
      (b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!);
    expect(area(corners[0] as number[], corners[1] as number[], corners[2] as number[])).toBe(4);
    expect(area(corners[3] as number[], corners[4] as number[], corners[5] as number[])).toBe(4);
  });

  it('is exactly zero on the border of the quad and beyond it', async () => {
    const out = await gpuF32(SHAPES, rowsOf(borderPoints()));
    for (let channel = 0; channel < 4; channel++) {
      for (const value of lane(out, channel)) expect(value).toBe(0);
    }
  });

  it('peaks at one: at the centre, or at the head of a streak', async () => {
    const out = await gpuF32(
      SHAPES,
      rowsOf([
        [0, 0],
        [0.5, 0],
      ]),
    );
    expect(out[0]).toBe(1);
    // The gaussian (and the ember's halo, which is one) divides two exponentials: 1 to rounding.
    near(out[1]!, 1, 1e-6);
    near(out[2]!, 1, 1e-6);
    expect(out[7]).toBe(1);
    // Nothing anywhere exceeds the peak.
    const grid: number[][] = [];
    for (let y = -1; y <= 1; y += 0.0625) for (let x = -1; x <= 1; x += 0.0625) grid.push([x, y]);
    const all = await gpuF32(SHAPES, rowsOf(grid));
    for (const value of all) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('falls monotonically along every radius (disc, gaussian, ember)', async () => {
    const STEPS = 64;
    for (const angle of [0, 0.7, 1.9, 3.3, 5.1]) {
      const rows: number[][] = [];
      for (let i = 0; i <= STEPS; i++) {
        const r = i / STEPS;
        rows.push([Math.cos(angle) * r, Math.sin(angle) * r]);
      }
      const out = await gpuF32(SHAPES, rowsOf(rows));
      for (let channel = 0; channel < 3; channel++) {
        const values = lane(out, channel);
        // Rounding of cos/sin can lift one float step; nothing larger may ever rise.
        for (let i = 1; i < values.length; i++) {
          expect(values[i]!).toBeLessThanOrEqual(values[i - 1]! + 1e-6);
        }
        near(values[0]!, 1);
        near(values[STEPS]!, 0, 2e-6);
      }
      // The gaussian has no flat part: it is strictly decreasing.
      const gaussian = lane(out, 1);
      for (let i = 1; i < gaussian.length; i++) expect(gaussian[i]!).toBeLessThan(gaussian[i - 1]!);
    }
  });

  it('gives the disc a flat top and the ember a core inside its halo', async () => {
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(sprite_disc(x.xy, 0.5), sprite_disc(x.xy, 0.05), sprite_ember(x.xy, 0.3, 0.15));
       }`,
      rowsOf([
        [0.45, 0],
        [0, 0.9],
        [0.15, 0],
        [0.31, 0],
        [0.6, 0],
      ]),
    );
    // Flat inside 1 - softness.
    expect(out[0]).toBe(1);
    expect(out[5]).toBe(1);
    expect(out[4]).toBeLessThan(0.2);
    // Ember: the core weight is 0.5 halfway through the core and gone outside it, where only the
    // halo is left, at no more than its level.
    near(out[8 + 3]!, 0.5, 1e-5);
    expect(out[12 + 3]).toBe(0);
    expect(out[12 + 2]).toBeGreaterThan(0);
    expect(out[12 + 2]).toBeLessThanOrEqual(0.15);
    expect(out[16 + 2]).toBeGreaterThan(0);
    expect(out[16 + 2]).toBeLessThan(out[12 + 2]!);
  });

  it('draws a streak with a bright head and a narrowing, fading tail', async () => {
    const rows: number[][] = [];
    for (let i = 0; i <= 64; i++) rows.push([-1 + (2 * i) / 64, 0]);
    const axis = lane(await gpuF32(SHAPES, rowsOf(rows)), 3);
    const head = axis.indexOf(Math.max(...axis));
    // Head at p.x = 0.5, i.e. sample 48.
    expect(head).toBe(48);
    for (let i = 1; i <= head; i++) expect(axis[i]!).toBeGreaterThan(axis[i - 1]!);
    for (let i = head + 1; i < axis.length; i++) expect(axis[i]!).toBeLessThan(axis[i - 1]!);
    expect(axis[0]).toBe(0);
    expect(axis[64]).toBe(0);

    // Across the streak: wide at the head, narrow in the tail.
    const across = await gpuF32(
      SHAPES,
      rowsOf([
        [0.5, 0.4],
        [0.5, 0.69],
        [0.5, 0.71],
        [-0.6, 0.2],
        [-0.6, 0.35],
      ]),
    );
    const streak = lane(across, 3);
    expect(streak[0]).toBeGreaterThan(0.2);
    expect(streak[1]).toBeGreaterThan(0);
    expect(streak[2]).toBe(0);
    expect(streak[3]).toBeGreaterThan(0);
    expect(streak[4]).toBe(0);
  });
});

describe('sprite.wgsl depth fade', () => {
  // x = scene depth, y = sprite depth, z = fade distance, w = contrast.
  const FADE = `${INCLUDE}
    fn f(x: vec4f) -> vec4f {
      return vec4f(
        sprite_depth_fade(x.x, x.y, x.z),
        sprite_depth_fade_contrast(x.x, x.y, x.z, x.w),
        0.0, 0.0);
    }`;

  it('is zero at or behind geometry and one at or beyond the fade distance', async () => {
    const out = await gpuF32(
      FADE,
      rowsOf([
        [5, 5, 0.5, 3], // on the surface
        [5, 6, 0.5, 3], // behind it
        [5, 50, 0.5, 3], // far behind
        [5.5, 5, 0.5, 3], // exactly the fade distance in front
        [9, 5, 0.5, 3], // far in front
        [5.25, 5, 0.5, 1], // halfway
      ]),
    );
    for (const channel of [0, 1]) {
      const values = lane(out, channel);
      expect(values.slice(0, 3)).toEqual([0, 0, 0]);
      expect(values.slice(3, 5)).toEqual([1, 1]);
      near(values[5]!, 0.5);
    }
  });

  it('rises monotonically across the fade, for every contrast', async () => {
    for (const contrast of [1, 2, 4]) {
      const rows: number[][] = [];
      for (let i = -8; i <= 72; i++) rows.push([10 + (i / 64) * 0.8, 10, 0.8, contrast]);
      const out = await gpuF32(FADE, rowsOf(rows));
      for (const channel of [0, 1]) {
        const values = lane(out, channel);
        for (let i = 1; i < values.length; i++) {
          expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
        }
        expect(values[0]).toBe(0);
        expect(values.at(-1)).toBe(1);
      }
    }
  });

  it('matches the linear fade at contrast 1 and the paper’s curve above it', async () => {
    const xs = [0.1, 0.25, 0.5, 0.75, 0.9];
    const out = await gpuF32(
      FADE,
      rowsOf([...xs.map((x) => [4 + x * 2, 4, 2, 1]), ...xs.map((x) => [4 + x * 2, 4, 2, 2])]),
    );
    const linear = lane(out, 0);
    const curved = lane(out, 1);
    xs.forEach((x, i) => {
      near(linear[i]!, x, 1e-5);
      near(curved[i]!, x, 1e-5);
      // 0.5 * (2x)^2 below the middle, mirrored above.
      const expected = x <= 0.5 ? 0.5 * (2 * x) ** 2 : 1 - 0.5 * (2 * (1 - x)) ** 2;
      near(curved[xs.length + i]!, expected, 1e-5);
    });
    // Symmetric about the middle, and gentler than linear at the start.
    near(curved[xs.length]! + curved[xs.length + 4]!, 1, 1e-5);
    expect(curved[xs.length]!).toBeLessThan(linear[xs.length]!);
  });

  it('degenerates to the hard depth test when the fade distance is zero', async () => {
    const out = await gpuF32(
      FADE,
      rowsOf([
        [5, 5, 0, 2],
        [5, 5.001, 0, 2],
        [5.001, 5, 0, 2],
        [7, 5, 0, 2],
        [7, 5, -1, 2],
      ]),
    );
    expect(lane(out, 0)).toEqual([0, 0, 1, 1, 1]);
    expect(lane(out, 1)).toEqual([0, 0, 1, 1, 1]);
  });

  it('fades in between the near distances', async () => {
    const rows: number[][] = [];
    for (let i = 0; i <= 40; i++) rows.push([i / 40]);
    const out = lane(
      await gpuF32(
        `${INCLUDE} fn f(x: vec4f) -> vec4f { return vec4f(sprite_near_fade(x.x, 0.25, 0.75), sprite_near_fade(x.x, 0.5, 0.5), 0.0, 0.0); }`,
        rowsOf(rows),
      ),
      0,
    );
    for (let i = 0; i <= 10; i++) expect(out[i]).toBe(0);
    for (let i = 30; i <= 40; i++) expect(out[i]).toBe(1);
    near(out[20]!, 0.5);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
  });
});

describe('sprite.wgsl velocity stretch', () => {
  const CORNERS = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  // x.xy = corner, x.zw = screen velocity; size 0.5, stretch 0.2 s/unit, ratio at most 6.
  const offsets = (trail: number) => `${INCLUDE}
    fn f(x: vec4f) -> vec4f {
      let ratio = sprite_stretch_ratio(x.zw, 0.2, 6.0);
      return vec4f(sprite_stretch_offset(x.xy, x.zw, 0.5, ratio, ${trail.toFixed(1)}), ratio, 0.0);
    }`;

  it('leaves a sprite with no velocity a square facing the camera', async () => {
    const out = await gpuF32(offsets(0), rowsOf(CORNERS.map((c) => [...c, 0, 0])));
    CORNERS.forEach((corner, i) => {
      expect(out[i * 4]).toBe(corner[0]! * 0.5);
      expect(out[i * 4 + 1]).toBe(corner[1]! * 0.5);
      expect(out[i * 4 + 2]).toBe(1);
    });
    // The same with trail on, and with a velocity too small to have a direction.
    const trailed = await gpuF32(offsets(1), rowsOf(CORNERS.map((c) => [...c, 1e-7, 0])));
    CORNERS.forEach((corner, i) => {
      near(trailed[i * 4]!, corner[0]! * 0.5, 1e-6);
      near(trailed[i * 4 + 1]!, corner[1]! * 0.5, 1e-6);
    });
  });

  it('lengthens along the velocity and keeps its width', async () => {
    // Speed 5 along (0.6, 0.8): ratio 1 + 0.2 * 5 = 2.
    const velocity = [3, 4];
    const out = await gpuF32(offsets(0), rowsOf(CORNERS.map((c) => [...c, ...velocity])));
    CORNERS.forEach((corner, i) => {
      const [ox, oy] = [out[i * 4]!, out[i * 4 + 1]!];
      near(out[i * 4 + 2]!, 2);
      const along = ox * 0.6 + oy * 0.8;
      const across = -ox * 0.8 + oy * 0.6;
      near(along, corner[0]! * 0.5 * 2);
      near(across, corner[1]! * 0.5);
    });
  });

  it('clamps the stretch and ignores a negative one', async () => {
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(
           sprite_stretch_ratio(x.xy, 0.2, 6.0),
           sprite_stretch_ratio(x.xy, -1.0, 6.0),
           sprite_stretch_ratio(x.xy, 0.2, 0.5),
           0.0);
       }`,
      rowsOf([
        [0, 0],
        [0, 10],
        [1000, 0],
      ]),
    );
    expect(lane(out, 0)).toEqual([1, 3, 6]);
    expect(lane(out, 1)).toEqual([1, 1, 1]);
    expect(lane(out, 2)).toEqual([1, 1, 1]);
  });

  it('trails behind the sprite when asked to', async () => {
    // Velocity along +x at speed 10: ratio 3. The leading edge stays at +size, the tail reaches -5 * size.
    const out = await gpuF32(offsets(1), rowsOf(CORNERS.map((c) => [...c, 10, 0])));
    CORNERS.forEach((corner, i) => {
      near(out[i * 4]!, corner[0]! > 0 ? 0.5 : -2.5);
      near(out[i * 4 + 1]!, corner[1]! * 0.5);
    });
  });

  it('measures on-screen velocity: none for a sprite flying at the eye', async () => {
    const cases = [
      // view position, view velocity
      [0, 0, -5, 1, 0, 0],
      [0, 0, -5, 0, 0, 3],
      [1, 2, -5, -0.4, -0.8, 2], // straight at the eye from off-axis
      [-3, 1, -8, 3, -1, 8], // straight away from it
      [2, -1, -6, 0.5, 0.25, -1.5],
      [-1.5, 0.5, -3, 1, 2, 0.7],
    ];
    // Two rows per case because a row holds four floats.
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let c = array<array<vec3f, 2>, ${cases.length}>(
           ${cases
             .map(
               (c) =>
                 `array<vec3f, 2>(vec3f(${c.slice(0, 3).join(', ')}), vec3f(${c.slice(3).join(', ')}))`,
             )
             .join(',\n           ')}
         );
         var k = c;
         let i = u32(x.x);
         let v = sprite_screen_velocity(k[i][0], k[i][1]);
         return vec4f(v, sprite_stretch_ratio(v, 0.2, 6.0), 0.0);
       }`,
      rowsOf(cases.map((_, i) => [i])),
    );
    near(out[0]!, 1);
    near(out[1]!, 0);
    for (const i of [1, 2, 3]) {
      near(out[i * 4]!, 0, 1e-5);
      near(out[i * 4 + 1]!, 0, 1e-5);
      near(out[i * 4 + 2]!, 1, 1e-5);
    }
    // In general: the velocity of the sprite's projection onto the plane at its own depth.
    cases.forEach(([px, py, pz, vx, vy, vz], i) => {
      const dt = 1e-4;
      const scale = pz! / (pz! + vz! * dt);
      near(out[i * 4]!, ((px! + vx! * dt) * scale - px!) / dt, 2e-3);
      near(out[i * 4 + 1]!, ((py! + vy! * dt) * scale - py!) / dt, 2e-3);
    });
  });

  it('never lets a sprite shrink below the pixel floor, and keeps its light', async () => {
    // x = size, y = pixels per unit, z = minimum radius in pixels.
    const rows = [
      [0.5, 100, 1],
      [0.004, 100, 1],
      [0.004, 100, 2],
      [0.03, 50, 1],
      [0.004, 100, 0],
    ];
    const out = await gpuF32(
      `${INCLUDE} fn f(x: vec4f) -> vec4f { return vec4f(sprite_pixel_clamp(x.x, x.y, x.z), 0.0, 0.0); }`,
      rowsOf(rows),
    );
    rows.forEach(([size, perUnit, floor], i) => {
      const [clamped, scale] = [out[i * 4]!, out[i * 4 + 1]!];
      near(clamped * perUnit!, Math.max(size! * perUnit!, floor!), 1e-4);
      expect(scale).toBeLessThanOrEqual(1);
      // Radiance times area is unchanged.
      near(scale * clamped * clamped, size! * size!, 1e-7);
    });
    expect(out[1]).toBe(1);
    near(out[5]!, 0.16);
    expect(out[13]).toBe(1);
    expect(out[17]).toBe(1);
  });
});

// --- The renderer ----------------------------------------------------------------------------------

/** rgba16float has no typed array in Node. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

const SIZE = 64;
const NEAR = 0.1;
const FAR = 50;
/** Background the sprites are added to; alpha 0.5 so a change to it would show. */
const BACKGROUND = [0.25, 0.125, 0.0625, 0.5] as const;

async function setup(options: { capacity?: number } = {}) {
  const device = await getTestDevice();
  const target = device.createTexture({
    label: 'sprite test target',
    size: [SIZE, SIZE],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = createDepthTarget(device, {
    label: 'sprite test depth',
    width: SIZE,
    height: SIZE,
  });
  const camera: CameraMatrices = computeCamera({
    position: [0, 0, 10],
    target: [0, 0, 0],
    fovY: Math.PI / 3,
    aspect: 1,
    near: NEAR,
    far: FAR,
  });
  const cameraBuffer = createUniformBuffer(device, CameraUniform, 'sprite test camera');
  setCameraUniform(cameraBuffer, camera, SIZE, SIZE);
  cameraBuffer.upload();
  const capacity = options.capacity ?? 16;
  const renderer = createSpriteRenderer(device, {
    capacity,
    camera: cameraBuffer.buffer,
    label: 'test sprites',
  });
  // Flat-topped discs, so the pixel at a sprite's centre is exactly its colour.
  renderer.settings.shape = 'disc';
  renderer.settings.minPixels = 0;

  /** Clears the colour target to the background and the depth to a wall `wallDistance` away. */
  const clear = (encoder: GPUCommandEncoder, wallDistance = FAR) => {
    const z = wallDistance;
    const depthValue = (FAR * (z - NEAR)) / (z * (FAR - NEAR));
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: [...BACKGROUND],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depth.view,
          depthClearValue: depthValue,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
  };

  const upload = (sprites: SpriteInstance[], into: SpriteRenderer = renderer) => {
    const data = new Float32Array(sprites.length * SPRITE_FLOATS);
    sprites.forEach((sprite, i) => writeSprite(data, i, sprite));
    into.update(data, sprites.length);
  };

  /** Light added on top of the background at the pixel a world point projects to. */
  const read = async () => {
    const half = new Uint16Array((await readTexture(device, target, 8)).buffer);
    return (point: readonly [number, number, number]) => {
      const p = projectPoint(camera.viewProj, point);
      const x = Math.floor(p.u * SIZE);
      const y = Math.floor(p.v * SIZE);
      const o = (y * SIZE + x) * 4;
      return [0, 1, 2, 3].map((c) => halfToFloat(half[o + c]!) - (c < 3 ? BACKGROUND[c]! : 0));
    };
  };

  return { device, target, depth, camera, cameraBuffer, renderer, clear, upload, read };
}

const closeTo = (actual: number[], expected: number[], tolerance = 2e-3) =>
  actual.forEach((value, i) => near(value, expected[i]!, tolerance));

describe('sprite renderer', () => {
  it('keeps the instance layout and the settings block at 16-byte multiples', () => {
    expect(SPRITE_STRIDE).toBe(48);
    expect(SPRITE_STRIDE % 16).toBe(0);
    expect(SpriteSettingsUniform.size % 16).toBe(0);
    const data = new Float32Array(SPRITE_FLOATS * 2);
    writeSprite(data, 1, {
      position: [1, 2, 3],
      size: 4,
      velocity: [5, 6, 7],
      param: 8,
      color: [9, 10, 11],
      alpha: 12,
    });
    expect(Array.from(data.subarray(0, SPRITE_FLOATS))).toEqual(new Array(SPRITE_FLOATS).fill(0));
    expect(Array.from(data.subarray(SPRITE_FLOATS))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('adds sprites to what the target already holds, in HDR, leaving alpha alone', async () => {
    const { device, target, renderer, clear, upload, read } = await setup();
    const left: [number, number, number] = [-2, 0, 0];
    const right: [number, number, number] = [2, 0, 0];
    await expectValid(device, async () => {
      upload([
        { position: left, size: 1, color: [8, 2, 0.5] },
        { position: right, size: 1, color: [1, 1, 1], alpha: 0.25 },
        { position: [0, 3, 0], size: 0, color: [100, 100, 100] }, // unused slot
        { position: [0, -3, 0], size: 1, color: [100, 100, 100], alpha: 0 }, // unused slot
      ]);
      const encoder = device.createCommandEncoder();
      clear(encoder);
      renderer.draw(encoder, { target: target.createView() });
      device.queue.submit([encoder.finish()]);
    });
    const at = await read();
    closeTo(at(left), [8, 2, 0.5, 0.5], 4e-3);
    closeTo(at(right), [0.25, 0.25, 0.25, 0.5]);
    // Between and outside the sprites, and at the unused slots, nothing was added.
    closeTo(at([0, 0, 0]), [0, 0, 0, 0.5], 0);
    closeTo(at([0, 3, 0]), [0, 0, 0, 0.5], 0);
    closeTo(at([0, -3, 0]), [0, 0, 0, 0.5], 0);
    closeTo(at([4.5, 4.5, 0]), [0, 0, 0, 0.5], 0);
  });

  it('sums overlapping sprites', async () => {
    const { device, target, renderer, clear, upload, read } = await setup();
    await expectValid(device, async () => {
      upload([
        { position: [0.2, 0.2, 0], size: 1.5, color: [1, 0.5, 0] },
        { position: [0.2, 0.2, 1], size: 1.5, color: [0.25, 0.25, 2] },
        { position: [0.2, 0.2, -1], size: 1.5, color: [3, 0, 0] },
      ]);
      const encoder = device.createCommandEncoder();
      clear(encoder);
      renderer.draw(encoder, { target: target.createView() });
      device.queue.submit([encoder.finish()]);
    });
    closeTo((await read())([0.2, 0.2, 0]), [4.25, 0.75, 2, 0.5], 4e-3);
  });

  it.each([
    ['hard', 1],
    ['soft', 0.5],
  ] as const)('tests against the scene depth (%s)', async (mode, inFront) => {
    const { device, target, depth, camera, renderer, clear, upload, read } = await setup();
    // A wall 10 units from the eye. One sprite 2 units in front of it, one 2 units behind.
    const front: [number, number, number] = [-2, 0, 2];
    const behind: [number, number, number] = [2, 0, -2];
    near(projectPoint(camera.viewProj, front).w, 8, 1e-4);
    near(linearizeDepth(NEAR, FAR, (FAR * (10 - NEAR)) / (10 * (FAR - NEAR))), 10, 1e-3);
    renderer.settings.depth = mode;
    renderer.settings.fadeDistance = 4;
    renderer.settings.fadeScale = 0;
    await expectValid(device, async () => {
      upload([
        { position: front, size: 1, color: [2, 4, 6] },
        { position: behind, size: 1, color: [2, 4, 6] },
      ]);
      const encoder = device.createCommandEncoder();
      clear(encoder, 10);
      renderer.draw(encoder, { target: target.createView(), depth: depth.view });
      device.queue.submit([encoder.finish()]);
    });
    const at = await read();
    // Hard: all or nothing. Soft: 2 units of clearance over a fade distance of 4 is half.
    closeTo(at(front), [2 * inFront, 4 * inFront, 6 * inFront, 0.5], 6e-3);
    closeTo(at(behind), [0, 0, 0, 0.5], 0);
  });

  it('scales the soft fade distance with the sprite when asked to', async () => {
    const { device, target, depth, renderer, clear, upload, read } = await setup();
    renderer.settings.depth = 'soft';
    renderer.settings.fadeDistance = 0;
    renderer.settings.fadeScale = 4;
    await expectValid(device, async () => {
      // Both 2 units in front of the wall: fade distance 4 * size is 4 for one and 2 for the other.
      upload([
        { position: [-2, 0, 2], size: 1, color: [1, 1, 1] },
        { position: [2, 0, 2], size: 0.5, color: [1, 1, 1] },
      ]);
      const encoder = device.createCommandEncoder();
      clear(encoder, 10);
      renderer.draw(encoder, { target: target.createView(), depth: depth.view });
      device.queue.submit([encoder.finish()]);
    });
    const at = await read();
    closeTo(at([-2, 0, 2]), [0.5, 0.5, 0.5, 0.5], 3e-3);
    closeTo(at([2, 0, 2]), [1, 1, 1, 0.5], 3e-3);
  });

  it('ignores the scene depth without a depth view or with depth "none"', async () => {
    const { device, target, depth, renderer, clear, upload, read } = await setup();
    const behind: [number, number, number] = [0, 0, -2];
    for (const withView of [false, true]) {
      renderer.settings.depth = withView ? 'none' : 'soft';
      await expectValid(device, async () => {
        upload([{ position: behind, size: 1, color: [1, 2, 3] }]);
        const encoder = device.createCommandEncoder();
        clear(encoder, 10);
        renderer.draw(encoder, {
          target: target.createView(),
          depth: withView ? depth.view : undefined,
        });
        device.queue.submit([encoder.finish()]);
      });
      closeTo((await read())(behind), [1, 2, 3, 0.5], 3e-3);
    }
  });

  it('stretches a moving sprite along its velocity on screen', async () => {
    const { device, target, renderer, clear, upload, read } = await setup();
    const sprite = { position: [0, 0, 0], size: 0.6, color: [1, 1, 1] } as const;
    const along: [number, number, number] = [1.5, 0, 0];
    const across: [number, number, number] = [0, 1.5, 0];
    const render = async (velocity: readonly [number, number, number], stretch: number) => {
      renderer.settings.stretch = stretch;
      renderer.settings.maxStretch = 8;
      await expectValid(device, async () => {
        upload([{ ...sprite, velocity }]);
        const encoder = device.createCommandEncoder();
        clear(encoder);
        renderer.draw(encoder, { target: target.createView() });
        device.queue.submit([encoder.finish()]);
      });
      return read();
    };
    // Still, or moving with no stretch: a disc of radius 0.6 that reaches neither point.
    for (const at of [await render([0, 0, 0], 1), await render([4, 0, 0], 0)]) {
      expect(at(along)[0]).toBe(0);
      expect(at(across)[0]).toBe(0);
      closeTo(at([0, 0, 0]), [1, 1, 1, 0.5], 3e-3);
    }
    // Speed 4 at stretch 1: five times as long as wide, along x only.
    const stretched = await render([4, 0, 0], 1);
    expect(stretched(along)[0]).toBeGreaterThan(0.5);
    expect(stretched(across)[0]).toBe(0);
    // Flying straight at the camera there is nothing to stretch along.
    const towards = await render([0, 0, 9], 1);
    expect(towards(along)[0]).toBe(0);
    expect(towards(across)[0]).toBe(0);
    closeTo(towards([0, 0, 0]), [1, 1, 1, 0.5], 3e-3);
  });

  it('shares its instance buffer with a second renderer and honours a scissor', async () => {
    const { device, target, cameraBuffer, renderer, clear, upload, read } = await setup();
    const second = createSpriteRenderer(device, {
      capacity: renderer.capacity,
      camera: cameraBuffer.buffer,
      buffer: renderer.buffer,
      label: 'test sprites b',
    });
    second.settings.shape = 'disc';
    second.settings.minPixels = 0;
    second.settings.intensity = 3;
    const left: [number, number, number] = [-2, 0, 0];
    const right: [number, number, number] = [2, 0, 0];
    await expectValid(device, async () => {
      upload([
        { position: left, size: 1, color: [1, 1, 1] },
        { position: right, size: 1, color: [1, 1, 1] },
      ]);
      const encoder = device.createCommandEncoder();
      clear(encoder);
      const view = target.createView();
      renderer.draw(encoder, { target: view, scissor: [0, 0, SIZE / 2, SIZE] });
      second.draw(encoder, { target: view, scissor: [SIZE / 2, 0, SIZE / 2, SIZE], count: 2 });
      device.queue.submit([encoder.finish()]);
    });
    const at = await read();
    closeTo(at(left), [1, 1, 1, 0.5], 3e-3);
    closeTo(at(right), [3, 3, 3, 0.5], 6e-3);
    second.destroy();
    // The buffer belongs to the first renderer and is still usable after the second is gone.
    await expectValid(device, () => upload([{ position: left, size: 1, color: [1, 1, 1] }]));
  });

  it('rejects more sprites than it was created for', async () => {
    const { device, renderer } = await setup({ capacity: 2 });
    expect(() => renderer.update(new Float32Array(SPRITE_FLOATS * 3), 3)).toThrow(RangeError);
    expect(() => renderer.update(new Float32Array(SPRITE_FLOATS), 2)).toThrow(RangeError);
    expect(() => createSpriteRenderer(device, { capacity: 0, camera: renderer.buffer })).toThrow(
      RangeError,
    );
    expect(renderer.count).toBe(0);
    await expectValid(device, () => renderer.update(new Float32Array(SPRITE_FLOATS * 2), 2));
    expect(renderer.count).toBe(2);
  });
});

// --- The soft-sprites scene's CPU animation ----------------------------------------------------------

describe('soft-sprites particles', () => {
  const options = { count: 1200, sparks: 0.3, size: 1, puffs: 1 };

  it('is a pure function of the clock: full from the first call and repeatable', () => {
    const a = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    const b = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    const count = simulate(a, 40, options);
    // Another clock in between must leave nothing behind.
    simulate(b, 7.25, options);
    expect(simulate(b, 40, options)).toBe(count);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(count).toBeGreaterThan(1200);
    expect(count).toBeLessThanOrEqual(MAX_SPRITES);

    let lit = 0;
    const kinds = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const sprite = a.subarray(i * SPRITE_FLOATS, (i + 1) * SPRITE_FLOATS);
      for (const value of sprite) expect(Number.isFinite(value)).toBe(true);
      expect(sprite[3]).toBeGreaterThan(0);
      // Nothing is ever below the ground or radiates negative light.
      expect(sprite[1]).toBeGreaterThan(0);
      expect(sprite[11]).toBeGreaterThanOrEqual(0);
      const kind = Math.floor(sprite[7]!);
      expect(kind).toBeGreaterThanOrEqual(0);
      expect(kind).toBeLessThanOrEqual(2);
      kinds[kind]!++;
      if (sprite[11]! > 0.5) lit++;
    }
    expect(kinds[0]).toBe(840);
    expect(kinds[1]).toBe(360);
    // Sprites of every age are in the air at once, so most are lit.
    expect(lit).toBeGreaterThan(count * 0.6);
  });

  it('respects the count, the capacity and the puff switch', () => {
    const data = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    expect(simulate(data, 3, { count: 0, sparks: 0.5, size: 1, puffs: 0 })).toBe(0);
    expect(simulate(data, 3, { count: 250, sparks: 1, size: 1, puffs: 0 })).toBe(250);
    expect(simulate(data, 3, { count: 1e9, sparks: 0.5, size: 1, puffs: 0 })).toBe(
      MAX_SPARKS_AND_EMBERS,
    );
    expect(simulate(data, 3, { count: 1e9, sparks: 0.5, size: 1, puffs: 2 })).toBe(MAX_SPRITES);
  });

  it('reports velocities that match how the sprites actually move', () => {
    const dt = 1 / 240;
    const now = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    const soon = new Float32Array(MAX_SPRITES * SPRITE_FLOATS);
    const moving = { ...options, puffs: 0 };
    const count = simulate(now, 12, moving);
    simulate(soon, 12 + dt, moving);
    let checked = 0;
    let matching = 0;
    for (let i = 0; i < count; i++) {
      const o = i * SPRITE_FLOATS;
      const step = [0, 1, 2].map((k) => (soon[o + k]! - now[o + k]!) / dt);
      // A sprite that started a new life in between jumped back to the fire.
      if (Math.hypot(...step) > 40) continue;
      checked++;
      const error = Math.hypot(...step.map((s, k) => s - now[o + 4 + k]!));
      if (error < 0.05 + 0.03 * Math.hypot(...step)) matching++;
    }
    expect(checked).toBeGreaterThan(count * 0.95);
    // Sparks landing within the step are the only ones allowed to disagree.
    expect(matching).toBeGreaterThan(checked * 0.99);
  });
});

describe('soft-sprites effect', () => {
  // The lifecycle test runs the defaults only; the split view has scissor rectangles to get wrong.
  it.each([
    [96, 54],
    [33, 21],
    [3, 2],
    [1, 1],
  ])(
    'draws every intersection mode and shape without a validation error at %ix%i',
    async (w, h) => {
      const device = await getTestDevice();
      await expectValid(device, async () => {
        const mounted = await mountHeadless('soft-sprites', { width: w, height: h });
        for (const intersection of ['soft', 'hard', 'split', 'off']) {
          for (const shape of ['auto', 'disc', 'gaussian', 'ember', 'streak']) {
            Object.assign(mounted.params, { intersection, shape });
            mounted.step();
          }
        }
        Object.assign(mounted.params, { count: 0, puffs: 0 });
        mounted.step();
        await device.queue.onSubmittedWorkDone();
        mounted.destroy();
      });
    },
  );

  it('shows the hard cut on the left of the split view and not on the right', async () => {
    // Same frame three ways. Where sprites meet geometry, hard and soft differ; so each half of
    // the split view must match its own mode and differ from the other.
    const size = { width: 160, height: 90 };
    const params = { puffs: 4, count: 300, bloom: 0, size: 2 };
    const render = async (intersection: string) => {
      const mounted = await mountHeadless('soft-sprites', {
        ...size,
        params: { ...params, intersection },
      });
      mounted.step();
      const pixels = await mounted.read();
      mounted.destroy();
      return pixels;
    };
    const [hard, soft, split] = [await render('hard'), await render('soft'), await render('split')];
    const difference = (a: Uint8Array, b: Uint8Array, fromX: number, toX: number) => {
      let sum = 0;
      for (let y = 0; y < size.height; y++) {
        for (let x = fromX; x < toX; x++) {
          const o = (y * size.width + x) * 4;
          sum += Math.abs(a[o]! - b[o]!) + Math.abs(a[o + 1]! - b[o + 1]!);
        }
      }
      return sum;
    };
    const middle = size.width / 2;
    // Two columns either side of the seam are left out: it is two pixels wide.
    expect(difference(hard, soft, 0, middle - 2)).toBeGreaterThan(2000);
    expect(difference(hard, soft, middle + 2, size.width)).toBeGreaterThan(2000);
    expect(difference(split, hard, 0, middle - 2)).toBe(0);
    expect(difference(split, soft, middle + 2, size.width)).toBe(0);
    // Soft only ever removes light relative to hard.
    let brighter = 0;
    for (let i = 0; i < hard.length; i += 4) if (soft[i]! > hard[i]! + 1) brighter++;
    expect(brighter).toBe(0);
  });
});
