// Flame colour ramps test scene: one flame, drawn once per ramp, so the only thing that differs
// between panels is the mapping from heat to radiance. Under each flame its ramp is laid out from
// heat 0 to 1: the upper half of that bar is the formula, the lower half the baked texture.
#include "fullscreen.wgsl"
#include "fbm.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var ramps: texture_2d<f32>;
@group(0) @binding(2) var ramp_sampler: sampler;

const PANELS: f32 = 8.0;
// Rows of the ramp texture, which is also the order of the panels.
const ROW_BLACKBODY: i32 = 0;
const ROW_FIRE: i32 = 1;
const ROW_TOON: i32 = 2; // authored as colour stops: it has no formula

const SOURCE_FORMULA: u32 = 0u;
const SOURCE_TEXTURE: u32 = 1u;
const SOURCE_SPLIT: u32 = 2u;

const BACKGROUND = vec3f(0.004, 0.004, 0.005);
const DIVIDER = vec3f(0.09, 0.085, 0.08);
// Erosion cells per flame height across the flame; they are 1 / 0.3 times taller than wide.
const TONGUES: f32 = 6.0;

fn from_texture(row: i32, heat: f32) -> vec3f {
  return ramp_lookup(ramps, ramp_sampler, heat, row);
}

fn from_formula(row: i32, heat: f32) -> vec3f {
  switch row {
    case 0 { return ramp_blackbody(heat, params.t_cold, params.t_hot); }
    case 1 { return ramp_fire(heat); }
    case 2 { return from_texture(row, heat); }
    // Rows 3..7 are gas, copper, sodium, potassium, lithium: ramp_select kinds 1..5.
    default { return ramp_select(row - 2, heat); }
  }
}

// The ramp for one panel. `texture_side` picks the route where the scene shows both.
fn shade(row: i32, heat: f32, texture_side: bool) -> vec3f {
  let use_texture =
    params.source == SOURCE_TEXTURE || (params.source == SOURCE_SPLIT && texture_side);
  var color = from_formula(row, heat);
  if (use_texture) { color = from_texture(row, heat); }
  if (row == ROW_BLACKBODY && params.whiten_knee > 0.0) {
    color = ramp_whiten(color * params.intensity, params.whiten_knee);
    return color;
  }
  return color * params.intensity;
}

// (sway in -1..1, erosion in 0..1) at flame-space point q: six noise evaluations.
fn rising_noise(q: vec2f, t: f32, fp: FlameParams) -> vec2f {
  // One slow value per height, scrolling upward, so a bend starts low and travels to the tip.
  let bend = fbm_2d(vec2f(q.y * 1.5 - t, t * 0.31), 2, 2.0, 0.5);
  let sway = clamp(bend * 1.9, -1.0, 1.0);
  // Erosion is read where the swayed flame is, so the tongues lean with the body.
  let p = flame_turbulence(q, vec2f(sway, 0.0), fp.turbulence * fp.half_width, fp.height, fp.turbulence_curve);
  let n = fbm_3d(vec3f(p.x * TONGUES, p.y * TONGUES * 0.3 - t * 1.7, t * 0.55), 4, 2.0, 0.55);
  return vec2f(sway, smoothstep(-0.3, 0.3, n));
}

// Size of one flame height, in canvas heights, for a panel of the given size.
fn flame_scale(panel: vec2f) -> f32 {
  return min(panel.y * 0.8, panel.x / 0.62);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Canvas heights, y up.
  let aspect = params.resolution.x / params.resolution.y;
  let pixel = 1.0 / params.resolution.y;
  let frame = vec2f(aspect, 1.0);
  let p = vec2f(in.uv.x * aspect, 1.0 - in.uv.y);

  // One panel per ramp, in the grid (8x1, 4x2 or 2x4) that leaves the flames largest.
  var cells = vec2f(1.0);
  if (params.view == 0u) {
    cells = vec2f(8.0, 1.0);
    var best = flame_scale(frame / cells);
    for (var columns = 4.0; columns >= 2.0; columns *= 0.5) {
      let candidate = vec2f(columns, PANELS / columns);
      let scale = flame_scale(frame / candidate);
      if (scale > best) {
        best = scale;
        cells = candidate;
      }
    }
  }
  let panel = frame / cells;
  let cell = clamp(floor(p / panel), vec2f(0.0), cells - vec2f(1.0));
  let local = p - cell * panel;
  var row = i32(params.view) - 1;
  if (params.view == 0u) {
    row = i32(cell.x + (cells.y - 1.0 - cell.y) * cells.x);
  }

  var color = BACKGROUND;

  // The ramp bar along the bottom of the panel: heat 0 at its left end, 1 at its right.
  let bar_min = vec2f(0.1 * panel.x, 0.035 * panel.y);
  let bar_size = vec2f(0.8 * panel.x, max(0.045 * panel.y, 6.0 * pixel));
  let bar = (local - bar_min) / bar_size;
  if (bar.x >= 0.0 && bar.x <= 1.0 && bar.y >= 0.0 && bar.y <= 1.0) {
    let lower = bar.y < 0.5;
    var bar_color = from_formula(row, bar.x);
    if (lower) { bar_color = from_texture(row, bar.x); }
    if (row == ROW_BLACKBODY && params.whiten_knee > 0.0) {
      bar_color = ramp_whiten(bar_color, params.whiten_knee);
    }
    // The bar is a legend, not a light: shown at a fixed quarter of the ramp's radiance so that it
    // neither clips to white nor blooms over the flame above it.
    return vec4f(bar_color * 0.25, 1.0);
  }

  // The flame, standing on a line a little above the bar.
  let scale = flame_scale(panel);
  let floor_y = bar_min.y + bar_size.y + 0.07 * panel.y;
  let origin = vec2f(0.5 * panel.x, floor_y + 0.4 * max(panel.y - floor_y - scale, 0.0));
  let q = (local - origin) / scale;
  let fp = flame_params_default();
  if (flame_reach(q, fp)) {
    let heat = flame_heat_teardrop(q, rising_noise(q, params.time, fp), fp);
    color += shade(row, heat, q.x > 0.0);
  }

  // Dividers on the leading edges of the panels.
  let line = 1.25 * pixel;
  if ((cell.x > 0.5 && local.x < line) || (cell.y < cells.y - 1.5 && panel.y - local.y < line)) {
    color = DIVIDER;
  }
  return vec4f(color, 1.0);
}
