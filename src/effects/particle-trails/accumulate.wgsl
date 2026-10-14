// Accumulation trails (story 7.7): a persistent HDR target that fades by exp(-dt / tau) every frame
// and that the particles are drawn into, then added to the scene.
//
//   decay      previous -> next: next = previous * decay, rounded stochastically to a value an
//              rgba16float target holds exactly. Without that, a GPU that truncates on the write
//              (Apple's do) loses up to one half-float step per frame, which at 144 Hz is more than
//              twice as many steps as at 60 Hz: the fade would depend on the frame rate.
//   composite  the trail target into the scene, on the right of `split` (in pixels; 0 is all of it),
//              with a faint divider line at `split` when it is inside the canvas.

#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "trail-accumulate.wgsl"

@group(0) @binding(0) var<uniform> acc: TrailAccumulate;
@group(0) @binding(1) var tr_source: texture_2d<f32>;

// Rounds v >= 0 to a neighbouring half float, up with probability equal to the remainder: exact on
// average whatever the hardware does with the written value (combust_quantise in the Epic 5 sim).
fn tr_quantise(v: f32, u: f32) -> f32 {
  let exponent = max((bitcast<u32>(max(v, 0.0)) >> 23u) & 0xffu, 113u);
  let ulp = bitcast<f32>((exponent - 10u) << 23u);
  let x = v / ulp;
  let below = floor(x);
  return (below + select(0.0, 1.0, u < x - below)) * ulp;
}

@fragment
fn decay(in: FullscreenVarying) -> @location(0) vec4f {
  let px = vec2i(in.position.xy);
  let c = textureLoad(tr_source, px, 0).rgb * acc.decay;
  let u = ihash_3to3(vec3i(px, i32(acc.frame & 0x7fffffffu)));
  return vec4f(tr_quantise(c.r, u.x), tr_quantise(c.g, u.y), tr_quantise(c.b, u.z), 0.0);
}

@fragment
fn composite(in: FullscreenVarying) -> @location(0) vec4f {
  let px = vec2i(in.position.xy);
  var c = vec3f(0.0);
  if (in.position.x >= acc.split) {
    c = textureLoad(tr_source, px, 0).rgb * acc.gain;
  }
  if (acc.split > 0.5 && abs(in.position.x - acc.split) < 0.75) {
    c += vec3f(0.06);
  }
  return vec4f(c, 0.0);
}
