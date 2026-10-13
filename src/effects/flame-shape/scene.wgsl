// Flame shaping test scene: one flame drawn at three stages of the chain in flame.wgsl.
//   stage 0  the bare silhouette as a distance field (iso-distance contours every 0.1 heights)
//   stage 1  the heat field after turbulence and erosion, in greyscale
//   stage 2  the heat through the fire ramp, as linear HDR radiance
// Stages 0 and 1 stay below 1.0 (paper white) so only the real flame blooms.
#include "fullscreen.wgsl"
#include "fbm.wgsl"
#include "sdf.wgsl"
#include "flame.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

const BACKGROUND = vec3f(0.004, 0.004, 0.005);
const DIVIDER = vec3f(0.11, 0.1, 0.09);
// A panel must be this many flame heights wide for the widest, most turbulent flame to fit.
const FIT_WIDTH: f32 = 0.95;
const TAPER_TIP: f32 = 0.12; // tip half-width of the taper, as a fraction of its base
// Erosion cells per flame height across the flame; they are 1 / 0.3 times taller than wide.
const TONGUES: f32 = 6.0;

// Size of one flame height, in canvas heights, inside a panel of the given size.
fn panel_scale(panel: vec2f) -> f32 {
  return min(panel.y * params.height, panel.x / FIT_WIDTH);
}

fn bare_distance(q: vec2f, fp: FlameParams) -> f32 {
  if (params.shape > 0.5) {
    return flame_sd_taper(q, fp.half_width, fp.half_width * TAPER_TIP, fp.height);
  }
  return flame_sd_teardrop(q, fp.half_width, fp.height);
}

// (sway in -1..1, erosion in 0..1) for the flame-space point q. Six noise evaluations.
fn rising_noise(q: vec2f, t: f32, fp: FlameParams) -> vec2f {
  // Sway: one slow value per height, scrolling upward, so a bend starts low and travels to the tip.
  let bend = fbm_2d(vec2f(q.y * 1.5 - t, t * 0.31), 2, 2.0, 0.5);
  let sway = clamp(bend * 1.9, -1.0, 1.0);
  // Erosion is read where the swayed flame is, so the tongues lean with the body. The field is
  // stretched vertically (tongues are taller than wide) and rises faster than the sway travels.
  let travel = fp.turbulence * fp.half_width;
  let p = flame_turbulence(q, vec2f(sway, 0.0), travel, fp.height, fp.turbulence_curve);
  let n = fbm_3d(vec3f(p.x * TONGUES, p.y * TONGUES * 0.3 - t * 1.7, t * 0.55), 4, 2.0, 0.55);
  return vec2f(sway, smoothstep(-0.3, 0.3, n));
}

fn scene_heat(q: vec2f, t: f32, fp: FlameParams) -> f32 {
  if (!flame_reach(q, fp)) {
    return 0.0;
  }
  let noise = rising_noise(q, t, fp);
  if (params.shape > 0.5) {
    return flame_heat_taper(q, noise, fp.half_width * TAPER_TIP, fp);
  }
  return flame_heat_teardrop(q, noise, fp);
}

// The distance field drawn the usual way: warm inside, cool outside, a contour every `spacing`,
// a pale line on the surface. `px` is one pixel in flame units.
fn distance_view(d: f32, px: f32) -> vec3f {
  let spacing = 0.1;
  let inside = d < 0.0;
  var col = select(vec3f(0.02, 0.05, 0.1), vec3f(0.5, 0.17, 0.035), inside);
  col *= select(1.0 / (1.0 + 2.5 * d), 0.45 + 2.2 * min(-d, 0.25), inside);
  let to_line = abs(fract(d / spacing + 0.5) - 0.5) * spacing;
  let contour = 1.0 - smoothstep(0.5 * px, 1.5 * px, to_line);
  col = mix(col, col * 2.4 + vec3f(0.012), contour * 0.7);
  let surface = 1.0 - smoothstep(1.0 * px, 2.0 * px, abs(d));
  return mix(col, vec3f(0.85, 0.8, 0.7), surface);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Canvas heights, y up.
  let frame = vec2f(params.aspect, 1.0);
  let p = vec2f(in.uv.x * params.aspect, 1.0 - in.uv.y);

  // Three panels: side by side, or stacked when that leaves the flame larger (a phone in portrait).
  var cells = vec2f(1.0, 1.0);
  if (params.view < 0.5) {
    let columns = panel_scale(frame / vec2f(3.0, 1.0));
    let rows = panel_scale(frame / vec2f(1.0, 3.0));
    cells = select(vec2f(1.0, 3.0), vec2f(3.0, 1.0), columns >= rows);
  }
  let panel = frame / cells;
  let cell = clamp(floor(p / panel), vec2f(0.0), cells - vec2f(1.0));
  let local = p - cell * panel;
  // Left to right, or top to bottom.
  var stage = i32(params.view) - 1;
  if (params.view < 0.5) {
    stage = i32(cell.x + (cells.y - 1.0 - cell.y));
  }

  let scale = panel_scale(panel);
  let origin = vec2f(0.5 * panel.x, 0.46 * (panel.y - scale));
  let q = (local - origin) / scale;
  let px = params.pixel / scale;

  var fp = flame_params(params.width, 1.0);
  fp.turbulence = params.turbulence;
  fp.erosion = params.erosion;
  fp.falloff = params.falloff;
  if (params.shape > 0.5) {
    // A jet or a torch leaves its nozzle at full heat.
    fp.base_soft = 0.0;
    fp.hot = 0.0;
  }

  var col = BACKGROUND;
  if (stage == 0) {
    col = distance_view(bare_distance(q, fp), px);
  } else {
    let heat = scene_heat(q, params.time, fp);
    if (stage == 1) {
      // Greyscale, gamma-like so the displayed grey is roughly proportional to heat; the bare
      // surface stays as a faint outline to show what turbulence and erosion did to it.
      let outline = 1.0 - smoothstep(0.5 * px, 1.5 * px, abs(bare_distance(q, fp)));
      col = BACKGROUND + vec3f(0.9 * pow(heat, 2.2)) + vec3f(0.05, 0.045, 0.04) * outline;
    } else {
      col = BACKGROUND + ramp_fire(heat) * params.intensity;
      if (params.shape > 0.5) {
        // The taper is cut on its base line, as a flame leaving a burner is. Draw the burner.
        let half = vec2f(fp.half_width * 1.12 + 0.012, 0.022);
        let d = sd_rounded_box_2d(q + vec2f(0.0, half.y), half, 0.008);
        let across = q.x / fp.half_width;
        let lit = exp(min(q.y, 0.0) * 70.0 - across * across) * params.intensity;
        let iron = vec3f(0.012, 0.011, 0.01) + vec3f(0.9, 0.28, 0.05) * 0.3 * lit;
        col = mix(col, iron, sd_coverage(d, px));
      }
    }
  }

  // Dividers: on the leading edge of every panel but the first.
  let line = 1.25 * params.pixel;
  let divide_x = cell.x > 0.5 && local.x < line;
  let divide_y = cell.y < cells.y - 1.5 && panel.y - local.y < line;
  if (divide_x || divide_y) {
    col = DIVIDER;
  }
  return vec4f(col, 1.0);
}
