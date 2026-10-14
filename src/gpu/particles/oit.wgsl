// oit.wgsl -- the fragment-side half of weighted blended order-independent transparency (McGuire and
// Bavoil, "Weighted Blended Order-Independent Transparency", JCGT 2(2), 2013). Include it in the
// shader of anything drawn into an `Oit` accumulation pass (src/gpu/particles/oit.ts supplies it
// as the run-time chunk "oit.wgsl"); return one of the output structs from the fragment stage.
//
// Each fragment adds its premultiplied colour times a depth weight w to `accum` (rgb) and alpha
// times w to `accum.a`, and multiplies `revealage` by (1 - alpha). The composite then draws
//   avg = accum.rgb / accum.a          (the weighted average colour of the layers)
//   out = avg * (1 - revealage) + scene * revealage
// which is exact for one layer and for layers of one colour, and otherwise weights nearer layers
// more, by w, instead of ordering them.
//
// Emission. Fire is light, not a surface: its alpha is close to 0, so dividing by accum.a would
// either blow its colour up or lose it. Emission therefore goes into a separate additive target,
// unweighted, and the composite adds it attenuated by mix(1, revealage, occlusion). That is a
// decision, not a derivation: WBOIT throws the order away, so whether the smoke at a pixel is in
// front of the flame (and should hide it) or behind it (and should not) is unknown. occlusion = 0
// lets every flame shine through all smoke; 1 dims it by all the smoke at its pixel, front and
// back. See particle-blending/notes.md for what each looks like.
//
// Weights (z = view-space distance along the view axis in the paper's units, scaled by the caller;
// d = the fragment's depth-buffer value, 0 near .. 1 far):
//   OIT_WEIGHT_NONE  w = alpha                                     plain weighted average, no depth cue
//   OIT_WEIGHT_EQ7   w = alpha * clamp(10 / (1e-5 + (z/5)^2 + (z/200)^6), 1e-2, 3e3)
//   OIT_WEIGHT_EQ8   w = alpha * clamp(10 / (1e-5 + (z/10)^3 + (z/200)^6), 1e-2, 3e3)
//   OIT_WEIGHT_EQ9   w = alpha * clamp(0.03 / (1e-5 + (z/200)^4), 1e-2, 3e3)
//   OIT_WEIGHT_EQ10  w = alpha * max(1e-2, 3e3 * (1 - d)^3)
// (equation numbers as in the paper). 7 and 8 suit scenes a few to a few tens of units deep; 9
// saturates at the 3e3 clamp anywhere nearer than about 25 units, and 10 depends on the projection
// (with near 0.1 and far 90 it is flat at the 1e-2 floor beyond a few units), so neither gives a
// small scene any depth cue without rescaling z.
//
// Half-float range: accum is rgba16float, whose largest value is 65504. Colour times weight times
// layers must stay below that: with EQ8 at z = 2 (w = 1250) a colour of 2 overflows after 26 layers.
// The composite clamps, so an overflow shows as a flat colour, not as infinity or NaN; keep HDR
// emission out of accum (use the emission output) and scale z so near layers are not too heavy.
//
//   oit_weight(alpha, z, frag_depth, equation) -> f32
//   oit_accumulate(premultiplied, alpha, w) -> OitAccum                   (two targets)
//   oit_accumulate_emissive(premultiplied, alpha, w, emission) -> OitAccumEmissive   (three)

const OIT_WEIGHT_NONE: u32 = 0u;
const OIT_WEIGHT_EQ7: u32 = 7u;
const OIT_WEIGHT_EQ8: u32 = 8u;
const OIT_WEIGHT_EQ9: u32 = 9u;
const OIT_WEIGHT_EQ10: u32 = 10u;

struct OitAccum {
  @location(0) accum: vec4f,
  @location(1) revealage: vec4f,
}

struct OitAccumEmissive {
  @location(0) accum: vec4f,
  @location(1) revealage: vec4f,
  @location(2) emission: vec4f,
}

fn oit_weight(alpha: f32, z: f32, frag_depth: f32, equation: u32) -> f32 {
  let a = abs(z);
  var w = 1.0;
  switch (equation) {
    case 7u: {
      let q = a / 5.0;
      let r = a / 200.0;
      w = 10.0 / (1e-5 + q * q + r * r * r * r * r * r);
    }
    case 8u: {
      let q = a / 10.0;
      let r = a / 200.0;
      w = 10.0 / (1e-5 + q * q * q + r * r * r * r * r * r);
    }
    case 9u: {
      let r = a / 200.0;
      w = 0.03 / (1e-5 + r * r * r * r);
    }
    case 10u: {
      let e = 1.0 - clamp(frag_depth, 0.0, 1.0);
      w = 3e3 * e * e * e;
    }
    default: {
      return alpha;
    }
  }
  return alpha * clamp(w, 1e-2, 3e3);
}

fn oit_accumulate(premultiplied: vec3f, alpha: f32, w: f32) -> OitAccum {
  var out: OitAccum;
  out.accum = vec4f(premultiplied, alpha) * w;
  out.revealage = vec4f(alpha);
  return out;
}

fn oit_accumulate_emissive(premultiplied: vec3f, alpha: f32, w: f32, emission: vec3f) -> OitAccumEmissive {
  var out: OitAccumEmissive;
  out.accum = vec4f(premultiplied, alpha) * w;
  out.revealage = vec4f(alpha);
  out.emission = vec4f(emission, 0.0);
  return out;
}
