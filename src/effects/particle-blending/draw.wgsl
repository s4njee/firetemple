// particle-blending: one camera-facing quad per puff, drawn four ways. The vertex stage is shared;
// each blending mode has its own fragment entry point and pipeline:
//
//   fs_additive  rgb = smoke * alpha + emission, alpha untouched       blend one, one
//   fs_over      premultiplied (smoke * alpha + emission, alpha)       blend one, one-minus-src-alpha
//                (the "unsorted" and "sorted" modes; only the order bound at binding 4 differs)
//   fs_oit       weighted blended OIT accumulation (src/gpu/particles/oit.wgsl), emission apart
//
// Instance k draws puff order[k]: the depth sort's output (farthest first) for "sorted", the
// identity for the others. Puffs are soft discs whose density is broken up by one fetch of the
// shared noise tile, turned per puff, so overlapping puffs do not line up.

#include "camera.wgsl"
#include "noisetex.wgsl"
#include "oit.wgsl"
#include "draw-params.wgsl"

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<uniform> draw: DrawParams;
@group(0) @binding(2) var<storage, read> positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> looks: array<vec4f>;
@group(0) @binding(4) var<storage, read> order: array<u32>;
@group(0) @binding(5) var noise_tex: texture_2d<f32>;
@group(0) @binding(6) var noise_smp: sampler;

struct PuffVarying {
  @builtin(position) position: vec4f,
  // Quad-local position, -1..1, y up on screen.
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) colour: vec4f,
  @location(2) @interpolate(flat) emission: vec4f,
  @location(3) @interpolate(flat) view_z: f32,
}

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> PuffVarying {
  var out: PuffVarying;
  let index = order[instance];
  let centre = positions[index];
  let colour = looks[2u * index];
  let emission = looks[2u * index + 1u];
  let view_pos = (cam.view * vec4f(centre.xyz, 1.0)).xyz;
  // Dead slots and puffs behind the eye leave the clip volume: four vertices, no pixels.
  if (centre.w <= 0.0 || -view_pos.z <= cam.near) {
    out.position = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  let corner_index = vertex % 6u;
  var k = corner_index;
  if (corner_index == 3u) { k = 2u; } else if (corner_index == 4u) { k = 1u; } else if (corner_index == 5u) { k = 3u; }
  let corner = vec2f(f32(k & 1u), f32(k >> 1u)) * 2.0 - 1.0;
  out.position = cam.proj * vec4f(view_pos.xy + corner * centre.w, view_pos.z, 1.0);
  out.p = corner;
  out.colour = colour;
  out.emission = emission;
  out.view_z = -view_pos.z;
  return out;
}

struct PuffSample {
  // Premultiplied smoke colour and its opacity.
  smoke: vec3f,
  alpha: f32,
  emission: vec3f,
}

fn puff_sample(in: PuffVarying) -> PuffSample {
  var s: PuffSample;
  let r2 = dot(in.p, in.p);
  if (r2 >= 1.0) {
    return s;
  }
  let seed = in.emission.w;
  let angle = seed * 6.2831853;
  let turn = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  let n = noisetex_sample_lod(noise_tex, noise_smp, turn * in.p * 1.3 + vec2f(seed * 37.0, seed * 91.0), 0.0);
  // A soft dome, exactly 0 at the rim (see sprite_gaussian), eaten into by the noise from the rim
  // inwards, so a puff is a lumpy cauliflower rather than a disc.
  let dome = (exp(2.2 * (1.0 - r2)) - 1.0) / (exp(2.2) - 1.0);
  let lumps = 0.65 * n.r + 0.35 * n.b;
  let density = dome * smoothstep(0.62 - 0.45 * dome, 0.78 - 0.3 * dome, lumps);
  // The fire is below: the lower side of a puff is lit a little more.
  let underlight = 1.0 - draw.underlight * in.p.y;
  s.alpha = clamp(in.colour.a * density, 0.0, 1.0);
  s.smoke = in.colour.rgb * underlight * s.alpha;
  // Flame puffs: a tighter core and a noisier edge. Lanterns (seed < 0): a plain round glow.
  if (any(in.emission.rgb > vec3f(0.0))) {
    let core = (exp(3.5 * (1.0 - r2)) - 1.0) / (exp(3.5) - 1.0);
    let flame_shape = select(core * (0.4 + 1.2 * n.g), core * core, seed < 0.0);
    s.emission = in.emission.rgb * flame_shape * draw.intensity;
  }
  return s;
}

@fragment fn fs_additive(in: PuffVarying) -> @location(0) vec4f {
  let s = puff_sample(in);
  return vec4f(s.smoke + s.emission, 0.0);
}

@fragment fn fs_over(in: PuffVarying) -> @location(0) vec4f {
  let s = puff_sample(in);
  return vec4f(s.smoke + s.emission, s.alpha);
}

@fragment fn fs_oit(in: PuffVarying) -> OitAccumEmissive {
  let s = puff_sample(in);
  let w = oit_weight(s.alpha, in.view_z * draw.z_scale, in.position.z, draw.weight);
  return oit_accumulate_emissive(s.smoke, s.alpha, w, s.emission);
}
