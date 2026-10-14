// "Is anything left to burn?", so the solver can regrow the whole map a while after the last of
// it has gone without the CPU ever reading a texture back. A pyramid of small passes, each
// taking the maximum over BURN_BLOCK x BURN_BLOCK texels of the level below; burn-world.wgsl
// reads the top. Every pass is wide and shallow: one long loop in a few threads is what the GPU
// is slowest at (a 16 x 16 block per thread read 1.7 ms in Chrome at 1080p; this reads at the
// timing floor).
//
//   fs      level 0, from the state and the map: 1 where any cell of the block is live, that is
//           fuel that has not burnt through (lit or not), or anything still glowing
//   fs_max  every further level: the maximum of the block
#include "fullscreen.wgsl"

const BURN_BLOCK: i32 = 4;

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var map_tex: texture_2d<f32>;
@group(0) @binding(2) var level_tex: texture_2d<f32>;

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(source_tex));
  let origin = vec2i(in.position.xy) * BURN_BLOCK;
  var live = 0.0;
  for (var y = 0; y < BURN_BLOCK; y++) {
    for (var x = 0; x < BURN_BLOCK; x++) {
      let c = origin + vec2i(x, y);
      if (any(c >= dims)) { continue; }
      let s = textureLoad(source_tex, c, 0);
      let solid = textureLoad(map_tex, c, 0).r < 0.0;
      if ((solid && (s.a > 0.0 || s.r > 0.0)) || s.g > 0.05) { live = 1.0; }
    }
  }
  return vec4f(live, 0.0, 0.0, 1.0);
}

@fragment fn fs_max(in: FullscreenVarying) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(level_tex));
  let origin = vec2i(in.position.xy) * BURN_BLOCK;
  var live = 0.0;
  for (var y = 0; y < BURN_BLOCK; y++) {
    for (var x = 0; x < BURN_BLOCK; x++) {
      let c = origin + vec2i(x, y);
      if (any(c >= dims)) { continue; }
      live = max(live, textureLoad(level_tex, c, 0).r);
    }
  }
  return vec4f(live, 0.0, 0.0, 1.0);
}
