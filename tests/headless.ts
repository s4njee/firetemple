import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEffect } from '../src/effects/registry.ts';
import {
  defaultParams,
  type EffectInstance,
  type EffectModule,
  type FrameTime,
} from '../src/effects/types.ts';
import { noProfiler, type PassProfiler } from '../src/gpu/profiler.ts';
import { getTestDevice, readTexture } from './gpu.ts';

// Running a registered effect without a browser: the shared machinery behind the lifecycle test,
// the screenshot tool (experiments/shot.test.ts) and the benchmark harness (tests/bench.ts).

/** There is no DOM here. Effects only use the canvas for input, so listeners are all it needs. */
export function fakeCanvas(width: number, height: number): HTMLCanvasElement {
  return Object.assign(new EventTarget(), {
    width,
    height,
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    setPointerCapture() {},
    releasePointerCapture() {},
  }) as unknown as HTMLCanvasElement;
}

export interface HeadlessOptions {
  width: number;
  height: number;
  /** Name of one of the effect's presets, applied over its defaults. */
  preset?: string;
  /** Applied last, over defaults and preset. */
  params?: Readonly<Record<string, unknown>>;
  /** Format of the stand-in canvas texture. Default rgba8unorm. */
  format?: GPUTextureFormat;
  profiler?: PassProfiler;
  /** Default: the shared test device. The benchmark passes one with `timestamp-query`. */
  device?: GPUDevice;
  /** Simulated frame rate. Default 60. */
  fps?: number;
}

export interface HeadlessEffect {
  device: GPUDevice;
  effect: EffectModule;
  instance: EffectInstance;
  /** The live parameter object the effect reads; mutate it to change the picture. */
  params: Record<string, unknown>;
  canvas: HTMLCanvasElement;
  /** Stands in for the canvas texture. */
  target: GPUTexture;
  readonly time: FrameTime;
  /** Encodes one frame into `encoder` without submitting, and advances time by 1/fps. */
  encode(encoder: GPUCommandEncoder): void;
  /** Encodes and submits `frames` frames (default 1), advancing time by 1/fps each. */
  step(frames?: number): void;
  /** Steps until `seconds` of simulated time have passed, then waits for the GPU. */
  runTo(seconds: number): Promise<void>;
  /** The target as tightly packed RGBA bytes, straight from the texture (premultiplied). */
  read(): Promise<Uint8Array>;
  destroy(): void;
}

export async function mountHeadless(id: string, options: HeadlessOptions): Promise<HeadlessEffect> {
  const { width, height } = options;
  const device = options.device ?? (await getTestDevice());
  const effect = await loadEffect(id);
  if (options.preset !== undefined && !effect.presets?.[options.preset]) {
    throw new Error(
      `Effect "${id}" has no preset "${options.preset}" (${Object.keys(effect.presets ?? {}).join(', ')})`,
    );
  }
  const params: Record<string, unknown> = {
    ...defaultParams(effect.params),
    ...(options.preset ? effect.presets?.[options.preset] : undefined),
    ...options.params,
  };
  const format = options.format ?? 'rgba8unorm';
  const target = device.createTexture({
    label: `headless ${id}`,
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = target.createView();
  const canvas = fakeCanvas(width, height);
  const instance = await effect.create({
    device,
    format,
    canvas,
    params: params as never,
    profiler: options.profiler ?? noProfiler,
    hdr: false,
  });
  instance.resize(width, height, 1);

  const delta = 1 / (options.fps ?? 60);
  const time = { time: 0, delta, frame: 0 };

  const encode = (encoder: GPUCommandEncoder) => {
    instance.frame({ ...time }, encoder, view);
    time.time += delta;
    time.frame++;
  };
  const step = (frames = 1) => {
    for (let i = 0; i < frames; i++) {
      const encoder = device.createCommandEncoder();
      encode(encoder);
      device.queue.submit([encoder.finish()]);
    }
  };

  return {
    device,
    effect,
    instance,
    params,
    canvas,
    target,
    time,
    encode,
    step,
    async runTo(seconds) {
      while (time.time < seconds) {
        step();
        // Keep the command queue short so a long run cannot pile up thousands of frames.
        if (time.frame % 30 === 0) await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
    },
    read: () => readTexture(device, target),
    destroy() {
      instance.destroy();
      target.destroy();
    },
  };
}

/** Sends a pointer event to a headless canvas. `x`, `y` are 0..1 across it. */
export function sendPointer(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointerleave',
  x: number,
  y: number,
  timeMs = 0,
  pointerId = 1,
): void {
  const event = new Event(type);
  const props: Record<string, unknown> = {
    pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointerleave' ? 0 : 1,
    clientX: x * canvas.width,
    clientY: y * canvas.height,
    timeStamp: timeMs,
    pressure: type === 'pointerdown' ? 0.5 : 0,
    getCoalescedEvents: () => [],
  };
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  canvas.dispatchEvent(event);
}

/** A page colour (sRGB bytes) to composite a premultiplied canvas over, as the browser would. */
export type Backdrop = readonly [number, number, number];
export const BACKDROPS: Readonly<Record<string, Backdrop>> = {
  black: [0, 0, 0],
  dark: [14, 12, 11],
  light: [250, 248, 245],
  white: [255, 255, 255],
};

/** Premultiplied RGBA over an opaque page colour: `rgb + (1 - a) * page`, clamped. Returns RGB. */
export function compositeOver(rgba: Uint8Array, page: Backdrop): Uint8Array {
  const count = rgba.length / 4;
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const keep = 1 - rgba[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.min(255, Math.round(rgba[i * 4 + c]! + keep * page[c]!));
    }
  }
  return rgb;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Writes tightly packed 8-bit RGB as a PNG, creating the directory if needed. */
export function writePng(path: string, width: number, height: number, rgb: Uint8Array): void {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1);
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const all = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, all);
}
