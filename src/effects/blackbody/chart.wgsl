#include "fullscreen.wgsl"
#include "blackbody.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var lut: texture_2d<f32>;
@group(0) @binding(2) var lut_sampler: sampler;

const VIEW_COMPARE: u32 = 0u;
const VIEW_COLOUR: u32 = 1u;
const VIEW_RADIANCE: u32 = 2u;
const VIEW_ERROR: u32 = 3u;
const VIEW_INTENSITY: u32 = 4u;

const ROUTE_PLANCK: u32 = 0u;
const ROUTE_FIT: u32 = 1u;
const ROUTE_LOOKUP: u32 = 2u;

const LABEL_COLOUR = vec3f(0.42, 0.4, 0.38);

// 3 x 5 digits, one bit per dot, top row first, most significant bit at the top-left.
const DIGITS = array<u32, 10>(
  0x7b6fu, 0x2c97u, 0x73e7u, 0x73cfu, 0x5bc9u, 0x79cfu, 0x79efu, 0x7249u, 0x7befu, 0x7bcfu,
);

fn digit_dot(digit: u32, cell: vec2i) -> f32 {
  if (cell.x < 0 || cell.x > 2 || cell.y < 0 || cell.y > 4) { return 0.0; }
  return f32((DIGITS[digit] >> (14u - u32(cell.y * 3 + cell.x))) & 1u);
}

fn digit_count(value: u32) -> u32 {
  var count = 1u;
  var rest = value / 10u;
  while (rest > 0u) {
    count++;
    rest /= 10u;
  }
  return count;
}

// 1 where `pixel` is on the number drawn with its top-left corner at `origin`; `dot` is the size
// of one dot of the font in pixels. Each digit is 3 dots wide with 1 dot between digits.
fn number_dot(pixel: vec2f, origin: vec2f, value: u32, dot_size: f32) -> f32 {
  let local = floor((pixel - origin) / dot_size);
  let digits = digit_count(value);
  if (local.y < 0.0 || local.y > 4.0 || local.x < 0.0 || local.x >= f32(digits) * 4.0) {
    return 0.0;
  }
  let slot = u32(local.x) / 4u;
  var divisor = 1u;
  for (var i = slot + 1u; i < digits; i++) { divisor *= 10u; }
  return digit_dot((value / divisor) % 10u, vec2i(i32(local.x) - i32(slot) * 4, i32(local.y)));
}

fn number_width(value: u32, dot_size: f32) -> f32 {
  return (f32(digit_count(value)) * 4.0 - 1.0) * dot_size;
}

// The horizontal axis is linear in 1/t, like the lookup texture: the red end, where fire lives,
// gets most of the width.
fn temperature_at(x: f32) -> f32 {
  return 1000.0 / mix(1000.0 / params.t_lo, 1000.0 / params.t_hi, x);
}

fn axis_position(t: f32) -> f32 {
  return (1000.0 / params.t_lo - 1000.0 / t) / (1000.0 / params.t_lo - 1000.0 / params.t_hi);
}

fn chroma(route: u32, t: f32) -> vec3f {
  switch route {
    case ROUTE_PLANCK { return blackbody_planck(t); }
    case ROUTE_LOOKUP { return blackbody_lookup(lut, lut_sampler, t); }
    default { return blackbody_fit(t); }
  }
}

fn max_channel_one(c: vec3f) -> vec3f {
  return c / max(max(c.r, max(c.g, c.b)), 1e-6);
}

// What one strip shows at temperature t. kind: 0 colour only, 1 radiance, 2 error against Planck.
fn strip(kind: u32, route: u32, t: f32) -> vec3f {
  let c = chroma(route, t);
  if (kind == 0u) { return max_channel_one(c); }
  if (kind == 1u) {
    return c * (params.intensity * blackbody_intensity(t, params.t_ref, params.gamma));
  }
  let difference = abs(max_channel_one(c) - max_channel_one(blackbody_planck(t)));
  return min(difference * params.error_gain, vec3f(1.5));
}

// Anti-aliased line through the curve value `v` (0..1 up the plot) at plot height `y`.
fn curve(v: f32, y: f32, slope_px: f32, plot_px: f32) -> f32 {
  let distance_px = abs(y - v) * plot_px / sqrt(1.0 + slope_px * slope_px);
  return 1.0 - smoothstep(0.6, 1.8, distance_px);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let size = params.resolution;
  let pixel = in.uv * size;
  let dot_size = max(1.0, floor(min(size.y / 200.0, size.x / 320.0)));
  let margin = vec2f(6.0 * dot_size, 2.0 * dot_size);
  let axis_height = 11.0 * dot_size;

  // The plot area: a left margin for row numbers, an axis underneath.
  let plot_min = vec2f(margin.x, margin.y);
  let plot_size = max(size - vec2f(margin.x + margin.y, margin.y + axis_height), vec2f(1.0));
  let plot = (pixel - plot_min) / plot_size;
  let inside_x = plot.x >= 0.0 && plot.x <= 1.0;
  let t = temperature_at(clamp(plot.x, 0.0, 1.0));

  var color = vec3f(0.0);

  // ---- Axis: a tick and a label per entry of params.ticks (x = kelvin, y = label alignment) ----
  if (pixel.y > plot_min.y + plot_size.y) {
    let axis_y = pixel.y - (plot_min.y + plot_size.y);
    var ink = 0.0;
    // Every tick is drawn; a label is dropped when it would run into the previous one or into the
    // label of the last tick, which is the end of the range and always shown.
    let last = params.ticks[params.tick_count - 1u];
    let last_left = plot_min.x + plot_size.x - number_width(u32(last.x), dot_size);
    var free_from = -1e9;
    for (var i = 0u; i < params.tick_count; i++) {
      let tick = params.ticks[i];
      let x_px = plot_min.x + axis_position(tick.x) * plot_size.x;
      if (abs(pixel.x - x_px) < 0.5 * dot_size && axis_y < 3.0 * dot_size) { ink = 1.0; }
      let value = u32(tick.x);
      let width = number_width(value, dot_size);
      // Alignment 0 centres the label on its tick, -1 starts it there, 1 ends it there.
      let left = round(x_px - width * (0.5 + 0.5 * tick.y));
      let is_last = i + 1u == params.tick_count;
      let fits = left >= free_from && (is_last || left + width + 3.0 * dot_size <= last_left);
      if (fits) {
        free_from = left + width + 3.0 * dot_size;
        ink = max(ink, number_dot(pixel, vec2f(left, plot_min.y + plot_size.y + 4.5 * dot_size), value, dot_size));
      }
    }
    return vec4f(LABEL_COLOUR * ink, 1.0);
  }

  if (params.view == VIEW_INTENSITY) {
    // Three brightness mappings on one linear scale, each relative to its own value at the hot end.
    if (inside_x && plot.y >= 0.0) {
      let y = 1.0 - plot.y;
      let dt = temperature_at(clamp(plot.x + 1.0 / plot_size.x, 0.0, 1.0)) - t;
      let physical = blackbody_luminance(t, params.t_hi);
      let physical_next = blackbody_luminance(t + dt, params.t_hi);
      let stefan = blackbody_stefan(t, params.t_hi);
      let stefan_next = blackbody_stefan(t + dt, params.t_hi);
      let tamed = blackbody_intensity(t, params.t_hi, params.gamma);
      let tamed_next = blackbody_intensity(t + dt, params.t_hi, params.gamma);
      let h = plot_size.y;
      // Faint fill under the tamed curve in the colour that mapping gives, then the three lines.
      let glow = blackbody_fit(t) * tamed * params.intensity * 0.35;
      color = glow * step(y, tamed) * smoothstep(0.0, 0.25, y);
      color = mix(color, vec3f(0.55, 0.7, 1.0), curve(stefan, y, (stefan_next - stefan) * h, h));
      color = mix(color, vec3f(1.2), curve(physical, y, (physical_next - physical) * h, h));
      color = mix(color, vec3f(2.4, 0.9, 0.2), curve(tamed, y, (tamed_next - tamed) * h, h));
    }
    return vec4f(color, 1.0);
  }

  // ---- Strips ----
  // Compare: three groups (colour, radiance, error), each a strip per route. The single views
  // show one group at full height.
  var first_group = 0u;
  var group_count = 3u;
  if (params.view != VIEW_COMPARE) {
    first_group = params.view - 1u;
    group_count = 1u;
  }
  let group_gap = 0.045;
  let strip_gap = 0.012;
  // Heights in strips: colour 3, radiance 3, error 2 (Planck has no error against itself).
  var total_strips = 0.0;
  for (var g = first_group; g < first_group + group_count; g++) {
    total_strips += select(3.0, 2.0, g == 2u);
  }
  let strip_height = (1.0 - group_gap * f32(group_count - 1u)) / total_strips;

  var top = 0.0;
  for (var g = first_group; g < first_group + group_count; g++) {
    let strips = select(3u, 2u, g == 2u);
    for (var s = 0u; s < strips; s++) {
      let bottom = top + strip_height;
      let route = select(s, s + 1u, g == 2u);
      if (plot.y >= top && plot.y < bottom - strip_gap) {
        if (inside_x) {
          color = strip(g, route, t);
        } else if (pixel.x < margin.x) {
          // Row number in the margin: 1 Planck, 2 fit, 3 lookup.
          let centre = plot_min.y + (top + bottom - strip_gap) * 0.5 * plot_size.y;
          let origin = vec2f(dot_size, round(centre - 2.5 * dot_size));
          color = LABEL_COLOUR * number_dot(pixel, origin, route + 1u, dot_size);
        }
      }
      top = bottom;
    }
    top += group_gap;
  }
  return vec4f(color, 1.0);
}
