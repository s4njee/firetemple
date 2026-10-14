// Ribbon history (story 7.7): after every particle step, each live particle writes its position
// into its own ring buffer of `points` entries. trails.ts dispatches this indirectly over the live
// count the system's finish kernel wrote, so it costs in proportion to the live particles.
//
// Per slot:
//   heads[slot]    (head, count, seed, step): the newest entry, how many are valid, which particle
//                  wrote them (its seed), and the record step that wrote the newest
//   history[slot * points + k]   (x, y, temperature, age)
// A slot whose seed changed holds a NEW particle (the pool recycled it), and one that missed a
// record step has a gap: both start a fresh ribbon instead of joining the old path.

#include "trail-record.wgsl"

@group(0) @binding(0) var<uniform> rec: TrailRecord;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> attributes: array<vec4f>;
// The particle system's lists buffer, read as plain words: 16 counters, the dead stack, two alive lists.
@group(0) @binding(3) var<storage, read> lists: array<u32>;
@group(0) @binding(4) var<storage, read_write> history: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> heads: array<vec4u>;

@compute @workgroup_size(64)
fn record(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= lists[rec.list]) {
    return;
  }
  let slot = lists[16u + rec.capacity * (1u + rec.list) + i];
  let position = positions[slot];
  let attrs = attributes[slot];
  let seed = bitcast<u32>(attrs.z);
  var h = heads[slot];
  if (h.y == 0u || h.z != seed || h.w + 1u != rec.step) {
    // Born since the last record (or the ribbon was off): start a fresh ribbon here.
    h.x = 0u;
    h.y = 1u;
  } else {
    h.x = (h.x + 1u) % rec.points;
    h.y = min(h.y + 1u, rec.points);
  }
  h.z = seed;
  h.w = rec.step;
  history[slot * rec.points + h.x] = vec4f(position.xy, attrs.x, position.w);
  heads[slot] = h;
}
