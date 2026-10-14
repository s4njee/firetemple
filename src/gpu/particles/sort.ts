import { CameraUniform } from '../scene/camera.ts';
import { createShader } from '../shader.ts';
import { createScan, scanDispatches } from './scan.ts';
import bitonicShader from './sort-bitonic.wgsl';
import keysShader from './sort-keys.wgsl';
import radixShader from './sort-radix.wgsl';

/*
 * GPU depth sort for particles (story 7.9): particle indices ordered back to front by view depth,
 * for alpha blending. Additive particles never need this; anything that occludes (smoke, dust,
 * ash) does, or it composites in buffer order (see src/effects/particle-blending/notes.md).
 *
 *   const sort = createDepthSort(device, { capacity: 65536, camera: cameraUniformBuffer });
 *   // per frame, after the simulation has written positions:
 *   sort.encode(encoder, { positions, count, timestampWrites: profiler.pass('sort') });
 *   // draw: instance k is particle sort.indices[k]; k = 0 is the farthest.
 *
 * Inputs: `positions`, a STORAGE buffer of vec4f (16-byte stride, xyz in world space, w ignored),
 * `count` (the first `count` particles are sorted; dead ones included, the draw skips them), and a
 * camera uniform buffer laid out as `CameraUniform` (src/gpu/scene/camera.ts), e.g. a forward
 * renderer's `view.camera.buffer`. Output: `indices`, `count` u32 (STORAGE | COPY_SRC | VERTEX), read
 * by the draw through a storage binding (`order[instance_index]`).
 *
 * Methods (`settings.method`, switchable at any time):
 *   radix     LSD radix sort, 4-bit digits, stable: histogram, scan (scan.ts), scatter per digit.
 *             32-bit keys are 8 passes and exact; 16-bit keys (depth quantised between the
 *             camera's near and far) are 4 passes. O(n) work, about 8 + 3 dispatches per 4 bits.
 *   bitonic   a bitonic network padded to a power of two, with the stages that fit 512 elements
 *             done in workgroup memory. O(n log^2 n) work, in place, no scan, not stable.
 *   temporal  last frame's order is kept: each frame recomputes the keys through it and runs
 *             `temporalPasses` block sorts (sort every 512-element block, alternating between
 *             offsets 0 and 256), so an element moves up to a few hundred places a frame. Cheap
 *             and right when the order changes slowly; a particle that is born far from its
 *             place in the order takes frames to get there. A full radix sort runs whenever the
 *             count changes, on the first frame, and every `temporalRefresh` frames if set.
 *
 * Everything runs in ONE compute pass (dispatches in a pass see each other's writes), with one
 * uniform buffer of 256-byte slots read at dynamic offsets: one writeBuffer a frame and one
 * timestamp pair however many passes the sort is. Because of that single buffer, encode one sort
 * of a DepthSort per queue.submit (a second encode would overwrite the first one's slots).
 *
 * MEASURED (M1 Max, Dawn under Node, `PSORT_BENCH=1 npx vitest run tests/particle-sort.test.ts`:
 * the slope method of tests/bench.ts, i.e. the cost of one more sort with the timing floor taken
 * out; median of five runs while another agent shared the GPU; Dawn's timestamps tick every
 * 0.066 ms, so anything at or under 0.1 ms means "at the floor"):
 *
 *                   16k        64k        256k       1M
 *   radix 32-bit    0.22 ms    0.33 ms    0.81 ms    1.29 ms   (256k ranged 0.59 to 1.46)
 *   radix 16-bit    0.09       0.11       0.26       0.96
 *   bitonic         0.18       0.42       1.14       3.10
 *   temporal (2)    0.07       0.11       0.33       1.22
 *
 * In Chrome's HUD the `sort` pass of particle-blending (2 048 puffs) reads 0.25 to 0.32 ms, which
 * is the browser's per-pass floor, not the sort.
 *
 * Where it stops being worth it. Bitonic is the simplest and keeps up with radix to 64k; from 256k
 * radix wins and at 1M it is 2.4x faster (32-bit) or 3.2x (16-bit). The temporal sort is only
 * cheaper where everything is at the floor anyway: its 512-element block sorts are 45 barrier
 * steps each, so at 1M two passes cost as much as a full 16-bit radix sort, which is exact. 16-bit
 * keys are the best buy at any count. Next to the draw, the sort is noise at the counts smoke uses:
 * 2 048 big puffs cost 1.8 ms to draw at 1080p on the same GPU, 32 768 smaller ones 9 ms, against
 * a sort of 0.1 to 0.3 ms. It stops being worth it around 256k to 1M particles, not because the
 * sort gets expensive (1 ms) but because alpha-blended particles at that count are small and fill-
 * bound, i.e. sparks and embers, which are emissive and should be additive: no sort at all.
 */

export type SortMethod = 'radix' | 'bitonic' | 'temporal';
export const SORT_METHODS: readonly SortMethod[] = ['radix', 'bitonic', 'temporal'];
export type SortKeyBits = 16 | 32;

export interface DepthSortSettings {
  method: SortMethod;
  /** Radix (and the temporal sort's full sorts): 32 exact, 16 quantised between near and far. */
  keyBits: SortKeyBits;
  /** Temporal: block-sort passes per frame, alternating offsets 0 and 256. 1..16. */
  temporalPasses: number;
  /** Temporal: run a full sort every this many frames; 0 never (only when the count changes). */
  temporalRefresh: number;
}

export const DEFAULT_SORT_SETTINGS: DepthSortSettings = {
  method: 'radix',
  keyBits: 32,
  temporalPasses: 2,
  temporalRefresh: 0,
};

export interface DepthSortOptions {
  /** Most particles a sort handles. Fixed for the sorter's lifetime. */
  capacity: number;
  /** A uniform buffer holding a `CameraUniform`; read when the keys are made. */
  camera: GPUBuffer;
  settings?: Partial<DepthSortSettings>;
  label?: string;
}

export interface DepthSortEncodeOptions {
  /** STORAGE buffer of vec4f, xyz world position; at least `count` of them. */
  positions: GPUBuffer;
  count: number;
  timestampWrites?: GPUComputePassTimestampWrites;
}

export interface DepthSort {
  readonly capacity: number;
  /** Live settings, read by `encode`. */
  readonly settings: DepthSortSettings;
  /** Sorted particle indices, farthest first. Valid for the first `count` entries after `encode`. */
  readonly indices: GPUBuffer;
  /** Records the sort into its own compute pass. */
  encode(encoder: GPUCommandEncoder, options: DepthSortEncodeOptions): void;
  /** Forget the previous order: the temporal sort's next frame is a full sort. */
  reset(): void;
  destroy(): void;
}

const SLOT = 256;
const STEP_BYTES = 48;
const WORKGROUP = 256;
const TILE = 1024;
const BLOCK = 512;
const BINS = 16;
const MAX_TEMPORAL_PASSES = 16;
/** One dispatch dimension of 256-wide workgroups. */
export const MAX_SORT_CAPACITY = 65535 * WORKGROUP;

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
/** Elements the bitonic network sorts for `count`: a power of two, at least one block. */
export const bitonicSize = (count: number) => Math.max(BLOCK, nextPow2(count));

/** Bitonic steps for n elements: [k, j] pairs, j = 0 meaning a block merge, k = 0 the block sort. */
function bitonicSteps(n: number): [number, number][] {
  const steps: [number, number][] = [[0, 0]];
  for (let k = BLOCK * 2; k <= n; k *= 2) {
    for (let j = k / 2; j >= BLOCK; j /= 2) steps.push([k, j]);
    steps.push([k, 0]);
  }
  return steps;
}

/** Compute dispatches one sort of `count` records (keys pass included), for cost reporting. */
export function sortDispatches(
  method: SortMethod,
  count: number,
  keyBits: SortKeyBits = 32,
  temporalPasses = 2,
): number {
  if (count <= 1) return 0;
  const tiles = Math.ceil(count / TILE);
  const radix = 1 + (keyBits / 4) * (2 + scanDispatches(tiles * BINS));
  if (method === 'radix') return radix;
  if (method === 'bitonic') return 1 + bitonicSteps(bitonicSize(count)).length;
  return 1 + temporalPasses;
}

export function createDepthSort(device: GPUDevice, options: DepthSortOptions): DepthSort {
  const { capacity, camera, label = 'depth sort' } = options;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SORT_CAPACITY) {
    throw new RangeError(
      `sort capacity must be an integer 1..${MAX_SORT_CAPACITY}, got ${capacity}`,
    );
  }
  const settings: DepthSortSettings = { ...DEFAULT_SORT_SETTINGS, ...options.settings };

  // Sized for the bitonic padding, so every method can run on the same buffers.
  const padded = bitonicSize(capacity);
  const maxTiles = Math.ceil(capacity / TILE);
  const buffer = (name: string, extra = 0) =>
    device.createBuffer({
      label: `${label} ${name}`,
      size: padded * 4,
      usage: GPUBufferUsage.STORAGE | extra,
    });
  const keysA = buffer('keys A');
  const valuesA = buffer(
    'indices',
    GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
  );
  const keysB = buffer('keys B');
  const valuesB = buffer('values B');
  const hist = device.createBuffer({
    label: `${label} histogram`,
    size: maxTiles * BINS * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const scan = createScan(device, { maxElements: maxTiles * BINS, label: `${label} scan` });

  const maxSlots = 1 + 8 + bitonicSteps(padded).length + MAX_TEMPORAL_PASSES;
  const steps = device.createBuffer({
    label: `${label} steps`,
    size: maxSlots * SLOT,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const stepData = new Uint32Array((maxSlots * SLOT) / 4);

  const stepEntry = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: STEP_BYTES },
  });
  const storage = (binding: number, readOnly = false): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' },
  });

  const keysLayout = device.createBindGroupLayout({
    label: `${label} keys layout`,
    entries: [
      stepEntry(0),
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', minBindingSize: CameraUniform.size },
      },
      storage(2, true),
      storage(3),
      storage(4),
    ],
  });
  const radixLayout = device.createBindGroupLayout({
    label: `${label} radix layout`,
    entries: [stepEntry(0), storage(1, true), storage(2, true), storage(3), storage(4), storage(5)],
  });
  const bitonicLayout = device.createBindGroupLayout({
    label: `${label} bitonic layout`,
    entries: [stepEntry(0), storage(1), storage(2)],
  });

  const pipeline = (
    layout: GPUBindGroupLayout,
    module: GPUShaderModule,
    entryPoint: string,
  ): GPUComputePipeline =>
    device.createComputePipeline({
      label: `${label} ${entryPoint}`,
      layout: device.createPipelineLayout({ label: entryPoint, bindGroupLayouts: [layout] }),
      compute: { module, entryPoint },
    });
  const keysModule = createShader(device, { ...keysShader, label: 'particles/sort-keys.wgsl' });
  const radixModule = createShader(device, { ...radixShader, label: 'particles/sort-radix.wgsl' });
  const bitonicModule = createShader(device, {
    ...bitonicShader,
    label: 'particles/sort-bitonic.wgsl',
  });
  const keysPipeline = pipeline(keysLayout, keysModule, 'psort_keys');
  const histogramPipeline = pipeline(radixLayout, radixModule, 'psort_histogram');
  const scatterPipeline = pipeline(radixLayout, radixModule, 'psort_scatter');
  const blockSortPipeline = pipeline(bitonicLayout, bitonicModule, 'psort_block_sort');
  const globalPipeline = pipeline(bitonicLayout, bitonicModule, 'psort_bitonic_global');
  const blockMergePipeline = pipeline(bitonicLayout, bitonicModule, 'psort_block_merge');

  const stepBinding = { buffer: steps, size: STEP_BYTES };
  const radixGroup = (
    keysIn: GPUBuffer,
    valuesIn: GPUBuffer,
    keysOut: GPUBuffer,
    valuesOut: GPUBuffer,
  ) =>
    device.createBindGroup({
      label: `${label} radix`,
      layout: radixLayout,
      entries: [
        { binding: 0, resource: stepBinding },
        { binding: 1, resource: { buffer: keysIn } },
        { binding: 2, resource: { buffer: valuesIn } },
        { binding: 3, resource: { buffer: hist } },
        { binding: 4, resource: { buffer: keysOut } },
        { binding: 5, resource: { buffer: valuesOut } },
      ],
    });
  const radixAB = radixGroup(keysA, valuesA, keysB, valuesB);
  const radixBA = radixGroup(keysB, valuesB, keysA, valuesA);
  const bitonicGroup = device.createBindGroup({
    label: `${label} bitonic`,
    layout: bitonicLayout,
    entries: [
      { binding: 0, resource: stepBinding },
      { binding: 1, resource: { buffer: keysA } },
      { binding: 2, resource: { buffer: valuesA } },
    ],
  });
  let keysGroupFor: GPUBuffer | undefined;
  let keysGroup: GPUBindGroup | undefined;
  const keysGroupOf = (positions: GPUBuffer) => {
    if (keysGroup && keysGroupFor === positions) return keysGroup;
    keysGroupFor = positions;
    keysGroup = device.createBindGroup({
      label: `${label} keys`,
      layout: keysLayout,
      entries: [
        { binding: 0, resource: stepBinding },
        { binding: 1, resource: { buffer: camera } },
        { binding: 2, resource: { buffer: positions } },
        { binding: 3, resource: { buffer: keysA } },
        { binding: 4, resource: { buffer: valuesA } },
      ],
    });
    return keysGroup;
  };

  // Temporal state: the count the order in `valuesA` belongs to, and frames since a full sort.
  let orderedCount = -1;
  let framesSinceFull = 0;

  interface Step {
    count?: number;
    n?: number;
    shift?: number;
    tiles?: number;
    k?: number;
    j?: number;
    offset?: number;
    dirBit?: number;
    keyBits?: number;
    reuseOrder?: number;
  }
  let used = 0;
  const addStep = (step: Step): number => {
    const slot = used++;
    const o = (slot * SLOT) / 4;
    stepData[o] = step.count ?? 0;
    stepData[o + 1] = step.n ?? 0;
    stepData[o + 2] = step.shift ?? 0;
    stepData[o + 3] = step.tiles ?? 0;
    stepData[o + 4] = step.k ?? 0;
    stepData[o + 5] = step.j ?? 0;
    stepData[o + 6] = step.offset ?? 0;
    stepData[o + 7] = step.dirBit ?? 0;
    stepData[o + 8] = 0;
    stepData[o + 9] = 0;
    stepData[o + 10] = step.keyBits ?? 32;
    stepData[o + 11] = step.reuseOrder ?? 0;
    return slot * SLOT;
  };

  const encodeKeys = (
    pass: GPUComputePassEncoder,
    positions: GPUBuffer,
    count: number,
    n: number,
    keyBits: number,
    reuseOrder: boolean,
  ) => {
    const offset = addStep({ count, n, keyBits, reuseOrder: reuseOrder ? 1 : 0 });
    pass.setPipeline(keysPipeline);
    pass.setBindGroup(0, keysGroupOf(positions), [offset]);
    pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
  };

  const encodeRadix = (pass: GPUComputePassEncoder, count: number, keyBits: number) => {
    const tiles = Math.ceil(count / TILE);
    scan.prepare(tiles * BINS);
    const digits = keyBits / 4;
    for (let digit = 0; digit < digits; digit++) {
      const offset = addStep({ count, n: count, tiles, shift: digit * 4 });
      // Even digits read A and write B; with an even digit count the result ends in A.
      const group = digit % 2 === 0 ? radixAB : radixBA;
      pass.setPipeline(histogramPipeline);
      pass.setBindGroup(0, group, [offset]);
      pass.dispatchWorkgroups(tiles);
      scan.encode(pass, hist, tiles * BINS);
      pass.setPipeline(scatterPipeline);
      pass.setBindGroup(0, group, [offset]);
      pass.dispatchWorkgroups(tiles);
    }
  };

  const encodeBitonic = (pass: GPUComputePassEncoder, n: number) => {
    for (const [k, j] of bitonicSteps(n)) {
      if (k === 0) {
        const offset = addStep({ n, dirBit: BLOCK });
        pass.setPipeline(blockSortPipeline);
        pass.setBindGroup(0, bitonicGroup, [offset]);
        pass.dispatchWorkgroups(n / BLOCK);
      } else if (j === 0) {
        const offset = addStep({ n, k });
        pass.setPipeline(blockMergePipeline);
        pass.setBindGroup(0, bitonicGroup, [offset]);
        pass.dispatchWorkgroups(n / BLOCK);
      } else {
        const offset = addStep({ n, k, j });
        pass.setPipeline(globalPipeline);
        pass.setBindGroup(0, bitonicGroup, [offset]);
        pass.dispatchWorkgroups(n / 2 / WORKGROUP);
      }
    }
  };

  const encodeBlocks = (pass: GPUComputePassEncoder, count: number, passes: number) => {
    for (let index = 0; index < passes; index++) {
      const start = index % 2 === 0 ? 0 : BLOCK / 2;
      if (count <= start) continue;
      const offset = addStep({ n: count, offset: start, dirBit: 0 });
      pass.setPipeline(blockSortPipeline);
      pass.setBindGroup(0, bitonicGroup, [offset]);
      pass.dispatchWorkgroups(Math.ceil((count - start) / BLOCK));
    }
  };

  return {
    capacity,
    settings,
    indices: valuesA,

    encode(encoder, encodeOptions) {
      const { positions, count } = encodeOptions;
      if (!Number.isInteger(count) || count < 0 || count > capacity) {
        throw new RangeError(`${label}: count must be an integer 0..${capacity}, got ${count}`);
      }
      if (positions.size < count * 16) {
        throw new RangeError(`${label}: positions hold fewer than ${count} vec4f`);
      }
      used = 0;
      const pass = encoder.beginComputePass({
        label,
        timestampWrites: encodeOptions.timestampWrites,
      });
      const keyBits = settings.keyBits === 16 ? 16 : 32;
      const method = settings.method;
      if (count > 0) {
        if (method === 'bitonic') {
          const n = bitonicSize(count);
          encodeKeys(pass, positions, count, n, keyBits, false);
          encodeBitonic(pass, n);
          orderedCount = count;
        } else {
          const refresh = Math.max(0, Math.floor(settings.temporalRefresh));
          const reuse =
            method === 'temporal' &&
            orderedCount === count &&
            !(refresh > 0 && framesSinceFull + 1 >= refresh);
          if (reuse) {
            encodeKeys(pass, positions, count, count, keyBits, true);
            const passes = Math.min(
              MAX_TEMPORAL_PASSES,
              Math.max(1, Math.round(settings.temporalPasses)),
            );
            encodeBlocks(pass, count, passes);
            framesSinceFull++;
          } else {
            encodeKeys(pass, positions, count, count, keyBits, false);
            if (count > 1) encodeRadix(pass, count, keyBits);
            framesSinceFull = 0;
          }
          orderedCount = count;
        }
      }
      pass.end();
      if (used > 0) device.queue.writeBuffer(steps, 0, stepData, 0, (used * SLOT) / 4);
    },

    reset() {
      orderedCount = -1;
    },

    destroy() {
      for (const b of [keysA, valuesA, keysB, valuesB, hist, steps]) b.destroy();
      scan.destroy();
    },
  };
}
