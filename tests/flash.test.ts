import { describe, expect, it, vi } from 'vitest';
import { listEffects } from '../src/effects/registry.ts';
import {
  analyseFlashes,
  findTransitions,
  maxFlashesPerWindow,
  measureFlashes,
  sampleCells,
  SMALL_AREA_PX,
  type CellSample,
} from './flash.ts';

vi.setConfig({ testTimeout: 180_000 });

const cell = (luminance: number, red = 0, saturation = 0): CellSample => ({
  luminance,
  red,
  saturation,
});

/** A square wave between `low` and `high` at `hz`, sampled at 60 fps for `seconds`. */
const square = (hz: number, low: number, high: number, seconds = 3) =>
  Array.from({ length: seconds * 60 }, (_, frame) =>
    Math.floor((frame / 60) * hz * 2) % 2 === 0 ? low : high,
  );

describe('findTransitions', () => {
  it('counts a swing of at least the step and ignores smaller ripples', () => {
    expect([...findTransitions([0.2, 0.25, 0.2, 0.26, 0.21], 0.1)]).toEqual([0, 0, 0, 0, 0]);
    expect([...findTransitions([0.2, 0.35, 0.2, 0.35], 0.1)]).toEqual([0, 1, -1, 1]);
  });

  it('follows a slow ramp as one transition, not one per frame', () => {
    const ramp = Array.from({ length: 30 }, (_, i) => i / 29);
    expect(findTransitions(ramp, 0.1).filter((t) => t !== 0)).toHaveLength(1);
  });

  it('measures the return swing from the turning point, not from where the rise began', () => {
    // Up to 0.6, sag to 0.55 (not a transition), then down to 0.45: 0.15 below the peak.
    expect([...findTransitions([0.2, 0.6, 0.55, 0.45], 0.1)]).toEqual([0, 1, 0, -1]);
  });

  it('honours the veto', () => {
    const bright = findTransitions([0.85, 1, 0.85, 1], 0.1, (from, to) => Math.min(from, to) < 0.8);
    expect([...bright]).toEqual([0, 0, 0, 0]);
  });
});

describe('maxFlashesPerWindow', () => {
  it('counts opposing pairs inside the busiest window', () => {
    const transitions = findTransitions(square(4, 0.1, 0.6), 0.1);
    expect(maxFlashesPerWindow(transitions, 60)).toBe(4);
    expect(maxFlashesPerWindow(findTransitions(square(1, 0.1, 0.6), 0.1), 60)).toBe(1);
  });
});

describe('sampleCells', () => {
  it('averages linear light per cell and measures red', () => {
    // 2 x 1 pixels: pure red, then white.
    const rgba = new Uint8Array([255, 0, 0, 255, 255, 255, 255, 255]);
    const [red, white] = sampleCells(rgba, 2, 1, 2, 1);
    expect(red!.luminance).toBeCloseTo(0.2126, 4);
    expect(red!.saturation).toBeCloseTo(1, 4);
    expect(red!.red).toBeCloseTo(320, 3);
    expect(white!.luminance).toBeCloseTo(1, 4);
    expect(white!.red).toBe(0);
  });
});

describe('analyseFlashes', () => {
  const run = (signal: number[], cellsFlashing: number, total = 100, cellAreaPx = 1000) =>
    analyseFlashes({
      cells: signal.map((value) =>
        Array.from({ length: total }, (_, index) => cell(index < cellsFlashing ? value : 0.2)),
      ),
      cellAreaPx,
      fps: 60,
    });

  it('passes a steady image as none', () => {
    expect(run(square(5, 0.3, 0.3), 100).verdict).toBe('none');
  });

  it('rates fast flashing over a small area as low', () => {
    const report = run(square(5, 0.1, 0.6), 5);
    expect(report.peakCellFlashes).toBeGreaterThan(3);
    expect(report.flashingAreaPx).toBe(5000);
    expect(report.flashingAreaPx).toBeLessThan(SMALL_AREA_PX);
    expect(report.verdict).toBe('low');
  });

  it('rates fast flashing over a large area as high', () => {
    const report = run(square(5, 0.1, 0.6), 40);
    expect(report.flashingAreaPx).toBeGreaterThanOrEqual(SMALL_AREA_PX);
    expect(report.verdict).toBe('high');
  });

  it('allows large slow pulsing: three flashes a second is the limit, not the offence', () => {
    expect(run(square(3, 0.1, 0.6), 100).verdict).toBe('low');
    expect(run(square(4, 0.1, 0.6), 100).verdict).toBe('high');
  });

  it('ignores swings smaller than a tenth of full white, however fast', () => {
    expect(run(square(10, 0.3, 0.38), 100).verdict).toBe('none');
  });

  it('catches a saturated red flash that barely moves luminance', () => {
    // Deep red on and off: luminance swings 0.2126 * 0.3 = 0.064, under the general threshold.
    const frames = square(5, 0, 1).map((on) =>
      Array.from({ length: 100 }, () => cell(on * 0.064, on * 96, on ? 1 : 0)),
    );
    const report = analyseFlashes({ cells: frames, cellAreaPx: 1000, fps: 60 });
    expect(report.peakCellFlashes).toBe(0);
    expect(report.peakCellRedFlashes).toBeGreaterThan(3);
    expect(report.verdict).toBe('high');
  });
});

// Every effect, at its default settings, must stay under the threshold, and must not claim to be
// calmer than it measures. `high` is allowed only when the scorecard says so.
const ORDER = { none: 0, low: 1, high: 2 } as const;

// Seconds of every effect is too much for a software rasteriser, so CI sets FLASH_SWEEP=0.
describe.skipIf(process.env.FLASH_SWEEP === '0')('registered effects against WCAG 2.3.1', () => {
  it.each(listEffects().map((meta) => [meta.id, meta.scorecard?.flash] as const))(
    '%s is no flashier than its scorecard says (%s)',
    async (id, declared) => {
      const report = await measureFlashes(id, { seconds: 4 });
      const claimed = declared === undefined || declared === 'unmeasured' ? 'low' : declared;
      expect(
        ORDER[report.verdict],
        `${id} measured "${report.verdict}": ${JSON.stringify(report)}`,
      ).toBeLessThanOrEqual(ORDER[claimed]);
    },
  );
});
