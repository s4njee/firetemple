import { describe, expect, it } from 'vitest';
import { createExcitation, EXCITATIONS, follow } from '../src/gpu/sim/excitation.ts';
import {
  collectIgniters,
  createAmbientIgnition,
  createPointerIgnition,
  IgnitersUniform,
  MAX_IGNITERS,
  pathSegments,
  writeIgniters,
} from '../src/gpu/sim/ignition.ts';
import { createUniformBuffer } from '../src/gpu/uniforms.ts';
import ignite from '../src/wgsl/ignite.wgsl';
import { getTestDevice } from './gpu.ts';
import { fakeCanvas, sendPointer } from './headless.ts';
import { gpuF32, lane, rowsOf } from './wgsl-eval.ts';

// The shared inputs of every simulation (stories 5.2, 5.7, 5.8): where heat is added, and how
// hard the outside world is driving it.

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('ignite.wgsl', () => {
  it('declares the same uniform block as the TypeScript side', () => {
    expect(squash(ignite.code)).toContain(squash(IgnitersUniform.wgsl));
    expect(ignite.code).toContain(`const IGNITE_MAX: u32 = ${MAX_IGNITERS}u;`);
  });

  // f(x): x.xy = uv, x.z = aspect; one drag from (0.25, 0.5) to (0.75, 0.5), radius 0.1, strength 2.
  const DRAG = `#include "ignite.wgsl"
    fn f(x: vec4f) -> vec4f {
      let segment = vec4f(0.25, 0.5, 0.75, 0.5);
      let shape = vec4f(0.1, 2.0, 0.0, 0.0);
      return vec4f(ignite_one(x.xy, x.z, segment, shape), ignite_distance(x.xy, x.z, segment), 0.0, 0.0);
    }`;

  it('is full strength on the stroke, falls to exactly zero at the radius, and never goes negative', async () => {
    const out = await gpuF32(
      DRAG,
      rowsOf([
        [0.5, 0.5, 1, 0], // on the stroke
        [0.25, 0.5, 1, 0], // its start
        [0.5, 0.55, 1, 0], // half a radius away
        [0.5, 0.6, 1, 0], // at the radius
        [0.5, 0.9, 1, 0], // far away
        [0.1, 0.5, 1, 0], // beyond the start, 0.15 away
      ]),
    );
    const heat = lane(out, 0);
    expect(heat[0]).toBeCloseTo(2, 5);
    expect(heat[1]).toBeCloseTo(2, 5);
    expect(heat[2]).toBeCloseTo(1, 4);
    expect(heat[3]).toBeCloseTo(0, 5);
    expect(heat[4]).toBe(0);
    expect(heat[5]).toBe(0);
    expect(Math.min(...heat)).toBeGreaterThanOrEqual(0);
  });

  it('measures in canvas heights, so an igniter is round on a wide canvas', async () => {
    // On a 2:1 canvas, 0.05 of the width is as far as 0.1 of the height.
    const out = await gpuF32(
      DRAG,
      rowsOf([
        [0.8, 0.5, 2, 0], // 0.05 in u past the end = 0.1 heights
        [0.75, 0.6, 2, 0], // 0.1 in v below the end
      ]),
    );
    const distance = lane(out, 1);
    expect(distance[0]).toBeCloseTo(0.1, 5);
    expect(distance[1]).toBeCloseTo(0.1, 5);
  });

  it('treats a tap as a point and a zero radius as nothing', async () => {
    const out = await gpuF32(
      `#include "ignite.wgsl"
       fn f(x: vec4f) -> vec4f {
         let tap = vec4f(0.5, 0.5, 0.5, 0.5);
         return vec4f(
           ignite_one(x.xy, 1.0, tap, vec4f(0.2, 1.0, 0.0, 0.0)),
           ignite_one(x.xy, 1.0, tap, vec4f(0.0, 1.0, 0.0, 0.0)),
           0.0, 0.0);
       }`,
      rowsOf([
        [0.5, 0.5, 0, 0],
        [0.6, 0.5, 0, 0],
        [0.7, 0.5, 0, 0],
      ]),
    );
    expect(lane(out, 0)[0]).toBeCloseTo(1, 5);
    expect(lane(out, 0)[1]).toBeCloseTo(0.5, 4);
    expect(lane(out, 0)[2]).toBeCloseTo(0, 5);
    expect([...lane(out, 1)]).toEqual([0, 0, 0]);
  });
});

describe('igniter list', () => {
  it('packs igniters into the block and caps the count', async () => {
    const device = await getTestDevice();
    const uniforms = createUniformBuffer(device, IgnitersUniform, 'test igniters');
    const many = Array.from({ length: MAX_IGNITERS + 5 }, (_, i) => ({
      fromX: i,
      fromY: 0,
      toX: i,
      toY: 1,
      radius: 0.1,
      strength: 2,
    }));
    expect(() => writeIgniters(uniforms, many, 16 / 9)).not.toThrow();
    expect(() => writeIgniters(uniforms, [], 0)).not.toThrow();
    uniforms.destroy();
  });

  it('thins a long path to its budget without breaking the stroke', () => {
    const path = Array.from({ length: 9 }, (_, i) => ({ x: i / 8, y: 0.5 }));
    expect(pathSegments(path, 16)).toHaveLength(8);
    const thinned = pathSegments(path, 2);
    expect(thinned).toEqual([
      [0, 0.5, 0.5, 0.5],
      [0.5, 0.5, 1, 0.5],
    ]);
    // A tap is one point; nothing in, nothing out.
    expect(pathSegments([{ x: 0.3, y: 0.4 }], 4)).toEqual([[0.3, 0.4, 0.3, 0.4]]);
    expect(pathSegments([], 4)).toEqual([]);
    expect(pathSegments(path, 0)).toEqual([]);
  });

  it('puts earlier sources first and stops at the cap', () => {
    const source = (count: number, strength: number) => ({
      collect: () =>
        Array.from({ length: count }, () => ({
          fromX: 0,
          fromY: 0,
          toX: 0,
          toY: 0,
          radius: 0.1,
          strength,
        })),
      destroy() {},
    });
    const all = collectIgniters(1 / 60, source(10, 1), source(10, 2));
    expect(all).toHaveLength(MAX_IGNITERS);
    expect(all.filter((igniter) => igniter.strength === 1)).toHaveLength(10);
  });
});

describe('pointer ignition', () => {
  it('lights on a press, draws along a drag, and ignores a hovering mouse', () => {
    const canvas = fakeCanvas(400, 200);
    const pointer = createPointerIgnition(canvas, { radius: 0.05, strength: 3 });

    sendPointer(canvas, 'pointermove', 0.2, 0.5, 10);
    expect(pointer.collect(1 / 60)).toEqual([]);

    sendPointer(canvas, 'pointerdown', 0.2, 0.5, 20);
    const tap = pointer.collect(1 / 60);
    expect(tap.length).toBeGreaterThan(0);
    expect(tap.at(-1)).toMatchObject({ toX: 0.2, toY: 0.5, radius: 0.05, strength: 3 });
    expect(pointer.pressed).toBe(1);

    sendPointer(canvas, 'pointermove', 0.4, 0.5, 30);
    sendPointer(canvas, 'pointermove', 0.6, 0.6, 40);
    const drag = pointer.collect(1 / 60);
    // The stroke starts where the last step left off and ends at the pointer: no gap.
    expect(drag[0]).toMatchObject({ fromX: 0.2, fromY: 0.5 });
    expect(drag.at(-1)).toMatchObject({ toX: 0.6, toY: 0.6 });
    for (let i = 1; i < drag.length; i++) {
      expect([drag[i]!.fromX, drag[i]!.fromY]).toEqual([drag[i - 1]!.toX, drag[i - 1]!.toY]);
    }

    sendPointer(canvas, 'pointerup', 0.6, 0.6, 50);
    pointer.collect(1 / 60);
    sendPointer(canvas, 'pointermove', 0.7, 0.6, 60);
    expect(pointer.collect(1 / 60)).toEqual([]);
    pointer.destroy();
  });

  it('follows several touches at once within the igniter budget', () => {
    const canvas = fakeCanvas(400, 200);
    const pointer = createPointerIgnition(canvas);
    for (let id = 1; id <= 3; id++) sendPointer(canvas, 'pointerdown', id * 0.2, 0.5, 10, id);
    pointer.collect(1 / 60);
    for (let id = 1; id <= 3; id++) {
      for (let step = 1; step <= 12; step++) {
        sendPointer(canvas, 'pointermove', id * 0.2, 0.5 - step * 0.02, 10 + step, id);
      }
    }
    const igniters = pointer.collect(1 / 60);
    expect(pointer.pressed).toBe(3);
    expect(igniters.length).toBeLessThanOrEqual(MAX_IGNITERS);
    // Every finger keeps its whole stroke, from where it was to where it is.
    for (let id = 1; id <= 3; id++) {
      const own = igniters.filter((igniter) => Math.abs(igniter.fromX - id * 0.2) < 1e-9);
      expect(own.length).toBeGreaterThan(0);
      expect(own[0]!.fromY).toBeCloseTo(0.5, 9);
      expect(own.at(-1)!.toY).toBeCloseTo(0.5 - 12 * 0.02, 9);
    }
    pointer.destroy();
  });

  it('can be told to light under a hovering pointer, more weakly', () => {
    const canvas = fakeCanvas(400, 200);
    const pointer = createPointerIgnition(canvas, { strength: 2, hover: 0.25 });
    sendPointer(canvas, 'pointermove', 0.3, 0.3, 10);
    sendPointer(canvas, 'pointermove', 0.4, 0.3, 20);
    const igniters = pointer.collect(1 / 60);
    expect(igniters.length).toBeGreaterThan(0);
    expect(igniters[0]!.strength).toBeCloseTo(0.5, 9);
    pointer.destroy();
  });
});

describe('ambient ignition', () => {
  const count = (rate: number, dt: number, steps: number, seed = 7) => {
    const embers = createAmbientIgnition({ rate, seed });
    let total = 0;
    for (let i = 0; i < steps; i++) total += embers.collect(dt).length;
    return total;
  };

  it('arrives at the asked rate, whatever the step length', () => {
    // 2 a second for 600 seconds: about 1200, give or take a few standard deviations (35).
    expect(count(2, 1 / 60, 36_000)).toBeGreaterThan(1080);
    expect(count(2, 1 / 60, 36_000)).toBeLessThan(1320);
    expect(count(2, 1 / 15, 9_000)).toBeGreaterThan(1080);
    expect(count(2, 1 / 15, 9_000)).toBeLessThan(1320);
  });

  it('is repeatable from its seed and silent at rate 0', () => {
    const run = (seed: number) => {
      const embers = createAmbientIgnition({ rate: 3, seed });
      return Array.from({ length: 200 }, () => embers.collect(1 / 30)).flat();
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
    expect(count(0, 1 / 60, 600)).toBe(0);
  });

  it('lands inside its region and never floods one step', () => {
    const embers = createAmbientIgnition({ rate: 50, region: [0.2, 0.8, 0.6, 1], radius: 0.03 });
    const all = Array.from({ length: 300 }, () => embers.collect(0.5));
    expect(Math.max(...all.map((step) => step.length))).toBeLessThanOrEqual(4);
    for (const igniter of all.flat()) {
      expect(igniter.toX).toBeGreaterThanOrEqual(0.2);
      expect(igniter.toX).toBeLessThanOrEqual(0.6);
      expect(igniter.toY).toBeGreaterThanOrEqual(0.8);
      expect(igniter.toY).toBeLessThanOrEqual(1);
      expect(igniter.radius).toBe(0.03);
    }
  });

  it('takes new settings while running', () => {
    const embers = createAmbientIgnition({ rate: 0 });
    expect(embers.collect(10)).toEqual([]);
    embers.rate = 100;
    embers.strength = 0.5;
    const lit = embers.collect(1);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit[0]!.strength).toBe(0.5);
  });
});

describe('excitation', () => {
  it('rises fast and falls slowly, the same at any frame rate', () => {
    const run = (dt: number, seconds: number, input: number, start: number) => {
      let level = start;
      for (let t = 0; t < seconds - 1e-9; t += dt) level = follow(level, input, dt, 0.08, 0.7);
      return level;
    };
    // After 0.08 s of full input: 1 - 1/e. After 0.7 s of silence from 1: 1/e.
    expect(run(1 / 60, 0.08, 1, 0)).toBeCloseTo(1 - Math.exp(-0.08 / 0.08), 1);
    expect(run(1 / 240, 0.7, 0, 1)).toBeCloseTo(Math.exp(-1), 2);
    expect(run(1 / 30, 0.7, 0, 1)).toBeCloseTo(run(1 / 120, 0.7, 0, 1), 2);
    // Inputs are clamped, and nonsense counts as silence.
    expect(follow(0, 5, 10, 0.08, 0.7)).toBeLessThanOrEqual(1);
    expect(follow(0.5, Number.NaN, 100, 0.08, 0.7)).toBeCloseTo(0, 6);
    expect(follow(0.5, 1, 0, 0.08, 0.7)).toBe(0.5);
  });

  it('is inert without a DOM and for the kind "none"', () => {
    const canvas = fakeCanvas(100, 100);
    for (const kind of EXCITATIONS) {
      const drive = createExcitation(kind, canvas);
      expect(drive.kind).toBe(kind);
      for (let i = 0; i < 30; i++) expect(drive.update(1 / 60)).toBe(0);
      expect(drive.level).toBe(0);
      drive.destroy();
    }
    expect(createExcitation('nonsense', canvas).kind).toBe('none');
  });
});
