// sprite.wgsl -- building blocks for camera-facing additive sprites (embers, sparks, glow puffs):
// procedural shapes, the "soft particles" depth fade, and velocity-stretched billboards.
// No bindings and no textures: every function takes what it needs as arguments. The instanced
// renderer that uses them is src/gpu/sprites.ts.
//
// Quad-local coordinate `p`: (-1, -1) .. (1, 1) across the quad, y up, +x along the direction of
// motion when the quad is stretched. Every shape is exactly 0 for |p.x| >= 1 or |p.y| >= 1 (the
// round ones for length(p) >= 1), so a quad never shows its corners, and peaks at 1.
// Multiply by linear HDR radiance (docs/effect-authoring.md: embers 1..3, cores 15..50).
//
// Quad
//   sprite_corner(vertex_index: u32) -> vec2f
//       corner of a 6-vertex triangle-list quad, in -1..1; draw(6, instances) with no vertex buffer
//
// Shapes (intensity 0..1)
//   sprite_disc(p, softness) -> f32
//       flat disc: 1 inside radius 1 - softness, smooth fall to 0 at radius 1. softness in
//       (0, 1]; 1 is a smooth bump, 0.05 a nearly hard-edged disc. Never increases with radius.
//   sprite_gaussian(p, sharpness) -> f32
//       exp(-sharpness * r^2), shifted and rescaled so it is exactly 0 at r = 1 and 1 at r = 0
//       (the peak to within float rounding, 1e-6). sharpness is clamped to 0.01..40: 1 is a broad
//       dome, 4 a soft glow, 12 a tight dot. Strictly decreasing along a radius.
//   sprite_ember(p, core_radius, halo) -> vec2f
//       x: intensity, a tight core of radius core_radius (0..1, typically 0.2..0.4) on top of a
//          wide halo whose level relative to the peak is halo (0..1, typically 0.05..0.25)
//       y: core weight 0..1 (1 at the centre, 0 outside core_radius), for whitening the colour
//       Both never increase with radius.
//   sprite_streak(p, head, width) -> f32
//       spark streak along +x: a rounded head at p = (head, 0) (head in -0.9..0.9, typically 0.5),
//       a tail that fades and narrows to nothing at p.x = -1, half-width `width` (0..1) at the
//       head. Along the axis it rises from 0 at the tail end to 1 at the head, then drops to 0 at
//       p.x = 1.
//
// Depth fade ("soft particles", Lorach 2007). Depths are LINEAR view-space distances along the view
// axis in world units (camera_linear_depth in camera.wgsl), not depth-buffer values.
//   sprite_depth_fade(scene_z, sprite_z, fade_distance) -> f32
//       0 when the sprite is at or behind the geometry (scene_z <= sprite_z), rising linearly to 1
//       when the geometry is fade_distance or more behind it. fade_distance <= 0 gives the hard
//       depth test: 0 or 1.
//   sprite_depth_fade_contrast(scene_z, sprite_z, fade_distance, contrast) -> f32
//       the same ramp through the paper's contrast curve: contrast 1 is linear, 2..4 an S-curve
//       that is flatter at both ends (no visible start or end of the fade) and steeper in the
//       middle. Still exactly 0 at/behind geometry, exactly 1 at fade_distance, monotonic. One pow.
//   sprite_near_fade(sprite_z, start, end) -> f32
//       0 for sprite_z <= start, 1 for sprite_z >= end, smooth between: stops a sprite popping as
//       it crosses the near plane. Typically start = near, end = a few times near.
//
// Velocity stretch (vertex stage; view space looks down -Z, see camera.wgsl)
//   sprite_screen_velocity(view_pos, view_velocity) -> vec2f
//       the part of a view-space velocity that moves the sprite on screen, as a view-space xy
//       vector in world units per second at the sprite's own depth. A sprite flying straight at
//       (or away from) the eye gives (0, 0), wherever it is on screen.
//   sprite_stretch_ratio(screen_velocity, stretch, max_ratio) -> f32
//       length / width of the stretched quad: 1 + stretch * speed, clamped to [1, max_ratio].
//       stretch is in seconds per world unit (roughly an exposure time divided by the size).
//       Divide the sprite's radiance by this (or by a root of it) to keep its total light constant.
//   sprite_stretch_offset(corner, screen_velocity, size, ratio, trail) -> vec2f
//       view-space xy offset of a quad corner (add it to the view-space centre, then project).
//       size is the half-width in world units; the half-length is size * ratio along the
//       velocity. trail 0 centres the quad on the sprite (motion blur), 1 keeps its leading edge
//       where the unstretched quad's was, so the whole stretch trails behind (comet). When the
//       screen velocity is (near) zero the direction is undefined: the quad falls back to the
//       unstretched camera-facing square with +x to the right. Round shapes cross that fallback
//       without a pop; sprite_streak turns to face +x, so fade a streak out before it stops.
//
// Sub-pixel sprites
//   sprite_pixel_clamp(size, pixels_per_unit, min_pixels) -> vec2f
//       x: size, raised so the sprite is at least min_pixels in radius on screen;
//       y: factor (0..1] to multiply its radiance by so the enlarged sprite emits the same light.
//       pixels_per_unit at view depth z is proj[1][1] * viewport_height * 0.5 / z. Without this a
//       sprite smaller than a pixel flickers as it crosses pixel centres.
//
// Cost: each shape is one sqrt or exp and a handful of ALU ops (sprite_ember: one sqrt, one exp);
// the depth fades are a divide and a clamp (plus one pow for the contrast version); the stretch
// functions are a sqrt each. Nothing loops or samples.

fn sprite_corner(vertex_index: u32) -> vec2f {
  // Two counter-clockwise triangles: corners 0 1 2 and 2 1 3, where corner k = (k & 1, k >> 1).
  let i = vertex_index % 6u;
  var k = i;
  if (i == 3u) {
    k = 2u;
  } else if (i == 4u) {
    k = 1u;
  } else if (i == 5u) {
    k = 3u;
  }
  return vec2f(f32(k & 1u), f32(k >> 1u)) * 2.0 - 1.0;
}

fn sprite_disc(p: vec2f, softness: f32) -> f32 {
  let s = clamp(softness, 1e-3, 1.0);
  return 1.0 - smoothstep(1.0 - s, 1.0, length(p));
}

fn sprite_gaussian(p: vec2f, sharpness: f32) -> f32 {
  let k = clamp(sharpness, 1e-2, 40.0);
  // (exp(-k r^2) - exp(-k)) / (1 - exp(-k)) with both halves multiplied by exp(k): subtracting the
  // value a plain gaussian still has at the quad edge is what removes the faint square a
  // truncated gaussian leaves once sprites pile up additively. Written this way the edge is
  // exp(0) - 1, which is exactly 0 and never negative, whatever the device's exp rounds to.
  let r2 = min(dot(p, p), 1.0);
  return min((exp(k * (1.0 - r2)) - 1.0) / (exp(k) - 1.0), 1.0);
}

fn sprite_ember(p: vec2f, core_radius: f32, halo: f32) -> vec2f {
  let r = length(p);
  let t = max(1.0 - r / clamp(core_radius, 1e-3, 1.0), 0.0);
  let core = t * t * (3.0 - 2.0 * t);
  let wide = sprite_gaussian(p, 4.0);
  return vec2f(mix(core, wide, clamp(halo, 0.0, 1.0)), core);
}

fn sprite_streak(p: vec2f, head: f32, width: f32) -> f32 {
  let h = clamp(head, -0.9, 0.9);
  let w = clamp(width, 1e-3, 1.0);
  if (p.x >= h) {
    // The rounded head: an ellipse reaching the leading edge of the quad.
    let q = vec2f((p.x - h) / (1.0 - h), p.y / w);
    let a = max(1.0 - dot(q, q), 0.0);
    return a * a;
  }
  // The tail: t runs from 0 at the far end to 1 at the head, and the streak narrows with it.
  let t = max((p.x + 1.0) / (h + 1.0), 0.0);
  let v = p.y / (w * mix(0.25, 1.0, t));
  let across = max(1.0 - v * v, 0.0);
  return t * t * across * across;
}

fn sprite_depth_fade(scene_z: f32, sprite_z: f32, fade_distance: f32) -> f32 {
  return clamp((scene_z - sprite_z) / max(fade_distance, 1e-6), 0.0, 1.0);
}

fn sprite_depth_fade_contrast(
  scene_z: f32,
  sprite_z: f32,
  fade_distance: f32,
  contrast: f32,
) -> f32 {
  let x = sprite_depth_fade(scene_z, sprite_z, fade_distance);
  // Lorach's contrast function: mirror the upper half onto the lower, raise to a power, unmirror.
  let lower = x <= 0.5;
  let folded = clamp(2.0 * select(1.0 - x, x, lower), 0.0, 1.0);
  let curved = 0.5 * pow(folded, max(contrast, 1e-3));
  let y = select(1.0 - curved, curved, lower);
  // pow(0, c) is exact on every backend tried, but the two ends are promises, so pin them.
  return select(select(y, 1.0, x >= 1.0), 0.0, x <= 0.0);
}

fn sprite_near_fade(sprite_z: f32, start: f32, end: f32) -> f32 {
  let t = clamp((sprite_z - start) / max(end - start, 1e-6), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn sprite_screen_velocity(view_pos: vec3f, view_velocity: vec3f) -> vec2f {
  // Velocity of the point's projection onto the plane z = view_pos.z: d/dt of (xy / z) times z.
  // In front of the camera z is negative; the clamp only guards the divide.
  let z = min(view_pos.z, -1e-4);
  return view_velocity.xy - view_pos.xy * (view_velocity.z / z);
}

fn sprite_stretch_ratio(screen_velocity: vec2f, stretch: f32, max_ratio: f32) -> f32 {
  return clamp(1.0 + stretch * length(screen_velocity), 1.0, max(max_ratio, 1.0));
}

fn sprite_stretch_offset(
  corner: vec2f,
  screen_velocity: vec2f,
  size: f32,
  ratio: f32,
  trail: f32,
) -> vec2f {
  let speed = length(screen_velocity);
  var axis = vec2f(1.0, 0.0);
  if (speed > 1e-5) {
    axis = screen_velocity / speed;
  }
  let side = vec2f(-axis.y, axis.x);
  let r = max(ratio, 1.0);
  let along = corner.x * r - clamp(trail, 0.0, 1.0) * (r - 1.0);
  return (axis * along + side * corner.y) * size;
}

fn sprite_pixel_clamp(size: f32, pixels_per_unit: f32, min_pixels: f32) -> vec2f {
  let pixels = size * pixels_per_unit;
  if (pixels >= min_pixels || pixels <= 0.0) {
    return vec2f(size, 1.0);
  }
  let k = pixels / min_pixels;
  return vec2f(min_pixels / pixels_per_unit, k * k);
}
