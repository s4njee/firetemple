// Sprite shading of the directed jet (index.ts), replacing the sprite renderer's default
// (src/gpu/sprites.ts). `param` is the life fraction x of a flame sprite (0..1), or 2 + x for a droplet
// or an ember (hooks.wgsl writes it). A flame sprite is a soft dome that thins as it ages; droplets
// and embers are a tight core whitened towards grey on a faint halo, streaked along their motion by
// the renderer's velocity stretch.
#include "sprite.wgsl"

fn shade_sprite(s: SpriteSample) -> vec3f {
  let base = s.color.rgb * s.color.a;
  if (s.param >= 1.5) {
    let ember = sprite_ember(s.p, 0.4, 0.15);
    let peak = max(base.r, max(base.g, base.b));
    return mix(base, vec3f(peak), 0.5 * ember.y) * ember.x;
  }
  let x = clamp(s.param, 0.0, 1.0);
  return base * sprite_gaussian(s.p, mix(3.0, 1.6, x));
}
