// Stateless sparks: no buffers, no particle state. Every pixel asks, per depth layer, "which
// spark could be here now?" and gets the answer from two integer hashes.
//
// The frame is polar about a virtual origin `focal` behind the emitter, so one parameter runs
// from parallel lanes (a wide bed of embers) to a fan from a point (a welding arc):
//   lane   = the direction a spark leaves in (an angle, measured as arc length)
//   r      = how far along that direction the pixel is from the emitter
// A lane is a conveyor: it carries one slot every `slot_len` of travel, and each slot holds at
// most one spark. The conveyor's position is `rise`, the distance travelled so far, accumulated
// on the CPU, so the speed control never makes a spark jump. Lanes run at different speeds, which
// is what stops the layer moving as one sheet.
//
// Writes linear radiance with alpha 0: sparks are light and cover nothing.
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "sprite.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Lanes are measured as arc length at this distance from the emitter (canvas heights).
const SPK_REF: f32 = 0.5;
// A spark at this temperature has luminance `intensity`; hotter ones are brighter and paler.
const SPK_T_REF: f32 = 1800.0;
// Where a dying spark ends: the dullest red that still shows.
const SPK_T_COLD: f32 = 950.0;
// Size of the nearest layer relative to the page, and the ratio from one layer to the next.
const SPK_NEAR: f32 = 1.5;
const SPK_DEPTH_STEP: f32 = 0.68;
// A spark is never drawn thinner than this many pixels; it is dimmed instead (see below).
const SPK_MIN_PIXELS: f32 = 0.75;

// One depth layer. `travel` is how far the pixel is from the emitter along its ray and `theta`
// the ray's angle from the axis, both worked out once for all layers (see fs). Depth is a plain
// scale `z` about the emitter: a nearer layer is larger, faster and reaches further. `warp` is the
// shared turbulence value for this layer, in [-1, 1].
fn spk_layer(travel: f32, theta: f32, layer: u32, z: f32, warp: f32) -> vec3f {
  let r = travel / z;
  // Further than any spark of this layer lives: nothing to look up.
  if (r >= params.reach + 3.0 * params.size) {
    return vec3f(0.0);
  }
  let d = params.focal / z;

  // Lane coordinate, and how wide one unit of it is on screen at this distance.
  let reference = d + SPK_REF;
  let widen = (d + r) / reference;
  // Turbulence bends every lane the same way at the same place, so sparks follow the air instead
  // of each wobbling alone, and a streak lies along its own path. Nothing at the emitter.
  let sideways = params.turbulence * warp * r / (1.0 + 1.5 * r);
  let lane = (theta * reference + sideways / max(widen, 0.05)) / params.lane_width;
  let lane_index = floor(lane);
  let across = lane - lane_index;
  // One small hash per lane and one per slot, each cut into 16-bit or 8-bit numbers: a spark
  // needs many random numbers but none of them precisely.
  let lane_bits = pcg_1d(bitcast<u32>(i32(lane_index)) ^ ((layer + 4u * params.seed) * 0x9e3779b9u));
  let lane_hash = vec2f(vec2u(lane_bits & 0xffffu, lane_bits >> 16u)) / 65536.0;

  // The lane's speed, rounded so that it carries a whole number of slots per wrap of `rise`:
  // the CPU wraps `rise` to keep f32 precise, and with a whole number the wrap is seamless.
  let slots = max(round((0.6 + 0.8 * lane_hash.x) * params.wrap_slots), 1.0);
  let speed = slots / params.wrap_slots;
  let slot = (params.rise * speed - r) / params.slot_len + lane_hash.y;
  let slot_index = floor(slot);
  let along = slot - slot_index; // 0 at the leading end of the slot, 1 at the trailing end
  let wrapped = slot_index - slots * floor(slot_index / slots);
  let bits = pcg_1d(lane_bits + u32(wrapped) * 0x85ebca6bu);
  let lo = vec4f((vec4u(bits) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(0xffu)) / 256.0;
  if (lo.x >= params.fill) {
    return vec3f(0.0); // an empty slot
  }

  // Size. A spark thinner than a pixel would flicker as it crosses pixel centres, so it is drawn
  // at a minimum width and dimmed by the area it gained.
  let pixel = params.pixel / z;
  let size = params.size * (0.55 + 0.9 * lo.y * lo.y);
  let width = max(size, SPK_MIN_PIXELS * pixel);
  let streak = params.streak * speed;
  let length_total = streak + 2.0 * width;

  // Where the head sits in its slot, and how far behind the head this pixel is.
  let head_lo = width / params.slot_len;
  let head_hi = max(1.0 - (streak + width) / params.slot_len, head_lo);
  let behind = (along - mix(head_lo, head_hi, lo.z)) * params.slot_len;
  if (behind <= -width || behind >= streak + width) {
    return vec3f(0.0);
  }

  // Age is distance travelled over the distance this spark will live for.
  let travelled = r + behind;
  let age = travelled / (params.reach * (0.3 + 0.7 * lo.w));
  if (age >= 1.0 || travelled <= 0.0) {
    return vec3f(0.0);
  }

  // The rest of the spark's numbers, only now that the pixel is known to be level with it.
  let more = pcg_1d(bits ^ 0x27d4eb2fu);
  let hi = vec4f((vec4u(more) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(0xffu)) / 256.0;

  // Sideways position: anywhere in the lane that keeps the whole spark inside it. Near a point
  // source the lanes are narrower than a spark, and the lane edge clips it to a sliver.
  let lane_size = params.lane_width * widen;
  let margin = min(width / lane_size, 0.5);
  let centre = 0.5 + (hi.x - 0.5) * (1.0 - 2.0 * margin);
  let local = vec2f(
    1.0 - 2.0 * (behind + width) / length_total,
    (across - centre) * lane_size / width,
  );
  // The head is round when it is as long as the spark is wide.
  let shape = sprite_streak(local, 1.0 - 2.0 * width / length_total, 1.0);
  if (shape <= 0.0) {
    return vec3f(0.0);
  }

  // Cooling: hot for most of its life, then quickly down through orange to dull red.
  let hot = params.temperature * (0.82 + 0.18 * hi.y);
  let temperature = mix(hot, SPK_T_COLD, age * sqrt(age));
  let twinkle = 1.0 - 0.35 * (0.5 + 0.5 * sin(params.time * (9.0 + 14.0 * hi.z) + TAU * hi.w));
  let fade = (1.0 - age * age) * smoothstep(0.0, 0.03, travelled) * twinkle;
  let kept = (size * (streak + 2.0 * size)) / (width * length_total);
  let level = params.intensity * shape * fade * kept * mix(1.0, sqrt(z / SPK_NEAR), 0.6);
  return blackbody_radiance(temperature, SPK_T_REF, BLACKBODY_GAMMA) * level;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Canvas heights, y up, x from the centre.
  let page = vec2f((in.uv.x - 0.5) * params.aspect, 1.0 - in.uv.y);
  let p = page - params.origin;
  // The fan's frame: rotated so that its axis is +y. Gravity's direction in that frame is `down`.
  let q = vec2f(p.x * params.axis.y - p.y * params.axis.x, p.x * params.axis.x + p.y * params.axis.y);
  let down = vec2f(params.axis.x, -params.axis.y);
  let d = params.focal;

  // Distance travelled, once for every layer. Gravity is undone first: a spark that has gone r
  // has dropped droop * r^2, so the pixel is lifted by that much before it is asked which straight
  // ray it lies on. r is on both sides; two rounds of substitution are enough for the droops the
  // controls allow.
  var straight = q;
  var travel = length(vec2f(q.x, q.y + d)) - d;
  if (params.droop > 0.0) {
    for (var i = 0; i < 2; i++) {
      straight = q - down * (params.droop * travel * travel);
      travel = length(vec2f(straight.x, straight.y + d)) - d;
    }
  }
  let theta = atan2(straight.x, straight.y + d);

  var color = vec3f(0.0);
  // Behind the emitter or outside the fan there is nothing in any layer.
  if (travel > 0.0 && abs(theta) < params.spread) {
    // One fetch of slowly drifting noise bends every layer (each reads its own mix of the fields).
    let field = noisetex_sample(noise_tex, noise_smp, page * 2.2 + params.drift) * 2.0 - 1.0;
    let warps = vec4f(field.r, field.g, -field.r, -field.g) * 2.2;
    var z = SPK_NEAR;
    for (var layer = 0u; layer < params.layers; layer++) {
      color += spk_layer(travel, theta, layer, z, warps[layer]);
      z *= SPK_DEPTH_STEP;
    }
    // A bright spark is yellow-white, not the lemon yellow a per-channel tonemap makes of it.
    color = ramp_whiten(color, 5.0);
    // Nothing reaches the top edge, so the canvas rectangle never shows.
    color *= smoothstep(0.99, 0.86, page.y);
  }

  // The arc itself: a small blue-white point at the emitter, for the welding look.
  if (params.glow > 0.0) {
    let dist = length(p) / (0.012 + 0.6 * params.size);
    color += vec3f(0.75, 0.88, 1.0) * (params.glow * 40.0 * exp(-dist * dist));
  }
  return vec4f(color, 0.0);
}
