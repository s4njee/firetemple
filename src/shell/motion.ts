// Site-wide motion preferences (story 2.9). Fire flickers, so the visitor gets two controls that
// every demo and thumbnail obeys:
//
// - Motion on or off. With no explicit choice it follows the system's `prefers-reduced-motion`;
//   an explicit choice (either way) wins and is remembered. A paused effect still draws one frame.
// - An intensity cap: a brightness limit applied to every effect canvas, so the size of any
//   flicker shrinks with it.

export type MotionChoice = 'auto' | 'play' | 'pause';

/** The cap steps the header control cycles through. 1 is uncapped. */
export const INTENSITY_STEPS = [1, 0.7, 0.4] as const;

const MOTION_KEY = 'ft-motion';
const INTENSITY_KEY = 'ft-intensity';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be blocked; the choice then lasts for this page view only.
  }
}

function storedChoice(): MotionChoice {
  const value = read(MOTION_KEY);
  return value === 'play' || value === 'pause' ? value : 'auto';
}

function storedIntensity(): number {
  const value = Number(read(INTENSITY_KEY));
  return (INTENSITY_STEPS as readonly number[]).includes(value) ? value : 1;
}

let choice = storedChoice();
let intensity = storedIntensity();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

export function getMotionChoice(): MotionChoice {
  return choice;
}

export function setMotionChoice(next: MotionChoice): void {
  if (next === choice) return;
  choice = next;
  write(MOTION_KEY, next === 'auto' ? null : next);
  notify();
}

/** Brightness cap for effect canvases, 0..1. */
export function getIntensity(): number {
  return intensity;
}

export function setIntensity(next: number): void {
  const clamped = Math.min(1, Math.max(0.1, next));
  if (clamped === intensity) return;
  intensity = clamped;
  write(INTENSITY_KEY, clamped === 1 ? null : String(clamped));
  notify();
}

/** Fires when the motion choice or the intensity cap changes. Returns an unsubscribe function. */
export function onMotionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether effects should animate, given the visitor's choice and the system preference. */
export function motionAllowed(systemReduced: boolean): boolean {
  return choice === 'auto' ? !systemReduced : choice === 'play';
}

/** Observe whether a host should animate. A first static frame is still drawn by the host. */
export function observeMotionEligibility(
  element: HTMLElement,
  changed: (eligible: boolean) => void,
): () => void {
  const doc = element.ownerDocument;
  const owner = doc.defaultView;
  const reduced = owner?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let inView = true;
  let previous: boolean | undefined;
  const update = () => {
    const eligible = !doc.hidden && inView && motionAllowed(reduced?.matches ?? false);
    if (eligible !== previous) {
      previous = eligible;
      changed(eligible);
    }
  };
  const observer = owner?.IntersectionObserver
    ? new owner.IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.target === element) inView = entry.isIntersecting;
        update();
      })
    : undefined;
  observer?.observe(element);
  doc.addEventListener('visibilitychange', update);
  reduced?.addEventListener('change', update);
  const stopChoice = onMotionChange(update);
  update();
  return () => {
    observer?.disconnect();
    doc.removeEventListener('visibilitychange', update);
    reduced?.removeEventListener('change', update);
    stopChoice();
  };
}
