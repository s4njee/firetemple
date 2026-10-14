// Spark shading for the shared sprite renderer (src/gpu/sprites.ts calls `shade_sprite` per pixel).
// A moving spark is a streak: sprite_streak's bright head with a tail that narrows behind it, the
// shape a camera's exposure gives a point of light. A slow one (resting on the floor, or at the top
// of its arc) is a round dot instead, so nothing turns to face +x as it stops: the shape blends from
// the dot to the streak as the stretch ratio grows from 1 to 3. The hottest part of either is pushed
// towards white, as an overexposed spark is.

#include "sprite.wgsl"

fn shade_sprite(s: SpriteSample) -> vec3f {
  let base = s.color.rgb * s.color.a;
  let peak = max(base.r, max(base.g, base.b));
  let dot_shape = sprite_gaussian(s.p, 5.0);
  let streak = sprite_streak(s.p, 0.62, 0.75);
  let w = clamp((s.ratio - 1.0) * 0.5, 0.0, 1.0);
  let shape = mix(dot_shape, streak, w);
  return mix(base, vec3f(peak), 0.55 * shape * shape) * shape;
}
