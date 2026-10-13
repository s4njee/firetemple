import { mountHeadless } from './headless.ts';

// A flash analyser for WCAG 2.2 success criterion 2.3.1, "Three Flashes or Below Threshold".
//
// The criterion: content must not flash more than three times in any one-second period, unless
// the flashing area is small. Its definitions, as used here:
//
// - General flash: a pair of opposing changes in relative luminance of 10% or more of the maximum
//   (1.0), where the darker state is below 0.80.
// - Red flash: a pair of opposing transitions involving a saturated red, R / (R + G + B) >= 0.8
//   in either state, where (R - G - B) * 320 changes by more than 20 (negatives count as zero).
// - Small: the flashing area is under 25% of any 10-degree field of view, which the criterion
//   equates to a 341 x 256 block of CSS pixels at a 1024 x 768 viewing size: 21 824 px^2.
//
// What this does: renders the effect headlessly at 60 fps, divides the frame into a grid of
// cells, and follows each cell's mean relative luminance and red signal. A cell that swings far
// enough registers a transition; two opposing transitions are a flash. A window fails when more
// than three flashes happen inside one second over enough cells to exceed the area threshold.
//
// It is deliberately conservative: the flashing cells need not be contiguous or inside one
// 10-degree field, and the canvas is assumed to be shown at one CSS pixel per rendered pixel
// times `displayScale`. It is not a certified tool (the reference analyser is PEAT); it exists
// so `scorecard.flash` is a measurement rather than a guess.

export const FLASH_LIMIT = 3;
export const LUMINANCE_STEP = 0.1;
export const DARK_CEILING = 0.8;
export const RED_SATURATION = 0.8;
export const RED_STEP = 20;
/** 25% of a 341 x 256 block, in CSS pixels squared. */
export const SMALL_AREA_PX = 341 * 256 * 0.25;

const srgbToLinear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LINEAR = Float32Array.from({ length: 256 }, (_, byte) => srgbToLinear(byte));

export interface CellSample {
  /** Mean relative luminance of the cell, 0..1. */
  luminance: number;
  /** Mean of max(0, R - G - B) * 320 over the cell. */
  red: number;
  /** Mean of R / (R + G + B) over the cell (0 where the pixel is black). */
  saturation: number;
}

/** Reduces an RGBA8 frame (sRGB-encoded, as displayed) to one sample per grid cell, row by row. */
export function sampleCells(
  rgba: Uint8Array,
  width: number,
  height: number,
  columns: number,
  rows: number,
): CellSample[] {
  const cells: CellSample[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor((row * height) / rows);
    const y1 = Math.floor(((row + 1) * height) / rows);
    for (let column = 0; column < columns; column++) {
      const x0 = Math.floor((column * width) / columns);
      const x1 = Math.floor(((column + 1) * width) / columns);
      let luminance = 0;
      let red = 0;
      let saturation = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const r = LINEAR[rgba[i]!]!;
          const g = LINEAR[rgba[i + 1]!]!;
          const b = LINEAR[rgba[i + 2]!]!;
          luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
          red += Math.max(0, r - g - b) * 320;
          const sum = r + g + b;
          if (sum > 1e-4) saturation += r / sum;
        }
      }
      const count = Math.max(1, (x1 - x0) * (y1 - y0));
      cells.push({
        luminance: luminance / count,
        red: red / count,
        saturation: saturation / count,
      });
    }
  }
  return cells;
}

/**
 * Follows one signal and reports the frames at which it completes a transition: a move of at
 * least `step` away from its last turning point. `qualifies` can veto a transition (the dark
 * ceiling for luminance, saturation for red). Returns +1 / -1 per frame, 0 for no transition.
 */
export function findTransitions(
  values: ArrayLike<number>,
  step: number,
  qualifies: (from: number, to: number, frame: number) => boolean = () => true,
): Int8Array {
  const out = new Int8Array(values.length);
  if (values.length === 0) return out;
  let anchor = values[0]!;
  let direction = 0;
  for (let frame = 1; frame < values.length; frame++) {
    const value = values[frame]!;
    // While still moving the same way, the turning point follows the signal.
    if ((direction > 0 && value > anchor) || (direction < 0 && value < anchor)) {
      anchor = value;
      continue;
    }
    const delta = value - anchor;
    if (Math.abs(delta) >= step && qualifies(anchor, value, frame)) {
      direction = Math.sign(delta);
      out[frame] = direction;
      anchor = value;
    } else if (direction === 0) {
      // No transition yet: let the anchor settle on the extreme seen so far in neither direction.
      continue;
    }
  }
  return out;
}

/** The largest number of flashes (pairs of opposing transitions) inside any window of `window` frames. */
export function maxFlashesPerWindow(transitions: ArrayLike<number>, window: number): number {
  let best = 0;
  let count = 0;
  for (let frame = 0; frame < transitions.length; frame++) {
    if (transitions[frame] !== 0) count++;
    if (frame >= window && transitions[frame - window] !== 0) count--;
    best = Math.max(best, count);
  }
  // Transitions alternate by construction, so n of them make floor(n / 2) opposing pairs.
  return Math.floor(best / 2);
}

export type FlashVerdict = 'none' | 'low' | 'high';

export interface FlashReport {
  verdict: FlashVerdict;
  /** Most flashes any single cell made within one second (luminance, then red). */
  peakCellFlashes: number;
  peakCellRedFlashes: number;
  /** Most flashes of the whole frame's mean luminance within one second. */
  frameFlashes: number;
  /**
   * Largest area, in CSS px^2, flashing more than three times within the same second; the
   * criterion's threshold is `SMALL_AREA_PX`.
   */
  flashingAreaPx: number;
  redFlashingAreaPx: number;
  /** Largest swing of the whole frame's mean relative luminance over the run. */
  frameLuminanceRange: number;
  seconds: number;
  fps: number;
}

export interface FlashFrames {
  /** `cells[frame][cell]`. */
  cells: readonly (readonly CellSample[])[];
  /** Displayed area of one cell in CSS px^2. */
  cellAreaPx: number;
  fps: number;
}

export function analyseFlashes({ cells, cellAreaPx, fps }: FlashFrames): FlashReport {
  const frames = cells.length;
  const cellCount = cells[0]?.length ?? 0;
  const window = Math.round(fps);

  const luminanceTransitions: Int8Array[] = [];
  const redTransitions: Int8Array[] = [];
  let peakCellFlashes = 0;
  let peakCellRedFlashes = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    const luminance = Float32Array.from(cells, (frame) => frame[cell]!.luminance);
    const red = Float32Array.from(cells, (frame) => frame[cell]!.red);
    const saturation = Float32Array.from(cells, (frame) => frame[cell]!.saturation);
    const general = findTransitions(
      luminance,
      LUMINANCE_STEP,
      (from, to) => Math.min(from, to) < DARK_CEILING,
    );
    const saturated = findTransitions(
      red,
      RED_STEP,
      (_from, _to, frame) =>
        saturation[frame]! >= RED_SATURATION || saturation[frame - 1]! >= RED_SATURATION,
    );
    luminanceTransitions.push(general);
    redTransitions.push(saturated);
    peakCellFlashes = Math.max(peakCellFlashes, maxFlashesPerWindow(general, window));
    peakCellRedFlashes = Math.max(peakCellRedFlashes, maxFlashesPerWindow(saturated, window));
  }

  // For each one-second window, how many cells flashed more than the limit inside it.
  const worstArea = (perCell: readonly Int8Array[]) => {
    const counts = new Int32Array(cellCount);
    let worst = 0;
    for (let frame = 0; frame < frames; frame++) {
      let over = 0;
      for (let cell = 0; cell < cellCount; cell++) {
        if (perCell[cell]![frame] !== 0) counts[cell]!++;
        if (frame >= window && perCell[cell]![frame - window] !== 0) counts[cell]!--;
        if (Math.floor(counts[cell]! / 2) > FLASH_LIMIT) over++;
      }
      worst = Math.max(worst, over);
    }
    return worst * cellAreaPx;
  };
  const flashingAreaPx = worstArea(luminanceTransitions);
  const redFlashingAreaPx = worstArea(redTransitions);

  const mean = Float32Array.from(
    cells,
    (frame) => frame.reduce((sum, cell) => sum + cell.luminance, 0) / Math.max(1, cellCount),
  );
  const frameFlashes = maxFlashesPerWindow(
    findTransitions(mean, LUMINANCE_STEP, (from, to) => Math.min(from, to) < DARK_CEILING),
    window,
  );
  let low = Infinity;
  let high = -Infinity;
  for (const value of mean) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }

  const over =
    flashingAreaPx >= SMALL_AREA_PX ||
    redFlashingAreaPx >= SMALL_AREA_PX ||
    frameFlashes > FLASH_LIMIT;
  const any = peakCellFlashes > 0 || peakCellRedFlashes > 0 || frameFlashes > 0;
  return {
    verdict: over ? 'high' : any ? 'low' : 'none',
    peakCellFlashes,
    peakCellRedFlashes,
    frameFlashes,
    flashingAreaPx,
    redFlashingAreaPx,
    frameLuminanceRange: frames > 0 ? high - low : 0,
    seconds: frames / fps,
    fps,
  };
}

export interface MeasureFlashOptions {
  /** Seconds of animation to analyse, after `settle`. Default 6. */
  seconds?: number;
  /** Seconds to run first, so a start-up transient is not counted. Default 1. */
  settle?: number;
  /** Render size. Default 480 x 270. */
  width?: number;
  height?: number;
  /** CSS pixels the effect is shown at per rendered pixel. Default 4 (so 480 x 270 stands for 1920 x 1080). */
  displayScale?: number;
  preset?: string;
  params?: Readonly<Record<string, unknown>>;
}

/** Runs a registered effect headlessly and analyses what it would put on screen. */
export async function measureFlashes(
  id: string,
  options: MeasureFlashOptions = {},
): Promise<FlashReport> {
  const width = options.width ?? 480;
  const height = options.height ?? 270;
  const fps = 60;
  const columns = 24;
  const rows = 14;
  const scale = options.displayScale ?? 4;
  const mounted = await mountHeadless(id, {
    width,
    height,
    fps,
    preset: options.preset,
    params: options.params,
  });
  await mounted.runTo(options.settle ?? 1);
  const cells: CellSample[][] = [];
  const total = Math.round((options.seconds ?? 6) * fps);
  for (let frame = 0; frame < total; frame++) {
    mounted.step();
    cells.push(sampleCells(await mounted.read(), width, height, columns, rows));
  }
  mounted.destroy();
  return analyseFlashes({
    cells,
    cellAreaPx: (width / columns) * (height / rows) * scale * scale,
    fps,
  });
}
