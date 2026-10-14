import { createShader } from '../shader.ts';
import scanShader from './scan.wgsl';

/*
 * A parallel exclusive prefix sum over u32 in a storage buffer, in place, exact for any length up
 * to MAX_SCAN_ELEMENTS. Ported from Water Temple (src/gpu/particles/scan.ts), which explains the
 * algorithm: a "reduce, scan the sums, add back" scan (Harris, Sengupta and Owens, GPU Gems 3
 * ch. 39, in the tiled form of Merrill and Grimshaw):
 *
 *   level 0   scan_blocks over the data: each 1024-element tile is scanned in workgroup memory and
 *             its total goes to the level above
 *   level 1+  the tile totals are scanned the same way, until a level fits in one tile
 *   back up   add_offsets adds each tile's scanned total to its elements, top level down
 *
 * 1 024 elements take 1 dispatch, 1 048 576 take 5 (3 levels). Single-pass decoupled look-back
 * would be faster, but it relies on forward progress between workgroups, which WebGPU does not
 * promise.
 *
 * Differences from the port's source: the element count of each level is read from a uniform slot
 * at a dynamic offset (not from `arrayLength` of a binding sized to the count), so the bind groups
 * are made once per data buffer whatever the count; and `encode` records into a compute pass the
 * caller already has open, so a radix sort runs its eight scans inside its own single pass.
 *
 *   const scan = createScan(device, { maxElements: 1 << 20 });
 *   scan.prepare(count);                 // once per submit: writes each level's count
 *   scan.encode(pass, buffer, count);    // inside an open compute pass, as often as needed
 *   // or, standalone:
 *   scan.run(encoder, buffer, count);
 *
 * All encodes before one `queue.submit` share the level counts of the last `prepare`, so they must
 * all scan the same count.
 */

/** Elements one workgroup scans: 256 invocations x 4. */
export const SCAN_TILE = 1024;
/** Longest array: the number of tiles must fit one dispatch (65535). */
export const MAX_SCAN_ELEMENTS = SCAN_TILE * 65535;
/** Dynamic offsets must be multiples of this (the WebGPU default limit). */
const SLOT = 256;

/** Element counts of each level for `count` elements: [count, tiles, tiles of tiles, ...]. */
export function scanLevelSizes(count: number): number[] {
  const sizes = [Math.max(1, count)];
  while (sizes[sizes.length - 1]! > SCAN_TILE) {
    sizes.push(Math.ceil(sizes[sizes.length - 1]! / SCAN_TILE));
  }
  return sizes;
}

/** Compute dispatches one scan of `count` elements records. */
export function scanDispatches(count: number): number {
  return scanLevelSizes(count).length * 2 - 1;
}

export interface ScanOptions {
  /** Longest array it will be asked to scan; sizes the scratch buffers. */
  maxElements: number;
  label?: string;
}

export interface Scan {
  readonly maxElements: number;
  /** Writes the per-level counts for `count`. Call before encoding, once per submit. */
  prepare(count: number): void;
  /**
   * Records the scan of the first `count` u32 of `data` into an open compute pass. `data` needs
   * STORAGE usage. `prepare(count)` must have been called for this submit.
   */
  encode(pass: GPUComputePassEncoder, data: GPUBuffer, count: number): void;
  /** `prepare` plus one compute pass of its own. */
  run(
    encoder: GPUCommandEncoder,
    data: GPUBuffer,
    count: number,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void;
  destroy(): void;
}

export function createScan(device: GPUDevice, options: ScanOptions): Scan {
  const { maxElements, label = 'scan' } = options;
  if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > MAX_SCAN_ELEMENTS) {
    throw new RangeError(`scan length must be 1..${MAX_SCAN_ELEMENTS}, got ${maxElements}`);
  }
  const maxSizes = scanLevelSizes(maxElements);
  const levels = maxSizes.length;

  const module = createShader(device, { ...scanShader, label: 'particles/scan.wgsl' });
  const layout = device.createBindGroupLayout({
    label: `${label} layout`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
      },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ label, bindGroupLayouts: [layout] });
  const scanBlocks = device.createComputePipeline({
    label: `${label} scan_blocks`,
    layout: pipelineLayout,
    compute: { module, entryPoint: 'scan_blocks' },
  });
  const addOffsets = device.createComputePipeline({
    label: `${label} add_offsets`,
    layout: pipelineLayout,
    compute: { module, entryPoint: 'add_offsets' },
  });

  // Level k's tile sums are level k + 1's data. The top level writes its total to `sink`.
  const scratch = maxSizes.slice(1).map((size, index) =>
    device.createBuffer({
      label: `${label} tile sums ${index + 1}`,
      size: Math.max(16, size * 4),
      usage: GPUBufferUsage.STORAGE,
    }),
  );
  const sink = device.createBuffer({
    label: `${label} sink`,
    size: 16,
    usage: GPUBufferUsage.STORAGE,
  });
  const uniforms = device.createBuffer({
    label: `${label} levels`,
    size: levels * SLOT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const slotData = new Uint32Array((levels * SLOT) / 4);

  // Groups above level 0 never change; level 0 depends on the caller's buffer.
  const group = (level: number, data: GPUBuffer): GPUBindGroup =>
    device.createBindGroup({
      label: `${label} level ${level}`,
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: 16 } },
        { binding: 1, resource: { buffer: data } },
        { binding: 2, resource: { buffer: level + 1 < levels ? scratch[level]! : sink } },
      ],
    });
  // The top level of a short array is a lower level of the longest one, so a group per (level,
  // whether it is the top) would be needed if the sums target changed. It does not: a level's sums
  // always go to the next scratch buffer, and the top level's extra write lands in a buffer nobody
  // reads at that size.
  const upper = Array.from({ length: levels }, (_, level) =>
    level === 0 ? undefined : group(level, scratch[level - 1]!),
  );
  const lower = new WeakMap<GPUBuffer, GPUBindGroup>();

  let prepared = -1;

  const check = (data: GPUBuffer, count: number) => {
    if (!Number.isInteger(count) || count < 0 || count > maxElements) {
      throw new RangeError(`${label}: count must be an integer 0..${maxElements}, got ${count}`);
    }
    if (data.size < count * 4)
      throw new RangeError(`${label}: buffer holds fewer than ${count} u32`);
  };

  const scan: Scan = {
    maxElements,

    prepare(count) {
      const sizes = scanLevelSizes(count);
      slotData.fill(0);
      sizes.forEach((size, level) => (slotData[(level * SLOT) / 4] = size));
      device.queue.writeBuffer(uniforms, 0, slotData);
      prepared = count;
    },

    encode(pass, data, count) {
      check(data, count);
      if (count === 0) return;
      if (prepared !== count) {
        throw new Error(`${label}: call prepare(${count}) before encoding a scan of ${count}`);
      }
      let base = lower.get(data);
      if (!base) {
        base = group(0, data);
        lower.set(data, base);
      }
      const sizes = scanLevelSizes(count);
      const groupOf = (level: number) => (level === 0 ? base : upper[level]!);
      for (let level = 0; level < sizes.length; level++) {
        pass.setPipeline(scanBlocks);
        pass.setBindGroup(0, groupOf(level), [level * SLOT]);
        pass.dispatchWorkgroups(Math.ceil(sizes[level]! / SCAN_TILE));
      }
      for (let level = sizes.length - 2; level >= 0; level--) {
        pass.setPipeline(addOffsets);
        pass.setBindGroup(0, groupOf(level), [level * SLOT]);
        pass.dispatchWorkgroups(Math.ceil(sizes[level]! / SCAN_TILE));
      }
    },

    run(encoder, data, count, timestampWrites) {
      check(data, count);
      scan.prepare(count);
      const pass = encoder.beginComputePass({ label, timestampWrites });
      scan.encode(pass, data, count);
      pass.end();
    },

    destroy() {
      for (const buffer of scratch) buffer.destroy();
      sink.destroy();
      uniforms.destroy();
    },
  };
  return scan;
}
