import { expect, it, vi } from 'vitest';
import {
  getIntensity,
  getMotionChoice,
  INTENSITY_STEPS,
  motionAllowed,
  observeMotionEligibility,
  onMotionChange,
  setIntensity,
  setMotionChoice,
} from '../src/shell/motion.ts';

it('pauses for hidden/offscreen/reduced motion independently and cleans up observers', () => {
  let intersection: (
    entries: { target: HTMLElement; isIntersecting: boolean }[],
  ) => void = () => {};
  const disconnect = vi.fn();
  const reduced = Object.assign(new EventTarget(), { matches: false });
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: {
      matchMedia: () => reduced,
      IntersectionObserver: class {
        constructor(callback: typeof intersection) {
          intersection = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    },
  });
  const element = { ownerDocument: doc } as unknown as HTMLElement;
  const states: boolean[] = [];
  const stop = observeMotionEligibility(element, (eligible) => states.push(eligible));
  expect(states).toEqual([true]);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(states.at(-1)).toBe(false);
  intersection([{ target: element, isIntersecting: false }]);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(states).toEqual([true, false]);
  intersection([{ target: element, isIntersecting: true }]);
  expect(states.at(-1)).toBe(true);
  reduced.matches = true;
  reduced.dispatchEvent(new Event('change'));
  expect(states.at(-1)).toBe(false);
  reduced.matches = false;
  reduced.dispatchEvent(new Event('change'));
  expect(states.at(-1)).toBe(true);
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  reduced.matches = true;
  reduced.dispatchEvent(new Event('change'));
  expect(states.at(-1)).toBe(true);
});

it('starts static under reduced motion and works without optional browser observers', () => {
  const reduced = Object.assign(new EventTarget(), { matches: true });
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: { matchMedia: () => reduced },
  });
  const changes = vi.fn();
  const stop = observeMotionEligibility({ ownerDocument: doc } as unknown as HTMLElement, changes);
  expect(changes).toHaveBeenCalledWith(false);
  stop();
  const headless = Object.assign(new EventTarget(), { hidden: false, defaultView: null });
  observeMotionEligibility({ ownerDocument: headless } as unknown as HTMLElement, changes)();
  expect(changes).toHaveBeenLastCalledWith(true);
});

it('lets an explicit choice override the system preference, in both directions', () => {
  const reduced = Object.assign(new EventTarget(), { matches: true });
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: { matchMedia: () => reduced },
  });
  const states: boolean[] = [];
  const stop = observeMotionEligibility({ ownerDocument: doc } as unknown as HTMLElement, (e) =>
    states.push(e),
  );
  expect(states).toEqual([false]);
  expect(motionAllowed(true)).toBe(false);

  setMotionChoice('play');
  expect(states.at(-1)).toBe(true);
  expect(motionAllowed(true)).toBe(true);

  reduced.matches = false;
  reduced.dispatchEvent(new Event('change'));
  setMotionChoice('pause');
  expect(states.at(-1)).toBe(false);
  expect(motionAllowed(false)).toBe(false);

  setMotionChoice('auto');
  expect(states.at(-1)).toBe(true);
  expect(getMotionChoice()).toBe('auto');

  stop();
  setMotionChoice('pause');
  expect(states.at(-1)).toBe(true);
  setMotionChoice('auto');
});

it('clamps the intensity cap and tells listeners once per change', () => {
  const heard = vi.fn();
  const stop = onMotionChange(heard);
  setIntensity(0.4);
  expect(getIntensity()).toBe(0.4);
  setIntensity(0.4);
  expect(heard).toHaveBeenCalledTimes(1);
  setIntensity(5);
  expect(getIntensity()).toBe(1);
  setIntensity(0);
  expect(getIntensity()).toBe(0.1);
  setIntensity(1);
  stop();
  expect(INTENSITY_STEPS[0]).toBe(1);
});
