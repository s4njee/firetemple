// Ribbons (story 7.7): each live particle's history (record.wgsl) expanded into a triangle strip in
// the vertex stage. No vertex buffer: instance i is the i-th live particle, vertex v is corner v % 6
// of segment v / 6 between history points k and k + 1 (k = 0 is the newest). A segment past the
// particle's valid points collapses outside the clip volume. Adjacent segments share the offset of
// their common point (the averaged tangent's normal), so the strip has no gaps or overlaps at the
// joins, which additive blending would show as beads. Width and brightness taper with the age of
// the point; a ribbon thinner than `min_pixels` is drawn at that width and dimmed by the ratio, as
// the sprite renderer's pixel floor does.

#include "blackbody.wgsl"
#include "trail-ribbon.wgsl"

@group(0) @binding(0) var<uniform> rb: TrailRibbon;
@group(0) @binding(1) var<storage, read> lists: array<u32>;
@group(0) @binding(2) var<storage, read> attributes: array<vec4f>;
@group(0) @binding(3) var<storage, read> history: array<vec4f>;
@group(0) @binding(4) var<storage, read> heads: array<vec4u>;

struct RibbonVarying {
  @builtin(position) position: vec4f,
  // -1 .. 1 across the ribbon.
  @location(0) across: f32,
  @location(1) color: vec3f,
}

fn tr_point(slot: u32, head: u32, k: u32) -> vec4f {
  return history[slot * rb.points + (head + rb.points - k) % rb.points];
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> RibbonVarying {
  var out: RibbonVarying;
  out.position = vec4f(0.0, 0.0, 2.0, 1.0);
  out.across = 0.0;
  out.color = vec3f(0.0);
  let slot = lists[16u + rb.capacity * (1u + rb.list) + instance];
  let h = heads[slot];
  let n = h.y;
  let segment = vertex / 6u;
  let corner = vertex % 6u;
  if (segment + 1u >= n) {
    return out;
  }
  // Corners (point, side): (k,-) (k,+) (k+1,-) | (k+1,-) (k,+) (k+1,+)
  let far = corner == 2u || corner == 3u || corner == 5u;
  let side = select(-1.0, 1.0, corner == 1u || corner == 4u || corner == 5u);
  let k = segment + select(0u, 1u, far);
  let here = tr_point(slot, h.x, k);
  let newer = tr_point(slot, h.x, select(k - 1u, k, k == 0u));
  let older = tr_point(slot, h.x, min(k + 1u, n - 1u));
  var tangent = newer.xy - older.xy;
  let length_t = length(tangent);
  tangent = select(vec2f(1.0, 0.0), tangent / max(length_t, 1e-12), length_t > 1e-9);
  let normal = vec2f(-tangent.y, tangent.x);

  // Taper: 1 at the head to 0 past the last point the ribbon can hold.
  let age = f32(k) / f32(max(rb.points - 1u, 1u));
  let taper = 1.0 - age;
  let size = attributes[slot].y;
  var width = size * rb.width * mix(1.0, taper, rb.taper);
  var dim = 1.0;
  let floor_width = rb.min_pixels * rb.pixel;
  if (width < floor_width) {
    dim = width / floor_width;
    width = floor_width;
  }
  let world = here.xy + normal * (width * side);
  let clip = (world - rb.view.xy) / rb.view.zw;
  out.position = vec4f(clip, 0.5, 1.0);
  out.across = side;
  out.color = blackbody_radiance(here.z, rb.t_ref, rb.gamma) * (rb.intensity * dim * taper * taper);
  return out;
}

@fragment
fn fs(in: RibbonVarying) -> @location(0) vec4f {
  // The same Gaussian falloff across the ribbon as across a sprite (sprite_gaussian, sharpness 4).
  let profile = exp(-4.0 * in.across * in.across);
  return vec4f(in.color * profile, 0.0);
}
