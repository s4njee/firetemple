// ring-math.wgsl -- the geometry of the fire ring, kept apart from the shading so that
// tests/epic4-d.test.ts can run it on the GPU with numbers. No textures, no bindings.
//
// Ring space: the centre of the ring is the origin, +y is UP, and one unit is half the shorter
// side of the canvas. A "turn" is a position around the ring as a fraction of the circle: 0 at
// twelve o'clock, growing CLOCKWISE, so three o'clock is 0.25 and nine o'clock is -0.25.
//
//   RING_TAU                                       2 pi
//   ring_turn(p) -> f32                            the turn of point p, in [-0.5, 0.5]. The jump
//                                                  from +0.5 to -0.5 is at six o'clock.
//   ring_noise_uv(turn, across, repeats, rotation) -> vec2f
//       Texture coordinate into a tile that repeats once per unit: u = repeats * turn + rotation,
//       v = across. With a WHOLE number of repeats the two sides of the jump in ring_turn are a
//       whole number of tiles apart, so a repeating sampler returns the same texel for both and
//       the ring has no seam. `rotation` (any real) turns the pattern; `across` is the coordinate
//       along the flame, already in tiles.
//   ring_lit(turn, start, progress, feather, taper) -> f32
//       How much of the ring is alight at `turn`, 0..1, for an arc that begins at `start` (turns)
//       and runs clockwise for `progress` turns (0 = nothing, 1 = the whole ring).
//       The leading end fades out over the last `feather` turns of the arc. The trailing end
//       fades in over the first `taper` share of the arc (0..1; never less than `feather` turns),
//       which gives a comet when the arc is spinning. From progress 0.92 the gap closes smoothly,
//       and at progress >= 1 the result is exactly 1 everywhere: a full ring has no ends.

const RING_TAU: f32 = 6.283185307;

fn ring_turn(p: vec2f) -> f32 {
  return atan2(p.x, p.y) / RING_TAU;
}

fn ring_noise_uv(turn: f32, across: f32, repeats: f32, rotation: f32) -> vec2f {
  return vec2f(repeats * turn + rotation, across);
}

fn ring_lit(turn: f32, start: f32, progress: f32, feather: f32, taper: f32) -> f32 {
  let amount = clamp(progress, 0.0, 1.0);
  let soft = max(feather, 1e-4);
  // 0 at the start of the arc, growing clockwise, just under 1 when it comes round again.
  let along = fract(turn - start);
  let head = 1.0 - smoothstep(amount - soft, amount, along);
  let tail = smoothstep(0.0, max(clamp(taper, 0.0, 1.0) * amount, soft), along);
  return mix(head * tail, 1.0, smoothstep(0.92, 1.0, amount));
}
