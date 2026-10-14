// Sort keys from particle positions (src/gpu/particles/sort.ts). One invocation per slot:
//   keys[i]   = an unsigned integer that is SMALLER for particles FURTHER from the camera, so an
//               ascending sort puts the farthest first (back to front, the order "over" needs)
//   values[i] = the particle index: i, or, in the temporal sort, last frame's sorted order kept
// Slots from `count` to `n` (the bitonic sort's padding to a power of two) get the largest key, so
// they sort to the end, and an index nobody reads.
//
// Depth is the view-space distance along the view axis (camera_linear_depth's unit), not the
// distance to the eye: alpha compositing of camera-facing quads needs the order of the planes they
// lie in. 32-bit keys are the float's own bits made order-preserving: exact, any range, ties only
// for equal depths. 16-bit keys quantise depth linearly between the camera's near and far planes
// (far / 65535 apart: 1.4 mm for a 90 m far plane), which halves the radix passes.

#include "camera.wgsl"
#include "sort-step.wgsl"

@group(0) @binding(0) var<uniform> pstep: PsortStep;
@group(0) @binding(1) var<uniform> cam: Camera;
@group(0) @binding(2) var<storage, read> positions: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@group(0) @binding(4) var<storage, read_write> values: array<u32>;

// Order-preserving bits of a float (Herf's radix trick), inverted so that far sorts first.
fn psort_key32(z: f32) -> u32 {
  let b = bitcast<u32>(z);
  let ordered = select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
  return ~ordered;
}

fn psort_key16(z: f32) -> u32 {
  let t = clamp((z - cam.near) / max(cam.far - cam.near, 1e-6), 0.0, 1.0);
  return 65535u - u32(t * 65535.0 + 0.5);
}

@compute @workgroup_size(256)
fn psort_keys(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= pstep.n) {
    return;
  }
  if (i >= pstep.count) {
    keys[i] = 0xffffffffu;
    values[i] = i;
    return;
  }
  var index = i;
  if (pstep.reuse_order != 0u) {
    index = values[i];
  }
  let p = positions[index].xyz;
  let z = -(cam.view * vec4f(p, 1.0)).z;
  keys[i] = select(psort_key32(z), psort_key16(z), pstep.key_bits == 16u);
  values[i] = index;
}
