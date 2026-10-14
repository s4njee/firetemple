import { describe, expect, it, vi } from 'vitest';
import {
  AMBIENT,
  DEATH_TEMPERATURE,
  DRAG,
  DRIVE_SHARE,
  emberCapacity,
  emberPhysics,
} from '../src/effects/embers/physics.ts';
import { mountHeadless, sendPointer } from './headless.ts';

// Story 7.2: embers on the particle framework. The physics is checked as numbers, the effect as
// pictures: a sky already full on the first frame, cooling from yellow-orange low down to deep red
// higher up, and a torch that leaves embers along a drag.

vi.setConfig({ testTimeout: 60_000 });

const W = 320;
const H = 180;

/** Pixels whose red channel is over `threshold`, with their position and colour. */
function lit(pixels: Uint8Array, threshold = 40) {
  const out: { x: number; y: number; r: number; g: number }[] = [];
  for (let i = 0; i < W * H; i++) {
    const r = pixels[i * 4]!;
    if (r > threshold)
      out.push({ x: (i % W) / W, y: Math.floor(i / W) / H, r, g: pixels[i * 4 + 1]! });
  }
  return out;
}

describe('ember physics', () => {
  it('cools the mean ember out in its lifetime, rises at the set speed, and drives as a share', () => {
    const inputs = { count: 3000, lifetime: 5, rise: 0.3, temperature: 1900 };
    const calm = emberPhysics(inputs, 0);
    // Newtonian cooling reaches the death temperature after exactly `lifetime`.
    const t = AMBIENT + (1900 - AMBIENT) * Math.exp(-calm.cooling * 5);
    expect(t).toBeCloseTo(DEATH_TEMPERATURE, 6);
    // Terminal speed of a fresh ember: buoyancy (per 1000 K) times the excess over drag.
    expect((calm.buoyancy * (1900 - AMBIENT)) / 1000 / DRAG).toBeCloseTo(0.3, 9);
    // Little's law: the calm rate keeps `count` alive.
    expect(calm.rate * 5).toBeCloseTo(3000, 9);
    // The drive adds at most DRIVE_SHARE of the calm rate, and ignores nonsense.
    expect(emberPhysics(inputs, 1).rate).toBeCloseTo(calm.rate * (1 + DRIVE_SHARE), 9);
    expect(emberPhysics(inputs, 7).rate).toBeCloseTo(calm.rate * (1 + DRIVE_SHARE), 9);
    expect(emberPhysics(inputs, Number.NaN).rate).toBe(calm.rate);
    expect(emberCapacity(2500)).toBe(8192);
    expect(emberCapacity(10)).toBe(1024);
  });
});

describe('embers effect', () => {
  it('starts full, and cools from yellow-orange low down to deep red higher up', async () => {
    const embers = await mountHeadless('embers', {
      width: W,
      height: H,
      params: { pops: 0, wind: 0, bloom: 0, count: 4000, size: 2 },
    });
    embers.step(1);
    const first = lit(await embers.read());
    // Warmed up: hundreds of embers on the very first frame.
    expect(first.length).toBeGreaterThan(200);
    await embers.runTo(2);
    const pixels = lit(await embers.read());
    const band = (y0: number, y1: number) => {
      const inside = pixels.filter((p) => p.y >= y0 && p.y < y1);
      return inside.reduce((sum, p) => sum + p.g / p.r, 0) / Math.max(1, inside.length);
    };
    const low = band(0.8, 1);
    const high = band(0.2, 0.5);
    // Green over red falls as an ember cools: yellow-orange near the source, red above.
    expect(low).toBeGreaterThan(high + 0.1);
    expect(high).toBeLessThan(0.5);
    embers.destroy();
  });

  it('leaves embers along a pointer drag, as a torch', async () => {
    const quiet = {
      pops: 0,
      source: 0.05,
      count: 200,
      rise: 0.05,
      turbulence: 0,
      bloom: 0,
      torch: 2,
      size: 3,
    };
    const count = async (drag: boolean) => {
      const embers = await mountHeadless('embers', { width: W, height: H, params: quiet });
      embers.step(2);
      if (drag) {
        sendPointer(embers.canvas, 'pointerdown', 0.15, 0.3, 0);
        for (let k = 1; k <= 8; k++) {
          sendPointer(embers.canvas, 'pointermove', 0.15 + k * 0.08, 0.3, k * 16);
          embers.step(1);
        }
        sendPointer(embers.canvas, 'pointerup', 0.79, 0.3, 160);
      }
      embers.step(3);
      const pixels = lit(await embers.read(), 25);
      embers.destroy();
      // Left and right of the narrow source, around the stroke's height.
      const near = (x0: number, x1: number) =>
        pixels.filter((p) => p.x >= x0 && p.x < x1 && p.y > 0.15 && p.y < 0.45).length;
      return { left: near(0.15, 0.4), right: near(0.6, 0.8) };
    };
    const without = await count(false);
    const withDrag = await count(true);
    expect(without.left + without.right).toBe(0);
    // Embers along the whole stroke, not only where it began or ended.
    expect(withDrag.left).toBeGreaterThan(10);
    expect(withDrag.right).toBeGreaterThan(10);
  });
});
