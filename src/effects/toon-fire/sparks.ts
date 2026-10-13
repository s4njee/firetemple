/*
 * The sparks of the toon fire: where each one is at a given moment of the animation. This runs
 * once a frame in JavaScript and the result goes to the shader as a small uniform array, because
 * none of it depends on the pixel. (Hashing each spark's seed per pixel cost more than the
 * flame's two texture fetches.)
 */

/** The size of the shader's `spark` array. */
export const MAX_SPARKS = 12;

/** A fixed pseudo-random number in [0, 1) for spark `index`, stream `salt`. */
function sparkHash(index: number, salt: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Where the sparks are at animation time `time`, as (x, y, size, 0) in flame heights: each one
 * leaves the flame at its own spot and pace, fans outward, wobbles, shrinks, and starts again.
 * `halfWidth` is the half width of the strip they are born in.
 */
export function sparkPositions(time: number, count: number, halfWidth: number, wobble: number) {
  const sparks: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = sparkHash(i, 2);
    const age = (time * (0.3 + 0.25 * sparkHash(i, 0)) + start) % 1;
    const x0 = (sparkHash(i, 1) - 0.5) * 2 * halfWidth;
    sparks.push(
      x0 * (1 + 0.7 * age) + wobble * Math.sin(age * 8 + start * 2 * Math.PI),
      0.4 + 0.95 * age,
      0.036 * (1 - age * age),
      0,
    );
  }
  return sparks;
}
