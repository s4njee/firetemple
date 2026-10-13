import { describe, expect, it, vi } from 'vitest';
import {
  SPARK_MIN_PIXELS,
  SPARK_RADIUS,
  SPARKS_PER_AREA,
  sparkGrid,
} from '../src/effects/sparks/grid.ts';
import { measureFlashes } from './flash.ts';
import { mountHeadless, type HeadlessEffect } from './headless.ts';

// Epic 4, stories 4.4 (fireplace), 4.6 (ember bed) and 4.9 (stateless sparks): the claims their
// notes make that can be put as numbers.

vi.setConfig({ testTimeout: 120_000 });

const DEGREES = Math.PI / 180;

describe('sparkGrid', () => {
  const base = {
    density: 1,
    size: 1,
    streak: 0.012,
    source: 0.55,
    spread: 12 * DEGREES,
    aspect: 16 / 9,
  };

  it('gives the number of sparks per area that was asked for', () => {
    for (const density of [0.25, 1, 2, 4]) {
      const grid = sparkGrid({ ...base, density });
      const perArea = grid.fill / (grid.laneWidth * grid.slotLength);
      expect(perArea).toBeCloseTo(SPARKS_PER_AREA * density, 6);
      expect(grid.fill).toBeGreaterThan(0);
      expect(grid.fill).toBeLessThanOrEqual(0.92);
    }
  });

  it('keeps every spark inside its slot and its lane', () => {
    for (const streak of [0, 0.012, 0.13, 0.3]) {
      for (const size of [0.3, 1, 3]) {
        const grid = sparkGrid({ ...base, streak, size, density: 4 });
        // The largest spark the shader draws: 1.45 radii, on the fastest lane (1.4 times the streak).
        const radius = 1.45 * grid.size;
        expect(grid.slotLength).toBeGreaterThan(1.4 * streak + 2 * radius);
        expect(grid.laneWidth).toBeGreaterThanOrEqual(2 * radius);
        expect(grid.size).toBeCloseTo(SPARK_RADIUS * size, 9);
      }
    }
  });

  it('never lets a spark shrink below a pixel and a half on a small canvas', () => {
    expect(sparkGrid({ ...base, pixel: 1 / 1080 }).size).toBeCloseTo(SPARK_RADIUS, 9);
    expect(sparkGrid({ ...base, pixel: 1 / 270 }).size).toBeCloseTo(SPARK_MIN_PIXELS / 270, 9);
    expect(sparkGrid({ ...base, pixel: 1 / 270, size: 2 }).size).toBeCloseTo(3 / 270, 9);
  });

  it('puts the virtual origin where rays through the ends of the emitter meet', () => {
    const grid = sparkGrid(base);
    const halfSource = 0.5 * base.source * base.aspect;
    expect(Math.atan(halfSource / grid.focal)).toBeCloseTo(base.spread, 6);
    // A point source, and any fan wider than a half plane, has no distance behind it.
    expect(sparkGrid({ ...base, source: 0 }).focal).toBe(0);
    expect(sparkGrid({ ...base, spread: 120 * DEGREES }).focal).toBe(0);
    // A nearly parallel fan is capped, and the angle is never zero.
    expect(sparkGrid({ ...base, spread: 0 }).focal).toBeLessThanOrEqual(40);
    expect(sparkGrid({ ...base, spread: 0 }).spread).toBeGreaterThan(0);
    expect(sparkGrid({ ...base, spread: 9 }).spread).toBeCloseTo(Math.PI, 9);
  });
});

/** Which pixels are lit at all: a picture of where things are that ignores how bright they are. */
async function litMask(mounted: HeadlessEffect, threshold: number): Promise<Uint8Array> {
  await mounted.device.queue.onSubmittedWorkDone();
  const rgba = await mounted.read();
  const mask = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = Math.max(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!) > threshold ? 1 : 0;
  }
  return mask;
}

const differing = (a: Uint8Array, b: Uint8Array) =>
  a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0);
const count = (a: Uint8Array) => a.reduce((n, v) => n + v, 0);

describe('sparks', () => {
  // The CPU wraps the distance travelled at 256 canvas heights so f32 stays precise; the shader
  // rounds every lane's speed to a whole number of slots per wrap. If that works, the frame after
  // the wrap looks like any other next frame. One simulated frame is a second here, so the
  // distance per frame is the `speed` parameter.
  it('wraps its travelled distance without a jump', async () => {
    const mounted = await mountHeadless('sparks', {
      width: 256,
      height: 144,
      fps: 1,
      params: { density: 3, turbulence: 0, speed: 4, alpha: 'opaque', bloom: 0 },
    });
    mounted.step(63); // 252
    mounted.params.speed = 3.999;
    mounted.step(); // 255.999
    const before = await litMask(mounted, 24);
    // 0.002 canvas heights is under half a pixel here, even in the nearest layer.
    mounted.params.speed = 0.002;
    mounted.step(); // 256.001, wrapped to 0.001
    const across = await litMask(mounted, 24);
    mounted.step(); // 0.003
    const after = await litMask(mounted, 24);
    mounted.params.speed = 4;
    mounted.step(); // 4.003: every spark somewhere else
    const elsewhere = await litMask(mounted, 24);
    mounted.destroy();

    const lit = count(across);
    expect(lit).toBeGreaterThan(40);
    const ordinary = differing(across, after);
    const wrap = differing(before, across);
    const reshuffle = differing(after, elsewhere);
    // The same small step on both sides of the wrap; a reshuffle changes most lit pixels twice.
    expect(reshuffle).toBeGreaterThan(lit);
    expect(wrap).toBeLessThan(0.25 * reshuffle);
    expect(wrap).toBeLessThanOrEqual(2 * ordinary + 0.1 * lit);
  });

  it('draws nothing along the top edge, so the canvas rectangle never shows', async () => {
    const mounted = await mountHeadless('sparks', {
      width: 256,
      height: 144,
      params: { density: 4, reach: 1.5, speed: 1, alpha: 'opaque', bloom: 0 },
    });
    await mounted.runTo(1);
    const mask = await litMask(mounted, 2);
    mounted.destroy();
    // The fade reaches zero 1% of the height below the edge: the top row here.
    expect(count(mask.subarray(0, 256))).toBe(0);
    expect(count(mask)).toBeGreaterThan(40);
  });
});

describe('fireplace', () => {
  /** Mean of the red channel over the band above the logs, where only flames can put light. */
  async function flameLight(preset: string): Promise<number> {
    const width = 192;
    const height = 108;
    const mounted = await mountHeadless('fireplace', {
      width,
      height,
      preset,
      params: { bloom: 0, embers: 0, glow: 0 },
    });
    let sum = 0;
    for (const seconds of [1, 1.5, 2]) {
      await mounted.runTo(seconds);
      const rgba = await mounted.read();
      for (let y = Math.round(0.3 * height); y < Math.round(0.55 * height); y++) {
        for (let x = Math.round(0.35 * width); x < Math.round(0.65 * width); x++) {
          sum += rgba[(y * width + x) * 4]!;
        }
      }
    }
    mounted.destroy();
    return sum;
  }

  it('orders its presets by how much flame they show', async () => {
    const dying = await flameLight('dying embers');
    const low = await flameLight('low fire');
    const evening = await flameLight('evening');
    const roaring = await flameLight('roaring');
    expect(low).toBeGreaterThan(dying);
    expect(evening).toBeGreaterThan(1.5 * low);
    expect(roaring).toBeGreaterThan(1.5 * evening);
  });

  // The flames scroll the shared noise tile (8 cells) at multiples of 1/8 of `rise`, which the
  // CPU wraps at 64. One simulated frame is a second, and `rise` advances by 1.15 * speed.
  it('wraps the flame scroll without a jump', async () => {
    const mounted = await mountHeadless('fireplace', {
      width: 192,
      height: 108,
      fps: 1,
      params: { bloom: 0, embers: 0, flicker: 0, speed: 2 },
    });
    const picture = async () => {
      await mounted.device.queue.onSubmittedWorkDone();
      return mounted.read();
    };
    const distance = (a: Uint8Array, b: Uint8Array) =>
      a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
    mounted.step(27); // 62.1
    mounted.params.speed = 1.89 / 1.15;
    mounted.step(); // 63.99
    const before = await picture();
    mounted.params.speed = 0.02 / 1.15;
    mounted.step(); // 64.01, wrapped to 0.01
    const across = await picture();
    mounted.step(); // 0.03
    const after = await picture();
    mounted.params.speed = 2;
    mounted.step(); // 2.33: different flames
    const elsewhere = await picture();
    mounted.destroy();

    const reshuffle = distance(after, elsewhere);
    expect(reshuffle).toBeGreaterThan(1);
    expect(distance(before, across)).toBeLessThan(0.2 * reshuffle);
    expect(distance(before, across)).toBeLessThanOrEqual(2 * distance(across, after) + 0.3);
  });
});

// Seconds of rendering; CI's software rasteriser skips the flash sweep the same way.
describe.skipIf(process.env.FLASH_SWEEP === '0')('ember-bed', () => {
  it('is calm: no cell ever completes a flash and the frame mean barely moves', async () => {
    const report = await measureFlashes('ember-bed', { seconds: 6 });
    expect(report.verdict).toBe('none');
    // Largest swing of the whole frame's mean relative luminance, as a fraction of white.
    expect(report.frameLuminanceRange).toBeLessThan(0.02);
  });

  it('still changes: regions brighten and dim over seconds', async () => {
    const mounted = await mountHeadless('ember-bed', {
      width: 192,
      height: 108,
      params: { bloom: 0 },
    });
    await mounted.runTo(1);
    const early = await mounted.read();
    await mounted.runTo(9);
    const late = await mounted.read();
    mounted.destroy();
    let changed = 0;
    for (let i = 0; i < early.length; i += 4) {
      if (Math.abs(early[i]! - late[i]!) > 24) changed++;
    }
    expect(changed / (early.length / 4)).toBeGreaterThan(0.05);
  });
});
