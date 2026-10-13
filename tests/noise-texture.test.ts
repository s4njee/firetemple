import { describe, expect, it } from 'vitest';
import { fromHalf } from '../src/gpu/emission/half-float.ts';
import {
  getNoiseTexture,
  NOISE_TEXTURE_CELLS,
  NOISE_TEXTURE_SIZE,
} from '../src/gpu/emission/noise-texture.ts';
import noisetex from '../src/wgsl/noisetex.wgsl';
import { expectValid, getTestDevice, readTexture } from './gpu.ts';

// The shared baked noise texture: what Tier A effects read instead of computing noise per pixel.

async function readChannels() {
  const device = await getTestDevice();
  const noise = await expectValid(device, () => getNoiseTexture(device));
  const bytes = await readTexture(device, noise.texture, 8);
  const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const size = noise.size;
  const channels = [0, 1, 2, 3].map(() => new Float32Array(size * size));
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 4; c++) channels[c]![i] = fromHalf(halves[i * 4 + c]!);
  }
  return { device, noise, size, channels };
}

const mean = (values: Float32Array) => values.reduce((sum, v) => sum + v, 0) / values.length;
const deviation = (values: Float32Array) => {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
};
const correlation = (a: Float32Array, b: Float32Array) => {
  const ma = mean(a);
  const mb = mean(b);
  let covariance = 0;
  for (let i = 0; i < a.length; i++) covariance += (a[i]! - ma) * (b[i]! - mb);
  return covariance / a.length / (deviation(a) * deviation(b));
};

describe('shared noise texture', () => {
  it('is baked once per device, mipmapped and readable', async () => {
    const { device, noise } = await readChannels();
    expect(getNoiseTexture(device)).toBe(noise);
    expect(noise.size).toBe(NOISE_TEXTURE_SIZE);
    expect(noise.texture.mipLevelCount).toBe(Math.log2(NOISE_TEXTURE_SIZE) + 1);
    expect(noise.texture.format).toBe('rgba16float');
  });

  it('fills every channel with noise in 0..1 around one half', async () => {
    const { channels } = await readChannels();
    for (const channel of channels) {
      expect(Math.min(...channel)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...channel)).toBeLessThanOrEqual(1);
      expect(mean(channel)).toBeGreaterThan(0.42);
      expect(mean(channel)).toBeLessThan(0.58);
      expect(deviation(channel)).toBeGreaterThan(0.08);
      // Not clipped: the fractal channels must not pile up at the ends of the range.
      const clipped = channel.filter((v) => v <= 0.001 || v >= 0.999).length / channel.length;
      expect(clipped).toBeLessThan(0.01);
    }
  });

  it('keeps the two coarse fields independent, so one fetch can drive a 2D warp', async () => {
    const { channels } = await readChannels();
    expect(Math.abs(correlation(channels[0]!, channels[1]!))).toBeLessThan(0.25);
    expect(Math.abs(correlation(channels[0]!, channels[2]!))).toBeLessThan(0.25);
  });

  it('is seamless: the step across the edge is no larger than a step inside the tile', async () => {
    const { channels, size } = await readChannels();
    for (const channel of channels.slice(0, 3)) {
      let inside = 0;
      let seamX = 0;
      let seamY = 0;
      for (let i = 0; i < size; i++) {
        inside = Math.max(inside, Math.abs(channel[i * size + 101]! - channel[i * size + 100]!));
        seamX = Math.max(seamX, Math.abs(channel[i * size]! - channel[i * size + size - 1]!));
        seamY = Math.max(seamY, Math.abs(channel[i]! - channel[(size - 1) * size + i]!));
      }
      expect(seamX).toBeLessThan(inside * 2.5 + 0.01);
      expect(seamY).toBeLessThan(inside * 2.5 + 0.01);
    }
  });

  it('agrees with the reader chunk on how many cells a tile holds', () => {
    expect(noisetex.code).toContain(`const NOISETEX_CELLS: f32 = ${NOISE_TEXTURE_CELLS}.0;`);
  });
});
