import { createAudioAnalyser, type AudioAnalyser } from '../audio.ts';
import { trackScroll, type ScrollTracker } from '../scroll.ts';

/*
 * Excitation: a 0..1 level that something outside the canvas drives (story 5.8).
 *
 *   const drive = createExcitation('scroll', canvas);      // or 'audio', or 'none'
 *   // each frame:
 *   const level = drive.update(time.delta);                 // 0 when nothing is happening
 *
 * A simulation multiplies the level into whatever feeds it: fuel at the base of a fire, the
 * rate of stray embers, the strength of a burner. The level rises quickly and falls slowly, so a
 * flick of the scroll wheel is a flare that dies down rather than a flash.
 *
 * It is a level, not a clock: nothing here changes how fast a simulation runs, so excitation
 * cannot push an effect's flicker past the flash limit by itself. What it feeds can; keep the
 * extra heat a share of the calm level, not a multiple.
 */

export const EXCITATIONS = ['none', 'scroll', 'audio'] as const;
export type ExcitationKind = (typeof EXCITATIONS)[number];

export interface Excitation {
  readonly kind: ExcitationKind;
  /** The level after the latest `update`, 0..1. */
  readonly level: number;
  /** Advances by `dt` seconds and returns the new level. Call once per frame. */
  update(dt: number): number;
  destroy(): void;
}

export interface ExcitationOptions {
  /** Scroll speed, in CSS pixels per second, that counts as full level. Default 2400. */
  fullScrollSpeed?: number;
  /** Seconds for the level to rise most of the way to a higher input. Default 0.08. */
  attack?: number;
  /** Seconds for it to fall back. Default 0.7. */
  release?: number;
}

/** One smoothing step: fast up, slow down. Exact for any `dt`, so it is frame-rate independent. */
export function follow(
  level: number,
  input: number,
  dt: number,
  attack: number,
  release: number,
): number {
  const target = Math.min(1, Math.max(0, Number.isFinite(input) ? input : 0));
  const tau = target > level ? attack : release;
  if (!(dt > 0)) return level;
  if (!(tau > 0)) return target;
  return target + (level - target) * Math.exp(-dt / tau);
}

function follower(
  kind: ExcitationKind,
  read: (dt: number) => number,
  options: ExcitationOptions,
  destroy: () => void,
): Excitation {
  const attack = options.attack ?? 0.08;
  const release = options.release ?? 0.7;
  let level = 0;
  return {
    kind,
    get level() {
      return level;
    },
    update(dt) {
      level = follow(level, read(dt), dt, attack, release);
      return level;
    },
    destroy,
  };
}

/** Level from how fast the page is scrolling past the canvas, in either direction. */
export function createScrollExcitation(
  canvas: HTMLCanvasElement,
  options: ExcitationOptions = {},
): Excitation {
  const full = options.fullScrollSpeed ?? 2400;
  const scroll: ScrollTracker = trackScroll(canvas);
  return follower(
    'scroll',
    (dt) => Math.abs(scroll.update(dt).velocity) / full,
    options,
    () => scroll.destroy(),
  );
}

/**
 * Level from sound: the bass of the built-in synthesised pattern (or of a file the visitor
 * drops, through `analyser.useFile`). Browsers keep audio suspended until a user gesture, so the
 * level stays 0 until the canvas is pressed once; the microphone is never requested and nothing
 * is audible unless the effect calls `analyser.setAudible(true)`.
 */
export function createAudioExcitation(
  canvas: HTMLCanvasElement,
  options: ExcitationOptions = {},
): Excitation & { readonly analyser: AudioAnalyser } {
  const analyser = createAudioAnalyser();
  const resume = () => void analyser.resume();
  const listening = typeof canvas.addEventListener === 'function';
  if (listening) canvas.addEventListener('pointerdown', resume);
  const base = follower(
    'audio',
    (dt) => {
      const frame = analyser.update(dt);
      // The low end carries the beat; an onset adds a kick on top of the sustained level.
      return frame.bass * 0.8 + frame.onsetStrength * 0.4;
    },
    { attack: 0.03, release: 0.35, ...options },
    () => {
      if (listening) canvas.removeEventListener('pointerdown', resume);
      analyser.destroy();
    },
  );
  return Object.assign(base, { analyser });
}

/** The excitation an effect's `drive` parameter names. `'none'` is a level that stays at 0. */
export function createExcitation(
  kind: ExcitationKind | string,
  canvas: HTMLCanvasElement,
  options: ExcitationOptions = {},
): Excitation {
  if (kind === 'scroll') return createScrollExcitation(canvas, options);
  if (kind === 'audio') return createAudioExcitation(canvas, options);
  return { kind: 'none', level: 0, update: () => 0, destroy() {} };
}
