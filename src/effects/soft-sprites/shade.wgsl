// Shading for the soft-sprites scene, plugged into the sprite renderer (src/gpu/sprites.ts) in
// place of its default: each sprite's colour comes from its heat instead of from the instance.
//
// Instance `param` = kind + heat: the integer part is the kind (0 ember, 1 spark, 2 glow puff),
// the fraction is the heat (0 nearly out .. 1 fresh from the fire). Instance colour is a tint and
// its alpha is the radiance of the sprite's peak at full heat.

#include "sprite.wgsl"

const KIND_SPARK: u32 = 1u;
const KIND_PUFF: u32 = 2u;
// `shape` values 0..3 are the renderer's (disc, gaussian, ember, streak); anything else picks the
// shape per kind.

// A stand-in for a blackbody ramp, in linear RGB: dull red when nearly out, orange, then a pale
// yellow. Brightness climbs much faster than the hue shifts, as it does for a real glowing coal.
fn ember_color(heat: f32) -> vec3f {
  let t = clamp(heat, 0.0, 1.0);
  let hue = vec3f(1.0, 0.05 + 0.6 * t * t, 0.003 + 0.24 * t * t * t * t);
  return hue * (0.03 + 0.97 * t * t);
}

// Overexposed light loses its colour: pull the hottest part of a sprite towards warm white.
fn ember_whiten(glow: vec3f, amount: f32) -> vec3f {
  let peak = max(glow.r, max(glow.g, glow.b));
  return mix(glow, peak * vec3f(1.0, 0.9, 0.72), clamp(amount, 0.0, 1.0));
}

fn shade_ember(p: vec2f, glow: vec3f) -> vec3f {
  let e = sprite_ember(p, 0.34, 0.1);
  return ember_whiten(glow, 0.75 * e.y) * e.x;
}

fn shade_streak(p: vec2f, glow: vec3f) -> vec3f {
  let s = sprite_streak(p, 0.6, 0.75);
  return ember_whiten(glow, 0.8 * s * s) * s;
}

fn shade_sprite(s: SpriteSample) -> vec3f {
  let kind = u32(s.param);
  let heat = fract(s.param);
  let glow = ember_color(heat) * s.color.rgb * s.color.a;

  // Glow puffs are always broad gaussians; the shape control is about the embers and sparks.
  if (kind == KIND_PUFF) {
    return glow * sprite_gaussian(s.p, 2.5);
  }

  switch (s.shape) {
    case 0u: {
      return glow * sprite_disc(s.p, 0.4);
    }
    case 1u: {
      return glow * sprite_gaussian(s.p, 5.0);
    }
    case 2u: {
      return shade_ember(s.p, glow);
    }
    case 3u: {
      return shade_streak(s.p, glow);
    }
    default: {
      if (kind != KIND_SPARK) {
        return shade_ember(s.p, glow);
      }
      // A spark is a streak while it flies and a round ember once it has landed: a streak has a
      // direction, and a sprite at rest has none (its quad falls back to facing +x).
      let moving = smoothstep(1.05, 1.6, s.ratio);
      return mix(shade_ember(s.p, glow), shade_streak(s.p, glow), moving);
    }
  }
}
