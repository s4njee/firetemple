import { describe, expect, it } from 'vitest';
import { trackPointer, trackPointers, type TrackedPointer } from '../src/gpu/pointer.ts';

// There is no DOM here: a canvas is an EventTarget with a size, which is all the trackers use.

interface StubCanvas extends EventTarget {
  style: { touchAction?: string };
  captured: number[];
}

function fakeCanvas(width = 400, height = 200): StubCanvas & HTMLCanvasElement {
  const canvas = Object.assign(new EventTarget(), {
    style: {} as { touchAction?: string },
    captured: [] as number[],
    getBoundingClientRect: () => ({ left: 100, top: 50, width, height }),
    setPointerCapture(id: number) {
      canvas.captured.push(id);
    },
    releasePointerCapture() {},
  });
  return canvas as unknown as StubCanvas & HTMLCanvasElement;
}

interface EventInit {
  id?: number;
  type?: string;
  /** Position in the canvas's 0..1 space; converted to client coordinates for the stub canvas. */
  x: number;
  y: number;
  time?: number;
  pressure?: number;
}

/** A synthetic pointer event: a plain Event with the PointerEvent fields the trackers read. */
function pointerEvent(kind: string, init: EventInit, canvas = fakeCanvas()): Event {
  const event = new Event(kind);
  const { width, height } = canvas.getBoundingClientRect();
  Object.defineProperties(event, {
    pointerId: { value: init.id ?? 1 },
    pointerType: { value: init.type ?? 'mouse' },
    clientX: { value: 100 + init.x * width },
    clientY: { value: 50 + init.y * height },
    pressure: { value: init.pressure ?? 0 },
    timeStamp: { value: init.time ?? 1000 },
  });
  return event;
}

function send(canvas: StubCanvas & HTMLCanvasElement, kind: string, init: EventInit) {
  canvas.dispatchEvent(pointerEvent(kind, init, canvas));
}

const only = (pointers: TrackedPointer[]): TrackedPointer => {
  expect(pointers).toHaveLength(1);
  return pointers[0]!;
};

describe('trackPointers', () => {
  it('maps client coordinates into the canvas 0..1 space', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.25, y: 0.75 });
    const pointer = only(tracker.poll(1000));
    expect(pointer.x).toBeCloseTo(0.25);
    expect(pointer.y).toBeCloseTo(0.75);
    expect(pointer.inside).toBe(true);
    expect(pointer.justEntered).toBe(true);
    expect(pointer.down).toBe(false);
    expect(pointer.type).toBe('mouse');
    tracker.destroy();
  });

  it('reports movement per frame and clears it after each poll', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.1, y: 0.1, time: 1000 });
    tracker.poll(1000);
    send(canvas, 'pointermove', { x: 0.2, y: 0.1, time: 1010 });
    send(canvas, 'pointermove', { x: 0.3, y: 0.2, time: 1020 });
    const moved = only(tracker.poll(1020));
    expect(moved.dx).toBeCloseTo(0.2);
    expect(moved.dy).toBeCloseTo(0.1);
    expect(moved.justEntered).toBe(false);
    const still = only(tracker.poll(1040));
    expect(still.dx).toBe(0);
    expect(still.dy).toBe(0);
    tracker.destroy();
  });

  it('does not count entering the canvas as movement', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.1, y: 0.1, time: 1000 });
    tracker.poll(1000);
    send(canvas, 'pointerleave', { x: 0.1, y: 0.1, time: 1010 });
    const left = only(tracker.poll(1010));
    expect(left.justLeft).toBe(true);
    expect(left.inside).toBe(false);
    // A mouse that left and is not pressed is forgotten after being reported once.
    expect(tracker.poll(1020)).toHaveLength(0);
    send(canvas, 'pointerenter', { x: 0.9, y: 0.9, time: 5000 });
    send(canvas, 'pointermove', { x: 0.9, y: 0.9, time: 5010 });
    const back = only(tracker.poll(5010));
    expect(back.dx).toBeCloseTo(0);
    expect(back.dy).toBeCloseTo(0);
    // Not connected to where it was before it left.
    expect(back.path[0]!.x).toBeCloseTo(0.9);
    tracker.destroy();
  });

  it('estimates velocity from event times, in canvas units per second', () => {
    const canvas = fakeCanvas(400, 200);
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0, y: 0.5, time: 1000 });
    // 0.01 of the width every 10 ms: 1 canvas width per second = 2 canvas heights per second.
    for (let i = 1; i <= 40; i++)
      send(canvas, 'pointermove', { x: i * 0.01, y: 0.5, time: 1000 + i * 10 });
    const fast = only(tracker.poll(1400));
    expect(fast.vx).toBeGreaterThan(0.8);
    expect(fast.vx).toBeLessThan(1.1);
    expect(fast.vy).toBeCloseTo(0, 1);
    // Speed is in canvas heights per second: the canvas is twice as wide as it is tall.
    expect(fast.speed).toBeGreaterThan(1.6);
    expect(fast.speed).toBeLessThan(2.2);
    // Not moving for a while means standing still.
    const still = only(tracker.poll(1800));
    expect(still.vx).toBe(0);
    expect(still.speed).toBe(0);
    tracker.destroy();
  });

  it('tracks a press: edge flags last one poll, `down` lasts until release', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.5, y: 0.5, time: 1000 });
    send(canvas, 'pointerdown', { x: 0.5, y: 0.5, time: 1010, pressure: 0.5 });
    expect(tracker.pressedCount).toBe(1);
    const pressed = only(tracker.poll(1010));
    expect(pressed.justPressed).toBe(true);
    expect(pressed.down).toBe(true);
    expect(pressed.pressure).toBe(0.5);
    const held = only(tracker.poll(1030));
    expect(held.justPressed).toBe(false);
    expect(held.down).toBe(true);
    send(canvas, 'pointerup', { x: 0.5, y: 0.5, time: 1040 });
    expect(tracker.pressedCount).toBe(0);
    const released = only(tracker.poll(1040));
    expect(released.justReleased).toBe(true);
    expect(released.down).toBe(false);
    expect(released.cancelled).toBe(false);
    tracker.destroy();
  });

  it('follows two fingers at once, each by its own id, and forgets a lifted touch', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerdown', { id: 7, type: 'touch', x: 0.2, y: 0.3, time: 1000 });
    send(canvas, 'pointerdown', { id: 8, type: 'touch', x: 0.8, y: 0.6, time: 1001 });
    expect(tracker.pressedCount).toBe(2);
    send(canvas, 'pointermove', { id: 7, type: 'touch', x: 0.25, y: 0.3, time: 1016 });
    send(canvas, 'pointermove', { id: 8, type: 'touch', x: 0.8, y: 0.5, time: 1017 });
    const both = tracker.poll(1017);
    expect(both.map((p) => p.id).sort()).toEqual([7, 8]);
    const a = both.find((p) => p.id === 7)!;
    const b = both.find((p) => p.id === 8)!;
    expect(a.type).toBe('touch');
    expect(a.dx).toBeCloseTo(0.05);
    expect(a.dy).toBeCloseTo(0);
    expect(b.dx).toBeCloseTo(0);
    expect(b.dy).toBeCloseTo(-0.1);
    expect(a.justPressed && b.justPressed).toBe(true);

    send(canvas, 'pointerup', { id: 7, type: 'touch', x: 0.25, y: 0.3, time: 1030 });
    send(canvas, 'pointerleave', { id: 7, type: 'touch', x: 0.25, y: 0.3, time: 1030 });
    const next = tracker.poll(1030);
    expect(next.find((p) => p.id === 7)!.justReleased).toBe(true);
    // The lifted finger is gone from the next poll; the other is still down.
    const last = tracker.poll(1050);
    expect(last.map((p) => p.id)).toEqual([8]);
    expect(last[0]!.down).toBe(true);
    tracker.destroy();
  });

  it('treats a cancelled touch as a release flagged `cancelled`', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerdown', { id: 3, type: 'touch', x: 0.5, y: 0.5 });
    tracker.poll(1000);
    send(canvas, 'pointercancel', { id: 3, type: 'touch', x: 0.5, y: 0.5 });
    const gone = only(tracker.poll(1010));
    expect(gone.justReleased).toBe(true);
    expect(gone.cancelled).toBe(true);
    expect(gone.down).toBe(false);
    tracker.destroy();
  });

  it('ends a mouse press that leaves the canvas when it is not captured', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerdown', { x: 0.9, y: 0.5, time: 1000 });
    tracker.poll(1000);
    send(canvas, 'pointerleave', { x: 1.1, y: 0.5, time: 1010 });
    const out = only(tracker.poll(1010));
    expect(out.down).toBe(false);
    expect(out.justReleased).toBe(true);
    tracker.destroy();
  });

  it('keeps the whole path of a frame, joined to where the last frame ended', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.1, y: 0.5, time: 1000 });
    send(canvas, 'pointermove', { x: 0.1, y: 0.5, time: 1001 });
    const first = only(tracker.poll(1001));
    expect(first.path.length).toBeGreaterThanOrEqual(1);
    send(canvas, 'pointermove', { x: 0.3, y: 0.5, time: 1010 });
    send(canvas, 'pointermove', { x: 0.5, y: 0.5, time: 1020 });
    const second = only(tracker.poll(1020));
    // Starts at the end of the previous frame, then one point per move event.
    expect(second.path.map((p) => Number(p.x.toFixed(2)))).toEqual([0.1, 0.3, 0.5]);
    const idle = only(tracker.poll(1040));
    expect(idle.path).toHaveLength(1);
    expect(idle.path[0]!.x).toBeCloseTo(0.5);
    tracker.destroy();
  });

  it('uses coalesced events when the browser provides them', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas);
    send(canvas, 'pointerenter', { x: 0.1, y: 0.5, time: 1000 });
    tracker.poll(1000);
    const move = pointerEvent('pointermove', { x: 0.4, y: 0.5, time: 1016 }, canvas);
    Object.defineProperty(move, 'getCoalescedEvents', {
      value: () =>
        [0.2, 0.3, 0.4].map((x, i) =>
          pointerEvent('pointermove', { x, y: 0.5, time: 1005 + i * 5 }, canvas),
        ),
    });
    canvas.dispatchEvent(move);
    const frame = only(tracker.poll(1016));
    expect(frame.path.map((p) => Number(p.x.toFixed(2)))).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(frame.dx).toBeCloseTo(0.3);
    tracker.destroy();
  });

  it('captures the pointer and blocks touch scrolling only when asked', () => {
    const free = fakeCanvas();
    const ambient = trackPointers(free);
    send(free, 'pointerdown', { x: 0.5, y: 0.5 });
    expect(free.style.touchAction).toBeUndefined();
    expect(free.captured).toEqual([]);
    ambient.destroy();

    const stirring = fakeCanvas();
    const captured = trackPointers(stirring, { capture: true });
    expect(stirring.style.touchAction).toBe('none');
    send(stirring, 'pointerdown', { id: 5, x: 0.5, y: 0.5 });
    expect(stirring.captured).toEqual([5]);
    captured.destroy();
    expect(stirring.style.touchAction).toBeUndefined();

    // And switchable while running.
    const toggled = fakeCanvas();
    const tracker = trackPointers(toggled);
    tracker.setCapture(true);
    expect(toggled.style.touchAction).toBe('none');
    tracker.setCapture(false);
    expect(toggled.style.touchAction).toBeUndefined();
    tracker.destroy();
  });

  it('ignores pointers beyond the limit and stops listening when destroyed', () => {
    const canvas = fakeCanvas();
    const tracker = trackPointers(canvas, { maxPointers: 2 });
    for (let id = 1; id <= 4; id++)
      send(canvas, 'pointerdown', { id, type: 'touch', x: id / 5, y: 0.5 });
    expect(tracker.poll(1000)).toHaveLength(2);
    tracker.destroy();
    send(canvas, 'pointerdown', { id: 9, x: 0.5, y: 0.5 });
    expect(tracker.poll(1000)).toHaveLength(0);
  });

  it('leaves trackPointer, the single-pointer tracker, as it was', () => {
    const canvas = fakeCanvas();
    const single = trackPointer(canvas, { capture: true });
    send(canvas, 'pointerenter', { x: 0.25, y: 0.5 });
    send(canvas, 'pointerdown', { x: 0.5, y: 0.5 });
    send(canvas, 'pointermove', { x: 0.75, y: 0.5 });
    expect(single.state).toEqual({ x: 0.75, y: 0.5, down: true, inside: true });
    expect(single.takeDelta().dx).toBeCloseTo(0.5);
    single.destroy();
  });
});
