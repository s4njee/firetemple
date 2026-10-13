import { createTextureFromData } from '../texture.ts';

/*
 * Blue noise for ray-march jitter, generated here so the site ships no texture asset.
 *
 * A march with a fixed number of steps shows its steps as bands. Starting every pixel's march at a
 * different offset inside the first step trades the bands for noise, and the kind of noise decides
 * how much of it is left after something blurs the image (the bloom, a reduced-resolution upsample,
 * the eye): white noise has energy at every spatial frequency, so a blur leaves its low-frequency
 * part behind as blotches; blue noise has almost none there, so the same blur removes nearly all of
 * it.
 *
 * `generateBlueNoise` is Ulichney's void-and-cluster method ("The void-and-cluster method for
 * dither array generation", 1993): rank every cell of a tile by repeatedly finding the tightest
 * cluster or the largest void of a point pattern, measured with a Gaussian that wraps around the
 * tile. The result tiles seamlessly and holds every value equally often.
 */

export interface BlueNoiseOptions {
  /** Side of the square tile in texels. Default 64 (4096 ranks, 16 of each byte value). */
  size?: number;
  /** Seed of the initial point pattern; a different seed gives an unrelated tile. Default 1. */
  seed?: number;
  /** Standard deviation of the energy kernel in texels. 1.5 is Ulichney's value; default 1.5. */
  sigma?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `size` x `size` blue-noise tile as bytes, row by row. Cell values are ranks scaled to 0..255,
 * so the histogram is flat. Pure and deterministic for a given seed; about 30 ms for 64 x 64.
 */
export function generateBlueNoise(options: BlueNoiseOptions = {}): Uint8Array {
  const size = Math.max(4, Math.floor(options.size ?? 64));
  const sigma = options.sigma ?? 1.5;
  const count = size * size;
  const random = mulberry32(options.seed ?? 1);

  // The Gaussian is cut where it has fallen below 1e-5 of its peak and never reaches past half
  // the tile, so a cell is not counted twice through the wrap.
  const reach = Math.min(Math.ceil(sigma * 4.8), Math.floor((size - 1) / 2));
  const span = reach * 2 + 1;
  const kernel = new Float64Array(span * span);
  for (let y = -reach; y <= reach; y++) {
    for (let x = -reach; x <= reach; x++) {
      kernel[(y + reach) * span + x + reach] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }

  const points = new Uint8Array(count);
  const energy = new Float64Array(count);

  /** Adds (sign 1) or removes (sign -1) a point and its energy. */
  const splat = (index: number, sign: 1 | -1) => {
    points[index] = sign === 1 ? 1 : 0;
    const cx = index % size;
    const cy = (index - cx) / size;
    for (let ky = 0; ky < span; ky++) {
      const row = ((cy + ky - reach + size) % size) * size;
      const kernelRow = ky * span;
      for (let kx = 0; kx < span; kx++) {
        energy[row + ((cx + kx - reach + size) % size)]! += sign * kernel[kernelRow + kx]!;
      }
    }
  };

  /** The point with the most energy around it: the middle of the tightest cluster. */
  const tightestCluster = () => {
    let best = -1;
    let bestEnergy = -Infinity;
    for (let i = 0; i < count; i++) {
      if (points[i] === 1 && energy[i]! > bestEnergy) {
        bestEnergy = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  /** The empty cell with the least energy around it: the middle of the largest void. */
  const largestVoid = () => {
    let best = -1;
    let bestEnergy = Infinity;
    for (let i = 0; i < count; i++) {
      if (points[i] === 0 && energy[i]! < bestEnergy) {
        bestEnergy = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  // 1. A random pattern with a tenth of the cells set, relaxed until moving the tightest cluster's
  //    point into the largest void would put it straight back.
  const initial = Math.max(1, Math.floor(count / 10));
  for (let placed = 0; placed < initial;) {
    const index = Math.floor(random() * count);
    if (points[index] === 0) {
      splat(index, 1);
      placed++;
    }
  }
  for (let guard = 0; guard < count * 4; guard++) {
    const cluster = tightestCluster();
    splat(cluster, -1);
    const hole = largestVoid();
    splat(hole, 1);
    if (hole === cluster) break;
  }

  const ranks = new Int32Array(count);
  const startPoints = points.slice();
  const startEnergy = energy.slice();

  // 2. Ranks below the initial count: peel points off the pattern, tightest cluster first.
  for (let rank = initial - 1; rank >= 0; rank--) {
    const cluster = tightestCluster();
    splat(cluster, -1);
    ranks[cluster] = rank;
  }

  // 3. Ranks above it: fill the largest void, again and again. (Ulichney's third phase, where the
  //    empty cells become the minority, picks the same cell: on a torus the energy of the empty
  //    cells is a constant minus the energy of the points.)
  points.set(startPoints);
  energy.set(startEnergy);
  for (let rank = initial; rank < count; rank++) {
    const hole = largestVoid();
    splat(hole, 1);
    ranks[hole] = rank;
  }

  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = Math.floor((ranks[i]! * 256) / count);
  return bytes;
}

let defaultTile: Uint8Array | undefined;

/** The default 64 x 64 tile, generated once per page. */
export function defaultBlueNoise(): Uint8Array {
  return (defaultTile ??= generateBlueNoise());
}

/** Side of the tile `createBlueNoiseTexture` makes without options. */
export const BLUE_NOISE_SIZE = 64;

/**
 * An `r8unorm` blue-noise texture for `volume_jitter_blue` (src/wgsl/volume.wgsl), which reads it
 * with `textureLoad` and wraps the coordinate itself: no sampler, no mipmaps.
 */
export function createBlueNoiseTexture(
  device: GPUDevice,
  options: BlueNoiseOptions = {},
): GPUTexture {
  const custom =
    options.size !== undefined || options.seed !== undefined || options.sigma !== undefined;
  const size = Math.max(4, Math.floor(options.size ?? BLUE_NOISE_SIZE));
  return createTextureFromData(device, {
    label: 'blue noise',
    width: size,
    height: size,
    format: 'r8unorm',
    data: custom ? generateBlueNoise(options) : defaultBlueNoise(),
  });
}
