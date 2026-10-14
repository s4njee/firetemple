// Sprite shading of the particle flame (index.ts), replacing the sprite renderer's default
// (src/gpu/sprites.ts). `param` is the life fraction x of a flame sprite (0..1), or 2 + x for an ember
// (hooks.wgsl writes it).
//
// A flame sprite is a broad soft dome that softens further as it ages, so a young puff near the base
// is a dense blob and an old one at the tips a faint haze. Its quad is stretched along the motion
// (straight up, mostly), so the dome is a teardrop pointing the way it goes. An ember is the
// renderer's ember shape: a tight core whitened towards grey on a faint halo.
#include "sprite.wgsl"

fn shade_sprite(s: SpriteSample) -> vec3f {
  let base = s.color.rgb * s.color.a;
  if (s.param >= 1.5) {
    let ember = sprite_ember(s.p, 0.35, 0.12);
    let peak = max(base.r, max(base.g, base.b));
    return mix(base, vec3f(peak), 0.5 * ember.y) * ember.x;
  }
  let x = clamp(s.param, 0.0, 1.0);
  return base * sprite_gaussian(s.p, mix(3.2, 1.8, x));
}
