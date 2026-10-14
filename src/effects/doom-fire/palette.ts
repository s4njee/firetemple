import type { RampFn, Rgb } from '../../gpu/emission/ramp-texture.ts';

/*
 * The fire palette of the PSX Doom title screen, as listed in Fabien Sanglard's article: 37
 * colours, heat 0 (nearly black) to heat 36 (white), as sRGB bytes.
 */
export const DOOM_PALETTE: readonly (readonly [number, number, number])[] = [
  [0x07, 0x07, 0x07],
  [0x1f, 0x07, 0x07],
  [0x2f, 0x0f, 0x07],
  [0x47, 0x0f, 0x07],
  [0x57, 0x17, 0x07],
  [0x67, 0x1f, 0x07],
  [0x77, 0x1f, 0x07],
  [0x8f, 0x27, 0x07],
  [0x9f, 0x2f, 0x07],
  [0xaf, 0x3f, 0x07],
  [0xbf, 0x47, 0x07],
  [0xc7, 0x47, 0x07],
  [0xdf, 0x4f, 0x07],
  [0xdf, 0x57, 0x07],
  [0xdf, 0x57, 0x07],
  [0xd7, 0x5f, 0x07],
  [0xd7, 0x5f, 0x07],
  [0xd7, 0x67, 0x0f],
  [0xcf, 0x6f, 0x0f],
  [0xcf, 0x77, 0x0f],
  [0xcf, 0x7f, 0x0f],
  [0xcf, 0x87, 0x17],
  [0xc7, 0x87, 0x17],
  [0xc7, 0x8f, 0x17],
  [0xc7, 0x97, 0x1f],
  [0xbf, 0x9f, 0x1f],
  [0xbf, 0x9f, 0x1f],
  [0xbf, 0xa7, 0x27],
  [0xbf, 0xa7, 0x27],
  [0xbf, 0xaf, 0x2f],
  [0xb7, 0xaf, 0x2f],
  [0xb7, 0xb7, 0x2f],
  [0xb7, 0xb7, 0x37],
  [0xcf, 0xcf, 0x6f],
  [0xdf, 0xdf, 0x9f],
  [0xef, 0xef, 0xc7],
  [0xff, 0xff, 0xff],
];

/** Heat levels of the original: the palette's entries. */
export const DOOM_LEVELS = DOOM_PALETTE.length;

const srgbToLinear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Radiance of the coolest and the hottest entries, as multiples of the palette's own colour. */
const GAIN_COLD = 1.25;
const GAIN_HOT = 4;

/**
 * The palette as a ramp for the HDR tail: each entry's colour in linear light, with the floor
 * (the original's 0x07 grey, which was the screen's black) taken off so heat 0 is exactly nothing,
 * and scaled up with heat, because on the PSX these were paint and here they have to be light.
 * Entry `i` sits at heat `i / 36`; in between, neighbours are mixed.
 */
export const doomRamp: RampFn = (heat) => {
  const h = Math.min(Math.max(heat, 0), 1);
  const at = h * (DOOM_LEVELS - 1);
  const low = Math.min(Math.floor(at), DOOM_LEVELS - 2);
  const mix = at - low;
  const floor = srgbToLinear(0x07);
  const gain = GAIN_COLD + (GAIN_HOT - GAIN_COLD) * h * h;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = srgbToLinear(DOOM_PALETTE[low]![c]!);
    const b = srgbToLinear(DOOM_PALETTE[low + 1]![c]!);
    out[c] = Math.max(0, a + (b - a) * mix - floor) * gain;
  }
  return out;
};
