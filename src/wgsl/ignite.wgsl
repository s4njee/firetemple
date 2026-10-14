// ignite.wgsl -- where a simulation step should add heat: taps, drags and stray embers.
//
// The CPU side is src/gpu/sim/ignition.ts. It collects igniters (from pointers, from an ambient
// ember schedule, from anything else) and writes them into the uniform block declared here. A tap
// is a point; a drag is the SEGMENT the pointer covered since the last step, so a fast stroke
// leaves a continuous line of fire, not a row of dots.
//
// Coordinates: canvas uv, (0, 0) at the top-left, like fullscreen.wgsl. Distances are measured in
// canvas HEIGHTS (x is scaled by the aspect ratio), so an igniter is round on any canvas.
//
// struct Igniters     the uniform block. Declare `@group(g) @binding(b) var<uniform> ig: Igniters;`
//                     and fill it with `writeIgniters`. tests/sim-input.test.ts checks that this
//                     declaration matches the TypeScript one.
//     count     igniters in use this step (0..IGNITE_MAX)
//     aspect    canvas width / height
//     segments  per igniter: xy = start, zw = end, in uv (equal for a tap)
//     shapes    per igniter: x = radius in canvas heights, y = strength, zw unused
//
//   IGNITE_MAX                                   16
//   ignite_distance(uv, aspect, segment) -> f32  distance from uv to the segment, in canvas heights
//   ignite_one(uv, aspect, segment, shape) -> f32
//       Heat one igniter adds at uv: `strength` on the segment, falling smoothly to exactly 0 at
//       `radius`. Never negative. A zero radius adds nothing.
//
// Use it from the step shader. Loop in the shader rather than through a helper that takes the
// whole block, so the 500-byte struct is never copied per pixel:
//
//   var heat = 0.0;
//   for (var i = 0u; i < ig.count; i++) {
//     heat += ignite_one(uv, ig.aspect, ig.segments[i], ig.shapes[i]);
//   }
//
// Cost: per igniter, one segment distance (a dot product, a divide, a length) and a smoothstep.
// With `count` 0 the loop does not run.

const IGNITE_MAX: u32 = 16u;

struct Igniters {
  count: u32,
  aspect: f32,
  segments: array<vec4f, 16>,
  shapes: array<vec4f, 16>,
}

fn ignite_distance(uv: vec2f, aspect: f32, segment: vec4f) -> f32 {
  let scale = vec2f(aspect, 1.0);
  let p = uv * scale;
  let a = segment.xy * scale;
  let b = segment.zw * scale;
  let ab = b - a;
  let len2 = dot(ab, ab);
  // A tap has no length: the nearest point of the "segment" is the point itself.
  let t = select(clamp(dot(p - a, ab) / max(len2, 1e-12), 0.0, 1.0), 0.0, len2 < 1e-12);
  return length(p - (a + ab * t));
}

fn ignite_one(uv: vec2f, aspect: f32, segment: vec4f, shape: vec4f) -> f32 {
  let radius = shape.x;
  if (radius <= 0.0) { return 0.0; }
  let d = ignite_distance(uv, aspect, segment);
  return shape.y * (1.0 - smoothstep(0.0, radius, d));
}
