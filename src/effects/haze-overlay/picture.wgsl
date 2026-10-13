#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "sdf.wgsl"
#include "picture-params.wgsl"

// The stand-in pictures: what the haze is shown over until the visitor drops a photo or a video
// on the canvas (the repository ships no image files). Drawn ONCE into an sRGB texture at canvas
// size, and again only on a resize or a change of picture, so nothing here is on the per-frame
// budget. Each one is built from straight lines (a road to a vanishing point, poles and wires,
// window grids, a test chart) because straight lines are what make a shimmer easy to judge.
//
// Output is ordinary picture colour, linear, at or below 1.0.
//
// Coordinates: p = uv * (aspect, 1), y DOWN, one unit = the picture height. Things the presets
// aim at are placed in uv, so they stay put when the aspect changes:
//   desert road   the horizon is at PIC_HORIZON from the top (0.44 above the bottom edge)
//   city          the top of the vent stack is at uv (PIC_STACK_X, PIC_STACK_TOP)

@group(0) @binding(0) var<uniform> picture: PictureParams;

const PIC_HORIZON: f32 = 0.56;
const PIC_STACK_X: f32 = 0.3;
const PIC_STACK_TOP: f32 = 0.7;

fn pic_fill(d: f32, px: f32) -> f32 {
  return sd_coverage(d, px);
}

// A line of the given width, never thinner than a pixel.
fn pic_line(p: vec2f, a: vec2f, b: vec2f, width: f32, px: f32) -> f32 {
  return sd_coverage(sd_segment_2d(p, a, b) - 0.5 * max(width, px), px);
}

// ---- Desert road --------------------------------------------------------------------------------

fn pic_road(p: vec2f, aspect: f32, px: f32) -> vec3f {
  let horizon = PIC_HORIZON;
  let vanish = vec2f(0.5 * aspect, horizon);

  // Sky: deep blue overhead, bleached toward the horizon.
  let up = clamp((horizon - p.y) / horizon, 0.0, 1.0);
  var color = mix(vec3f(0.78, 0.66, 0.46), vec3f(0.07, 0.2, 0.55), pow(up, 0.55));

  // Mesas on the horizon: flat tops and vertical sides.
  let block = floor(p.x * 5.0 + 0.3);
  let tall = ihash_2to1(vec2i(i32(block), 3));
  let within = abs(fract(p.x * 5.0 + 0.3) - 0.5);
  let mesa_top = horizon - select(0.012, 0.03 + 0.07 * tall, tall > 0.45);
  // The sides lean in a little toward the top.
  let lean = 0.6 * (horizon - p.y);
  let mesa = pic_fill(max(mesa_top - p.y, (within - 0.5 + 0.08 * tall) / 5.0 + lean), px);
  color = mix(color, vec3f(0.33, 0.15, 0.1), mesa * step(p.y, horizon));

  if (p.y > horizon) {
    // 0 at the horizon, 1 at the bottom edge; everything on the ground scales with it.
    let near = (p.y - horizon) / (1.0 - horizon);
    let depth = 1.0 / max(near, 1e-3);
    var ground = mix(vec3f(0.66, 0.44, 0.24), vec3f(0.36, 0.17, 0.07), sqrt(near));
    // Scrub: dark flecks that shrink with distance.
    let fleck = ihash_2to1(vec2i(floor(vec2f((p.x - vanish.x) * depth * 30.0, depth * 24.0))));
    ground *= 1.0 - 0.3 * step(0.9, fleck) * sqrt(near);

    // The road: its edges are straight lines to the vanishing point.
    let half = 0.34 * aspect * near;
    let across = (p.x - vanish.x) / max(half, 1e-4);
    let road_px = px / max(half, 1e-4);
    let tarmac = mix(vec3f(0.26, 0.22, 0.2), vec3f(0.028, 0.028, 0.034), sqrt(near));
    ground = mix(ground, tarmac, pic_fill(abs(across) - 1.0, road_px));
    let edge = pic_fill(abs(abs(across) - 0.88) - 0.025, road_px);
    ground = mix(ground, vec3f(0.80, 0.78, 0.72), edge);
    // Centre dashes, evenly spaced along the road, so they crowd together toward the horizon.
    let dash = step(fract(depth * 0.9), 0.5);
    ground = mix(ground, vec3f(0.85, 0.62, 0.10), dash * pic_fill(abs(across) - 0.03, road_px));
    color = ground;
  }

  // Telegraph poles down the right-hand side, each 0.62 times the size of the one before, and the
  // wire along their tops.
  var scale = 0.86;
  var top_first = vec2f(0.0);
  var top_last = vec2f(0.0);
  for (var i = 0; i < 7; i++) {
    let drop = (1.0 - horizon) * scale;
    let foot = vec2f(vanish.x + 0.56 * aspect * scale, horizon + drop);
    let top = foot - vec2f(0.0, 2.1 * drop);
    let wood = vec3f(0.035, 0.022, 0.014);
    color = mix(color, wood, pic_line(p, foot, top, 0.03 * drop, px));
    let arm = top + vec2f(0.0, 0.12 * drop);
    let reach = vec2f(0.2 * drop, 0.0);
    color = mix(color, wood, pic_line(p, arm - reach, arm + reach, 0.022 * drop, px));
    if (i == 0) {
      top_first = arm - reach;
    }
    top_last = arm - reach;
    scale *= 0.62;
  }
  color = mix(color, vec3f(0.02, 0.018, 0.015), 0.8 * pic_line(p, top_first, top_last, 0.0, px));

  // A sign on the left verge.
  let drop = (1.0 - horizon) * 0.42;
  let post = vec2f(vanish.x - 0.47 * aspect * 0.42, horizon + drop);
  let head = post - vec2f(0.0, 1.25 * drop);
  color = mix(color, vec3f(0.1, 0.1, 0.11), pic_line(p, post, head, 0.03 * drop, px));
  let plate = sd_box_2d(p - head, vec2f(0.2, 0.26) * drop);
  color = mix(color, vec3f(0.06, 0.06, 0.07), pic_fill(plate, px));
  color = mix(color, vec3f(0.86, 0.84, 0.78), pic_fill(plate + 0.035 * drop, px));
  let bar = sd_box_2d(p - head, vec2f(0.1, 0.035) * drop);
  return mix(color, vec3f(0.06, 0.06, 0.07), pic_fill(bar, px));
}

// ---- City at dusk -------------------------------------------------------------------------------

// One row of buildings: `width` is a building's width, `floor_y` where the row stands, `rise` how
// tall it can be. Returns the lit-window colour in rgb and the row's coverage in a.
fn pic_buildings(p: vec2f, width: f32, floor_y: f32, rise: f32, seed: i32, px: f32) -> vec4f {
  let column = floor(p.x / width);
  let h = ihash_2to2(vec2i(i32(column), seed));
  let top = floor_y - rise * (0.25 + 0.75 * h.x);
  let local = vec2f(fract(p.x / width) - 0.5, p.y - top);
  let wall = max(abs(local.x) - (0.5 - 0.06 * h.y), -local.y / width);
  let cover = pic_fill(wall * width, px);
  // Windows: a regular grid, some of them lit.
  let pane = vec2f(width / 5.0, width / 3.2);
  let cell = floor(vec2f(local.x * width, local.y) / pane);
  let inside = abs(fract(vec2f(local.x * width, local.y) / pane) - 0.5);
  let glass = step(inside.x, 0.3) * step(inside.y, 0.28) * step(0.5, local.y / pane.y);
  let on = step(0.58, ihash_3to1(vec3i(vec2i(cell), i32(column) * 7 + seed)));
  return vec4f(vec3f(0.95, 0.70, 0.36) * glass * on, cover);
}

fn pic_city(p: vec2f, aspect: f32, px: f32) -> vec3f {
  // Dusk: orange at the skyline, deep blue overhead.
  let up = clamp(1.0 - p.y / 0.8, 0.0, 1.0);
  var color = mix(vec3f(0.95, 0.4, 0.1), vec3f(0.42, 0.1, 0.2), smoothstep(0.0, 0.45, up));
  color = mix(color, vec3f(0.015, 0.03, 0.13), smoothstep(0.3, 1.0, up));
  color = mix(color, vec3f(1.0, 0.72, 0.36), 0.6 * exp(-up * 10.0));

  // Three rows, far to near: paler and bluer with distance, windows only close up.
  let far = pic_buildings(p + vec2f(0.37, 0.0), 0.085, 0.8, 0.26, 5, px);
  color = mix(color, vec3f(0.30, 0.20, 0.26), far.a);
  let mid = pic_buildings(p + vec2f(0.11, 0.0), 0.12, 0.84, 0.36, 11, px);
  color = mix(color, vec3f(0.11, 0.085, 0.14) + 0.35 * mid.rgb, mid.a);
  let near = pic_buildings(p, 0.17, 0.9, 0.42, 23, px);
  color = mix(color, vec3f(0.035, 0.03, 0.055) + near.rgb, near.a);

  // The roof we are standing on, with a parapet line, a vent stack and an aerial.
  let roof = vec3f(0.018, 0.017, 0.026);
  color = mix(color, roof, pic_fill(0.86 - p.y, px));
  color = mix(color, vec3f(0.11, 0.1, 0.12), pic_line(p, vec2f(0.0, 0.862), vec2f(aspect, 0.862), 0.004, px));
  let stack_x = PIC_STACK_X * aspect;
  let stack = sd_box_2d(p - vec2f(stack_x, 0.5 * (0.86 + PIC_STACK_TOP)), vec2f(0.022, 0.5 * (0.86 - PIC_STACK_TOP)));
  color = mix(color, vec3f(0.07, 0.065, 0.075), pic_fill(stack, px));
  let cap = sd_box_2d(p - vec2f(stack_x, PIC_STACK_TOP + 0.006), vec2f(0.032, 0.006));
  color = mix(color, vec3f(0.14, 0.12, 0.12), pic_fill(cap, px));
  // The aerial: a mast, two cross-pieces and two guy wires.
  let mast = vec2f(0.38 * aspect, 0.86);
  let tip = mast - vec2f(0.0, 0.5);
  let metal = vec3f(0.02, 0.02, 0.03);
  color = mix(color, metal, pic_line(p, mast, tip, 0.005, px));
  color = mix(color, metal, pic_line(p, tip + vec2f(-0.04, 0.05), tip + vec2f(0.04, 0.05), 0.003, px));
  color = mix(color, metal, pic_line(p, tip + vec2f(-0.03, 0.1), tip + vec2f(0.03, 0.1), 0.003, px));
  color = mix(color, metal, 0.8 * pic_line(p, tip + vec2f(0.0, 0.16), mast + vec2f(-0.16, 0.0), 0.0, px));
  color = mix(color, metal, 0.8 * pic_line(p, tip + vec2f(0.0, 0.16), mast + vec2f(0.16, 0.0), 0.0, px));
  return color;
}

// ---- Test grid ----------------------------------------------------------------------------------

fn pic_grid_lines(p: vec2f, cell: f32, width: f32, px: f32) -> f32 {
  let d = abs(fract(p / cell + 0.5) - 0.5) * cell;
  return sd_coverage(min(d.x, d.y) - 0.5 * max(width, px), px);
}

fn pic_chart(p: vec2f, aspect: f32, px: f32) -> vec3f {
  let centre = vec2f(0.5 * aspect, 0.5);
  let q = p - centre;
  var color = vec3f(0.035, 0.036, 0.045);
  color = mix(color, vec3f(0.16, 0.17, 0.2), 0.8 * pic_grid_lines(q, 1.0 / 36.0, 0.0, px));
  color = mix(color, vec3f(0.42, 0.43, 0.47), 0.9 * pic_grid_lines(q, 1.0 / 9.0, 0.002, px));
  for (var i = 1; i <= 4; i++) {
    let ring = abs(length(q) - 0.111111 * f32(i)) - 0.001;
    color = mix(color, vec3f(0.85, 0.83, 0.78), 0.85 * sd_coverage(ring, px));
  }
  let rising = pic_line(p, vec2f(0.0, 1.0), vec2f(aspect, 0.0), 0.002, px);
  let falling = pic_line(p, vec2f(0.0), vec2f(aspect, 1.0), 0.002, px);
  return mix(color, vec3f(0.95, 0.4, 0.08), 0.85 * max(rising, falling));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let aspect = picture.aspect;
  let p = in.uv * vec2f(aspect, 1.0);
  if (picture.style == 1u) {
    return vec4f(pic_city(p, aspect, picture.pixel), 1.0);
  }
  if (picture.style == 2u) {
    return vec4f(pic_chart(p, aspect, picture.pixel), 1.0);
  }
  return vec4f(pic_road(p, aspect, picture.pixel), 1.0);
}
