// Faint outlines of the 2D scene's collider and point force, added over the particles so the
// validation scene shows what the particles are bouncing off. Overlay space: x 0..aspect, y 0..1 up,
// in canvas heights (src/gpu/particles/cameras.ts, overlayCamera).

#include "fullscreen.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

fn wavy_floor(q: vec2f) -> f32 {
  return (q.y - (0.1 + 0.03 * sin(q.x * 18.0))) * 0.87;
}

fn box_distance(q: vec2f, c: vec2f, h: vec2f) -> f32 {
  let d = abs(q - c) - h;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn outline(d: f32, px: f32) -> f32 {
  return 1.0 - smoothstep(0.6 * px, 1.6 * px, abs(d));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let q = vec2f(in.uv.x * params.aspect, 1.0 - in.uv.y);
  let px = params.pixel;
  var line = 0.0;
  if (params.collider == 1u) {
    line = outline(q.y - params.a.y, px);
  } else if (params.collider == 2u) {
    line = outline(length(q - params.a.xy) - params.a.w, px);
  } else if (params.collider == 3u) {
    line = outline(box_distance(q, params.a.xy, params.b.xy), px);
  } else if (params.collider == 4u) {
    line = outline(wavy_floor(q), px);
  }
  if (params.point.w > 0.0) {
    // A dashed ring at the force's softening radius.
    let d = length(q - params.point.xy) - params.point.w;
    let angle = atan2(q.y - params.point.y, q.x - params.point.x);
    line = max(line, outline(d, px) * step(0.0, sin(angle * 12.0)));
  }
  return vec4f(vec3f(0.07, 0.09, 0.13) * params.level * line, 0.0);
}
