// A fireplace in one pass: a brick wall and a stone floor lit by the fire, three layers of flame,
// a mound of coals, three charred logs in front of them, and a few embers rising over it all.
// No state: everything is a function of position, two accumulated distances and the clock.
//
// Where the cost goes (per pixel): the room is arithmetic and one hash; a flame layer is two
// fetches of the shared noise tile, and only inside the box that layer can reach; a log is one
// fetch, only on the log; the embers are two small hashes per layer in the column above the fire.
// A pixel that a log covers completely skips the room and the flames behind it.
//
// Fire space: origin on the floor under the middle of the fire, y up, one unit = the canvas
// height (less on a narrow canvas, which zooms out so the fire still fits).
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "sdf.wgsl"
#include "noisetex.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "sprite.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Where the wall meets the floor, and the horizon the floor's joints run towards.
const FP_JOIN: f32 = 0.055;
const FP_HORIZON: f32 = 0.6;
// Half width of a flame layer, in its own units.
const FP_HALF_WIDTH: f32 = 0.34;
// The size of one tongue: what erosion and the hot core are measured in.
const FP_TONGUE: f32 = 0.1;
// Embers: lane width, slot length and streak length, in fire-space units of their layer.
const FP_LANE: f32 = 0.05;
const FP_SLOT: f32 = 0.125;
const FP_STREAK: f32 = 0.01;

// ---- The room -----------------------------------------------------------------------------------

// The wall and the floor as the fire lights them. `warm` is the colour and level of the light.
fn fp_room(f: vec2f, warm: vec3f) -> vec3f {
  if (f.y >= FP_JOIN) {
    // Brick courses, every other one shifted by half a brick.
    let course = floor(f.y / 0.072);
    let along = f.x / 0.168 + 0.5 * (course - 2.0 * floor(0.5 * course));
    let cell = vec2f(fract(along), fract(f.y / 0.072));
    let edge = min(min(cell.x, 1.0 - cell.x) * 0.168, min(cell.y, 1.0 - cell.y) * 0.072);
    let mortar = smoothstep(0.0, 0.006, edge);
    let tone = 0.8 + 0.2 * ihash_2to1(vec2i(i32(floor(along)), i32(course)));
    // The light comes from the heart of the fire, a little above the floor.
    let to_fire = (f - vec2f(0.0, 0.17)) * vec2f(1.0, 1.2);
    let reach = 1.0 / (1.0 + 16.0 * dot(to_fire, to_fire));
    return warm * (0.4 * reach * tone * mix(0.62, 1.0, mortar)) + vec3f(0.0035, 0.003, 0.003);
  }
  // The floor, in perspective: depth is 1 / (distance below the horizon).
  let depth = 1.0 / (FP_HORIZON - f.y);
  let tile = vec2f(fract(f.x * depth / 0.5 + 0.5), fract(depth / 0.28));
  let edge = min(min(tile.x, 1.0 - tile.x) * 0.5, min(tile.y, 1.0 - tile.y) * 0.28);
  let joint = smoothstep(0.0, 0.012, edge);
  let toward = FP_JOIN - f.y; // how far in front of the wall, on screen
  let pool = 1.0 / (1.0 + f.x * f.x / 0.12 + toward * toward / 0.012);
  let sheen = 1.0 / (1.0 + f.x * f.x / 0.03 + toward * toward / 0.08);
  return warm * ((0.3 * pool + 0.08 * sheen) * mix(0.65, 1.0, joint)) + vec3f(0.003);
}

// ---- Flames -------------------------------------------------------------------------------------

// Heat (0..1) of one flame layer at fire-space point f. Layer 0 is the back: larger, slower.
fn fp_flame(f: vec2f, layer: i32) -> f32 {
  let k = f32(layer);
  let scale = 1.28 - 0.25 * k;
  let seed = 3.1 * k;
  let q = (f - vec2f(0.045 * sin(k * 2.4 + 1.0), 0.03 + 0.012 * k)) / scale;
  let height = params.flame_height;
  if (q.y <= 0.0 || q.y >= height || abs(q.x) >= FP_HALF_WIDTH * 1.3) {
    return 0.0;
  }
  // Speeds are multiples of 1/8 so the CPU can wrap `rise` without a seam (see index.ts).
  let rise = params.rise * (0.75 + 0.25 * k);

  // Slow field: the layer leans, more the higher up.
  let slow = noisetex_fbm2(
    noise_tex,
    noise_smp,
    vec2f(q.x * 1.2 + seed, q.y * 0.8 - 0.5 * rise),
  );
  let x = q.x + 0.13 * slow.x * flame_tip_weight(q.y / height, 1.4);

  // The top of the fire: a bank that is tallest in the middle, cut into tongues that wander.
  let bank = pow(max(1.0 - (x * x) / (FP_HALF_WIDTH * FP_HALF_WIDTH), 0.0), 0.9);
  let tongues = 0.74 +
    0.15 * sin(x * 11.0 + params.time * 1.3 + seed) +
    0.11 * sin(x * 23.0 - params.time * 2.1 + 2.3 * seed);
  let top = height * bank * tongues;
  if (q.y >= top) {
    return 0.0;
  }
  let t = q.y / top;

  // Fast field: rising noise that eats the surface into licks, stretched upward.
  let fast = noisetex_sample(
    noise_tex,
    noise_smp,
    vec2f(x * 6.0 + 1.7 * seed, q.y * 2.1 - rise) + 0.45 * slow,
  );
  let erosion = clamp(0.5 + 2.8 * (fast.r - 0.5) + 1.1 * (fast.b - 0.5), 0.0, 1.0);

  var shape = flame_params(FP_TONGUE, 1.0);
  shape.erosion = 2.6;
  shape.erosion_curve = 0.9;
  shape.core = 0.9;
  shape.hot = 0.15;
  shape.falloff = 0.5;
  shape.base_soft = 0.2;
  // Distance to the surface, roughly: tongues are steep, so the way out is mostly sideways, and
  // at the ends of the bank it is the end itself.
  let d = max((q.y - top) * 0.5, 0.8 * (abs(x) - FP_HALF_WIDTH));
  // The same noise thins the inside of the flame, so the body is not one flat sheet.
  // The foot fades out, so a layer that is wider than the logs does not end on a line.
  return flame_heat_from_sd(d, t, erosion, shape) * (1.0 - 0.4 * erosion * t) *
    smoothstep(0.0, 0.05, q.y);
}

// ---- Logs and coals -----------------------------------------------------------------------------

// A log is a capsule from a to b. Returns (signed distance, distance along it, position across
// it from -1 on the underside to 1 on top).
fn fp_log(p: vec2f, a: vec2f, b: vec2f, radius: f32) -> vec3f {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  let offset = pa - ba * h;
  let dist = length(offset);
  let side = sign(ba.x * offset.y - ba.y * offset.x);
  return vec3f(dist - radius, h * length(ba), side * dist / radius);
}

// Charred bark with a glowing underside. One fetch.
fn fp_log_color(hit: vec3f, seed: f32, warm: vec3f) -> vec3f {
  let across = hit.z;
  // Stretched along the log, like grain.
  let grain = noisetex_sample(
    noise_tex,
    noise_smp,
    vec2f(hit.y * 7.0 + seed, across * 1.3 + 3.1 * seed),
  );
  // Char splits into blocks; the splits are where the fine field crosses its middle.
  let split = 1.0 - abs(2.0 * grain.b - 1.0);
  let cracks = split * split * split;
  // The underside sits in the fire and glows; each stretch breathes slowly on its own.
  let under = smoothstep(0.15, -1.0, across);
  let breathe = 0.82 + 0.18 * sin(params.time * 0.9 + 5.0 * seed + 6.0 * hit.y);
  let heat = under * (0.25 + 0.75 * cracks) * (0.5 + grain.r) * breathe * params.coals;
  let ember = ramp_fire(min(0.66 * heat, 0.74));
  // The top edge catches a little of the flames behind it.
  let rim = smoothstep(0.5, 1.0, across) * 0.07;
  let bark = vec3f(0.011, 0.009, 0.008) * (0.5 + grain.g) * (1.0 - 0.6 * cracks);
  return bark + warm * rim + ember;
}

// The mound of coals the logs lie on: rgb radiance, a coverage.
fn fp_coals(f: vec2f, px: f32) -> vec4f {
  let across = f.x / 0.45;
  let mound = 0.058 * max(1.0 - across * across, 0.0);
  if (abs(across) >= 1.0 || f.y > mound * 1.3 + 0.004 || f.y < -0.03) {
    return vec4f(0.0);
  }
  let lumps = noisetex_sample(noise_tex, noise_smp, vec2f(f.x * 6.0 + 2.7, f.y * 9.0));
  let top = mound * (0.7 + 0.6 * lumps.g);
  // Spills forward onto the floor a little, as a heap seen from in front does.
  let spill = 0.03 * (1.0 - across * across) * (0.4 + 0.6 * lumps.b);
  let cover = sd_coverage(f.y - top, px) * smoothstep(-spill, 0.2 * spill, f.y) *
    smoothstep(1.0, 0.6, abs(across));
  // Hot at the heart of the heap, darker lumps on its surface; each patch breathes on its own.
  let breathe = 0.85 + 0.15 * sin(params.time * 0.7 + 9.0 * lumps.g);
  let heart = 1.0 - 0.45 * across * across;
  let heat = (0.25 + 0.75 * lumps.r) * heart * breathe * params.coals;
  let ash = vec3f(0.02, 0.017, 0.015) * lumps.b;
  return vec4f(ramp_fire(min(0.78 * heat, 0.8)) + ash, cover);
}

// ---- Embers -------------------------------------------------------------------------------------

// Sparks leaving the fire: the hash grid of the `sparks` effect in its simplest form. Lanes are
// vertical, each carries slots upward at its own speed, a slot holds at most one ember.
fn fp_embers(f: vec2f, layer: u32) -> vec3f {
  let z = select(1.0, 0.6, layer == 1u);
  let q = vec2f(f.x, f.y - 0.09) / z;
  let reach = params.ember_reach;
  if (q.y <= 0.0 || q.y >= reach || abs(q.x) >= 0.3 + 0.4 * q.y) {
    return vec3f(0.0);
  }
  // The column of hot air sways, and takes every ember with it.
  let sway = 0.05 * sin(q.y * 6.0 - params.time * 0.9 + 2.0 * f32(layer)) * q.y / (0.25 + q.y);
  let lane = (q.x + sway) / FP_LANE;
  let lane_index = floor(lane);
  let lane_bits = pcg_1d(bitcast<u32>(i32(lane_index)) ^ ((layer + 11u) * 0x9e3779b9u));
  let lane_hash = vec2f(vec2u(lane_bits & 0xffffu, lane_bits >> 16u)) / 65536.0;
  // A whole number of slots per wrap of the distance, so the wrap is seamless.
  let slots = max(round((0.6 + 0.8 * lane_hash.x) * params.ember_wrap), 1.0);
  let speed = slots / params.ember_wrap;
  let slot = (params.ember_rise * speed - q.y) / FP_SLOT + lane_hash.y;
  let slot_index = floor(slot);
  let wrapped = slot_index - slots * floor(slot_index / slots);
  // One small hash per slot, cut into four 8-bit numbers; a second only for a pixel on an ember.
  let bits = pcg_1d(lane_bits + u32(wrapped) * 0x85ebca6bu);
  let lo = vec4f((vec4u(bits) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(0xffu)) / 256.0;
  if (lo.x >= params.ember_fill) {
    return vec3f(0.0);
  }
  let pixel = params.pixel / z;
  let size = 0.0032 * (0.5 + lo.y);
  let width = max(size, 0.75 * pixel);
  let total = FP_STREAK + 2.0 * width;
  let head_lo = width / FP_SLOT;
  let head_hi = 1.0 - (FP_STREAK + width) / FP_SLOT;
  let behind = (slot - slot_index - mix(head_lo, head_hi, lo.z)) * FP_SLOT;
  let travelled = q.y + behind;
  let age = travelled / (reach * (0.3 + 0.7 * lo.w));
  if (behind <= -width || behind >= FP_STREAK + width || age >= 1.0 || travelled <= 0.0) {
    return vec3f(0.0);
  }
  let more = pcg_1d(bits ^ 0x27d4eb2fu);
  let hi = vec4f((vec4u(more) >> vec4u(0u, 8u, 16u, 24u)) & vec4u(0xffu)) / 256.0;
  let margin = width / FP_LANE;
  let centre = 0.5 + (hi.x - 0.5) * (1.0 - 2.0 * margin);
  let local = vec2f(1.0 - 2.0 * (behind + width) / total, (lane - lane_index - centre) * FP_LANE / width);
  let shape = sprite_streak(local, 1.0 - 2.0 * width / total, 1.0);
  if (shape <= 0.0) {
    return vec3f(0.0);
  }
  let twinkle = 1.0 - 0.3 * (0.5 + 0.5 * sin(params.time * (9.0 + 14.0 * hi.z) + TAU * hi.w));
  let fade = (1.0 - age * age) * smoothstep(0.0, 0.05, travelled) * twinkle;
  let kept = (size * (FP_STREAK + 2.0 * size)) / (width * total);
  let temperature = mix(1750.0, 950.0, age * sqrt(age));
  return blackbody_radiance(temperature, 1800.0, BLACKBODY_GAMMA) * (9.0 * shape * fade * kept * z);
}

// ---- The picture --------------------------------------------------------------------------------

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = vec2f((in.uv.x - 0.5) * params.aspect, 1.0 - in.uv.y) / params.fit;
  let f = vec2f(p.x, p.y - params.ground);
  let px = params.pixel / params.fit;
  let warm = params.warm;

  // Three logs: one across the back, one leaning over it, one in front. Outside the box that
  // holds all three there is no need to measure them.
  var back = vec3f(1.0, 0.0, 0.0);
  var lean = back;
  var front = back;
  if (abs(f.x) < 0.45 && f.y > -0.02 && f.y < 0.25) {
    back = fp_log(f, vec2f(-0.3, 0.13), vec2f(0.37, 0.052), 0.04);
    lean = fp_log(f, vec2f(-0.21, 0.07), vec2f(0.16, 0.2), 0.034);
    front = fp_log(f, vec2f(-0.38, 0.045), vec2f(0.3, 0.092), 0.047);
  }
  let cover_back = sd_coverage(back.x, px);
  let cover_lean = sd_coverage(lean.x, px);
  let cover_front = sd_coverage(front.x, px);

  // Back to front. The nearest flame layer burns in front of the two rear logs, which is what
  // puts the logs in the fire instead of in front of a picture of one. A pixel the front log
  // covers completely needs none of it.
  var color = vec3f(0.0);
  if (cover_front < 1.0) {
    if (max(cover_back, cover_lean) < 1.0) {
      color = fp_room(f, warm);
      var fire = vec3f(0.0);
      let far = fp_flame(f, 0);
      if (far > 0.0) {
        fire += ramp_fire(0.85 * far) * 0.4;
      }
      let middle = fp_flame(f, 1);
      if (middle > 0.0) {
        fire += ramp_fire(0.92 * middle) * 0.65;
      }
      color += fire * params.intensity;
      let coals = fp_coals(f, px);
      color = mix(color, coals.rgb, coals.a);
    }
    if (cover_back > 0.0) {
      color = mix(color, fp_log_color(back, 1.0, warm), cover_back);
    }
    if (cover_lean > 0.0) {
      color = mix(color, fp_log_color(lean, 2.0, warm), cover_lean);
    }
    let near = fp_flame(f, 2);
    if (near > 0.0) {
      color += ramp_fire(0.95 * near) * (0.75 * params.intensity);
    }
  }
  if (cover_front > 0.0) {
    color = mix(color, fp_log_color(front, 3.0, warm), cover_front);
  }

  // Embers pass in front of everything.
  if (params.ember_fill > 0.0) {
    color += fp_embers(f, 0u) + fp_embers(f, 1u);
  }

  // The corners of the room fall into the dark.
  let corner = (in.uv - 0.5) * vec2f(1.0, 0.9);
  color *= 1.0 - 0.55 * smoothstep(0.25, 0.75, length(corner));
  return vec4f(color, 1.0);
}
