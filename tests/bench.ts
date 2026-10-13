import type { PassProfiler } from '../src/gpu/profiler.ts';

// The benchmark harness (story 1.8). Method, from what Water Temple learned the hard way:
//
// - A frame's GPU time is the span from its first timed pass starting to its last one ending.
//   Never the sum of the passes: on tile-based GPUs their intervals overlap.
// - That span has a floor. On Apple Silicon a pass that draws almost nothing reads about a
//   millisecond, so a light effect cannot be ranked by its span. Each sample therefore encodes
//   the frame once and `REPEATS` times in one command buffer; the slope between the two is what
//   one more frame of the same work costs, with the floor cancelled out.
// - Nothing else should be using the GPU while this runs. Results are medians over `ROUNDS`.
//
// Under Node this measures Dawn on the local adapter. It says nothing about other devices.

export const WARMUP_FRAMES = 12;
export const ROUNDS = 11;
export const REPEATS = 4;
const QUERY_CAPACITY = 4096;

export interface BenchDevice {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** False when the adapter has no `timestamp-query`; timings are then CPU wall time. */
  timed: boolean;
  /** Hand to the effect; it counts and times every pass that asks. */
  profiler: PassProfiler;
  measure(unit: (encoder: GPUCommandEncoder) => void): Promise<Measurement>;
  destroy(): void;
}

export interface Measurement {
  /** Median GPU time of one frame alone: first pass start to last pass end. Includes the floor. */
  spanMs: number;
  /** Median cost of one more frame of the same work; the number to compare effects by. */
  slopeMs: number;
  slopeMinMs: number;
  slopeMaxMs: number;
  /** Timed passes in one frame. 0 means the effect gave no pass `timestampWrites`. */
  passes: number;
  metric: 'gpu-timestamp' | 'cpu-wall';
}

const median = (samples: readonly number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

export async function createBenchDevice(): Promise<BenchDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available to the benchmark');
  const timed = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: timed ? ['timestamp-query'] : [],
  });

  const querySet = timed
    ? device.createQuerySet({ type: 'timestamp', count: QUERY_CAPACITY })
    : undefined;
  const resolveBuffer = device.createBuffer({
    size: QUERY_CAPACITY * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    size: QUERY_CAPACITY * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  let passes = 0;
  const profiler: PassProfiler = {
    pass() {
      const index = passes++;
      if (index * 2 + 1 >= QUERY_CAPACITY) {
        throw new Error('Benchmark ran out of timestamp queries; lower REPEATS for this effect');
      }
      return querySet
        ? {
            querySet,
            beginningOfPassWriteIndex: index * 2,
            endOfPassWriteIndex: index * 2 + 1,
          }
        : undefined;
    },
  };

  /** Encodes `unit` `repeats` times in one command buffer and returns its GPU span in ms. */
  async function run(unit: (encoder: GPUCommandEncoder) => void, repeats: number) {
    passes = 0;
    const encoder = device.createCommandEncoder();
    const started = performance.now();
    for (let i = 0; i < repeats; i++) unit(encoder);
    const stamps = passes * 2;
    if (querySet && stamps > 0) {
      encoder.resolveQuerySet(querySet, 0, stamps, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, stamps * 8);
    }
    device.queue.submit([encoder.finish()]);
    if (querySet && stamps > 0) {
      await readBuffer.mapAsync(GPUMapMode.READ, 0, stamps * 8);
      const values = new BigUint64Array(readBuffer.getMappedRange(0, stamps * 8));
      // Passes may finish out of order on a tiler, so take the true extremes. A zero is a
      // timestamp the driver never wrote (a pass it skipped), not a time.
      let first: bigint | undefined;
      let last = 0n;
      for (const value of values) {
        if (value === 0n) continue;
        if (first === undefined || value < first) first = value;
        if (value > last) last = value;
      }
      readBuffer.unmap();
      const ms = first === undefined ? Number.NaN : Number(last - first) / 1e6;
      return { ms, timedPasses: passes };
    }
    await device.queue.onSubmittedWorkDone();
    return { ms: performance.now() - started, timedPasses: 0 };
  }

  return {
    device,
    adapter,
    timed,
    profiler,
    async measure(unit) {
      for (let i = 0; i < WARMUP_FRAMES; i++) await run(unit, 1);
      const spans: number[] = [];
      const slopes: number[] = [];
      let timedPasses = 0;
      // A sample longer than this is a stall or a counter reset, not a measurement; take another.
      const plausible = (ms: number) => Number.isFinite(ms) && ms < 5_000;
      for (let attempt = 0; spans.length < ROUNDS && attempt < ROUNDS * 3; attempt++) {
        const one = await run(unit, 1);
        const many = await run(unit, REPEATS);
        timedPasses = one.timedPasses;
        if (!plausible(one.ms) || !plausible(many.ms)) continue;
        spans.push(one.ms);
        slopes.push((many.ms - one.ms) / (REPEATS - 1));
      }
      if (spans.length === 0) throw new Error('Benchmark got no usable timing samples');
      return {
        spanMs: median(spans),
        slopeMs: median(slopes),
        slopeMinMs: Math.min(...slopes),
        slopeMaxMs: Math.max(...slopes),
        passes: timedPasses,
        metric: timed && timedPasses > 0 ? 'gpu-timestamp' : 'cpu-wall',
      };
    },
    destroy() {
      querySet?.destroy();
      resolveBuffer.destroy();
      readBuffer.destroy();
      device.destroy();
    },
  };
}
