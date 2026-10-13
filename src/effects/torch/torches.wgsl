// A grid of small flames in ONE canvas, each on a torch handle or in a brazier bowl.
//
// Every pixel belongs to at most one flame: it finds its cell with a floor, reads that flame's
// four numbers from the uniform array (flicker level, place in the loop, size, lean: all computed
// on the CPU once per frame) and then does the work of ONE flame. Nothing loops over the flames,
// so the cost of a pixel does not depend on how many there are.
//
// Two fetches of the shared noise tile inside a flame's reach, none outside it. The whole picture
// repeats exactly every `loop` seconds: time enters only as a phase in 0..1, and each noise layer
// travels a whole number of tiles per loop.
#include "fullscreen.wgsl"
#include "sdf.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "noisetex.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// Item space: x from the item's centre line, y up from its foot, one unit = the item's height.
const TORCH_WOOD = vec3f(0.075, 0.042, 0.02);
const TORCH_CHAR = vec3f(0.018, 0.014, 0.012);
const TORCH_IRON = vec3f(0.028, 0.028, 0.032);
const TORCH_WARM = vec3f(1.0, 0.45, 0.13);

fn torch_noise(p: vec2f) -> vec4f {
  // The level of detail comes from the CPU: a flame a few pixels tall must not read level 0.
  return textureSampleLevel(noise_tex, noise_smp, noisetex_uv(p), params.lod);
}

// Heat 0..1 of one flame at flame-space fq (origin at the base, height 1).
//   f: (level, place in the loop 0..1, size, lean -1..1)
fn torch_heat(fq: vec2f, f: vec4f, index: f32) -> f32 {
  var fp = flame_params(params.shape.x, 1.0);
  fp.turbulence = params.turbulence;
  fp.turbulence_curve = 1.4;
  fp.erosion = params.shape.z;
  fp.erosion_curve = 0.9;
  fp.core = 0.7;
  fp.hot = 0.16;
  fp.falloff = 0.36;
  fp.base_soft = params.shape.w;
  if (!flame_reach(fq, fp)) {
    return 0.0;
  }
  // Tighter than that box, for the teardrop: the sway moves a point sideways by at most
  // travel * t^curve and erosion only removes, so a point further than that from the bare
  // silhouette can never be lit. One distance evaluation saves two fetches on about a third of
  // the box (flameShare in index.ts counts it).
  let travel = fp.turbulence * fp.half_width;
  if (params.shape.y <= 0.0
    && flame_sd_teardrop(fq, fp.half_width, 1.0) > travel * flame_tip_weight(fq.y, fp.turbulence_curve)) {
    return 0.0;
  }
  let phase = fract(params.phase + f.y);
  // Each flame reads its own part of the tile.
  let own = params.variety * vec2f(index * 2.37, index * 1.13);
  // Sway: a slice through the tile that time moves along; a bend starts low and travels up.
  let bend = torch_noise(vec2f(
    params.cycles.x * NOISETEX_CELLS * phase - 1.3 * fq.y,
    0.35 * fq.x + 3.1,
  ) + own).rg * 2.0 - 1.0;
  let sway = clamp(2.4 * bend.x + 0.4 * f.w, -1.0, 1.0);
  // Tongues: read where the swayed flame is, rising, sheared by the sway layer.
  let s = flame_turbulence(fq, vec2f(sway, 0.0), travel, 1.0, fp.turbulence_curve);
  let e = torch_noise(vec2f(
    2.6 * s.x + 0.4 * bend.y,
    1.5 * s.y - params.cycles.y * NOISETEX_CELLS * phase,
  ) + own.yx);
  let erode = smoothstep(0.32, 0.68, 0.7 * e.r + 0.3 * e.b);
  if (params.shape.y > 0.0) {
    return flame_heat_taper(fq, vec2f(sway, erode), params.shape.y, fp);
  }
  return flame_heat_teardrop(fq, vec2f(sway, erode), fp);
}

// A torch: a tapered handle and a wrapped head. Returns premultiplied colour and coverage.
fn torch_handle(q: vec2f, level: f32, px: f32) -> vec4f {
  let stick = flame_sd_taper(q - vec2f(0.0, 0.03), 0.026, 0.042, 0.27) - 0.006;
  let head = sd_rounded_box_2d(q - vec2f(0.0, 0.33), vec2f(0.082, 0.062), 0.03);
  let d = min(stick, head);
  let cover = sd_coverage(d, px);
  if (cover <= 0.0) {
    return vec4f(0.0);
  }
  // Light falls from the flame above: the head is lit, the handle fades into the dark.
  let lit = level * exp(-max(0.395 - q.y, 0.0) / 0.11);
  let grain = 0.8 + 0.2 * sin(q.x * 190.0);
  var color = TORCH_WOOD * grain * (1.0 + 5.0 * lit);
  if (head < stick) {
    // Charred wrapping, with bands, glowing where the flame sits on it.
    let bands = 0.6 + 0.4 * sin(q.y * 150.0 + q.x * 40.0);
    color = TORCH_CHAR * bands * (1.0 + 6.0 * lit)
      + TORCH_WARM * (0.9 * level * exp(-max(0.39 - q.y, 0.0) / 0.022));
  }
  return vec4f(color * params.ambient, 1.0) * cover;
}

// A brazier: an iron bowl of coals on three legs. Returns premultiplied colour and coverage.
fn torch_bowl(q: vec2f, level: f32, px: f32) -> vec4f {
  let bowl = flame_sd_taper(q - vec2f(0.0, 0.2), 0.12, 0.24, 0.145) - 0.012;
  let rim = sd_rounded_box_2d(q - vec2f(0.0, 0.352), vec2f(0.268, 0.013), 0.01);
  let m = vec2f(abs(q.x), q.y);
  let leg = sd_segment_2d(m, vec2f(0.1, 0.2), vec2f(0.2, 0.02)) - 0.013;
  let brace = sd_segment_2d(m, vec2f(0.0, 0.095), vec2f(0.16, 0.095)) - 0.007;
  // The coals: a low lumpy mound heaped above the rim.
  let across = q.x / 0.225;
  let heap = q.y - (0.392 - 0.04 * across * across + 0.006 * sin(q.x * 95.0));
  let coals = max(max(heap, abs(q.x) - 0.225), 0.345 - q.y);
  let iron = min(min(bowl, rim), min(leg, brace));
  let cover = sd_coverage(min(iron, coals), px);
  if (cover <= 0.0) {
    return vec4f(0.0);
  }
  var color = vec3f(0.0);
  if (coals < iron) {
    // Dark lumps with fire showing between them, brightest under the flame.
    let lump = 0.5 + 0.5 * sin(q.x * 95.0 + 1.0) * sin(q.y * 140.0);
    color = TORCH_CHAR + TORCH_WARM * vec3f(1.0, 0.5, 0.25)
      * (level * (0.5 + 2.5 * lump) * (1.0 - 0.6 * across * across));
  } else {
    // Iron near the coals glows dull red; the rest takes a little warm light from above.
    let glow = exp(-max(0.365 - q.y, 0.0) / 0.045);
    let shade = 0.55 + 0.9 * saturate(0.5 - q.x * 1.6);
    color = TORCH_IRON * shade
      + TORCH_WARM * (level * (0.03 * exp(-max(0.36 - q.y, 0.0) / 0.2) + 0.3 * glow * glow));
  }
  return vec4f(color * params.ambient, 1.0) * cover;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Which cell. The last row may be short; it is centred.
  let g = in.uv * params.grid;
  let row = min(floor(g.y), params.grid.y - 1.0);
  let in_row = select(params.grid.x, params.last_row, row > params.grid.y - 1.5);
  let gx = g.x - 0.5 * (params.grid.x - in_row);
  let column = floor(gx);
  if (column < 0.0 || column >= in_row) {
    return vec4f(0.0);
  }
  let index = row * params.grid.x + column;
  let f = params.flames[i32(index)];
  let q = vec2f(
    (gx - column - 0.5) * params.cell.x,
    (row + 1.0 - g.y) * params.cell.y - params.foot,
  ) / params.unit;
  let px = params.pixel;

  // Flame: emission, no coverage.
  let fq = (q - vec2f(0.0, params.base.x)) / (params.base.y * f.z);
  let heat = torch_heat(fq, f, index);
  var flame = ramp_select(i32(params.kind), heat);
  if (params.kind < 0.5) {
    // The fire ramp's cool end is saturated red, and licks at the tip come and go several times a
    // second: exactly the red flash WCAG 2.3.1 singles out. A floor under green (0.3 of red, at
    // most 0.2 so the body does not turn yellow) makes the licks orange: displayed, a bright one
    // is about (1, 0.3, 0), a red share of 0.77, under the 0.8 that counts as saturated.
    flame.g = max(flame.g, min(0.3 * flame.r, 0.2));
  }
  var out = vec4f(flame * (params.intensity * f.x), 0.0);

  // Holder: opaque, in front of the flame's base.
  if (q.y < 0.5 && abs(q.x) < 0.3 && params.style < 1.5) {
    var holder = vec4f(0.0);
    if (params.style > 0.5) {
      holder = torch_bowl(q, f.x, px);
    } else {
      holder = torch_handle(q, f.x, px);
    }
    out = out * (1.0 - holder.a) + holder;
  }
  return out;
}
