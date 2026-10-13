#include "fullscreen.wgsl"
#include "sdf.wgsl"
#include "flicker.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
// Written by signals.wgsl: row = light, column 0 = now, older to the right.
@group(0) @binding(1) var signals: texture_2d<f32>;

// Everything below is LINEAR radiance: 1.0 is paper white, the tail tonemaps.
const WALL_AMBIENT = vec3f(0.011, 0.010, 0.010);
const WALL_LIT = vec3f(1.0, 0.50, 0.18);
const FLAME_BODY = vec3f(1.0, 0.36, 0.06);
const FLAME_CORE = vec3f(1.0, 0.80, 0.46);
const FLAME_BASE = vec3f(0.10, 0.25, 0.90);
const WAX = vec3f(1.0, 0.66, 0.30);
const WAX_DEEP = vec3f(0.80, 0.26, 0.07);

const SCREEN = vec3f(0.0075, 0.0080, 0.0095);
const GRID = vec3f(0.050, 0.050, 0.055);
const BAND = vec3f(0.020, 0.036, 0.052);
const TRACE_CAPPED = vec3f(1.0, 0.50, 0.10);
const TRACE_RAW = vec3f(1.0, 0.13, 0.08);
const PEN = vec3f(1.0, 0.90, 0.72);

// Fraction of the plot's height left empty above 1.0 and below 0.0.
const PLOT_PAD: f32 = 0.09;
// The shelf the candle stands on, and the wick, in cell space relative to the candle's foot.
const SHELF: f32 = 0.045;
const WICK = vec2f(0.0, 0.39);

// A candle against a wall. `q` is relative to the centre of the candle's foot, in cell heights,
// y up. `level` is the flicker intensity (0..1) and `sway` the flicker offset: together they are
// everything that moves.
fn candle(q: vec2f, level: f32, sway: vec2f, px: f32) -> vec3f {
  let height = 0.30 * (0.78 + 0.22 * level) * (1.0 + 0.10 * sway.y);
  let f = q - WICK;
  let t = f.y / height;
  let tc = saturate(t);
  // The tip leans with the offset; the base stays on the wick.
  let lean = 0.10 * sway.x * tc * tc;
  // Half-width along the height: a teardrop, widest a third of the way up, normalised to 1.
  let profile = pow(tc, 0.45) * pow(1.0 - tc, 0.9) / 0.4235;
  let radius = 0.060 * profile;
  let inside = step(0.0, t) * step(t, 1.0);
  // 1 on the axis, 0 on the silhouette.
  let heat = inside * saturate(1.0 - abs(f.x - lean) / max(radius, 1e-4));

  // Orange body, a pale core that thins out towards the tip, a blue foot that does not flicker.
  let body = FLAME_BODY * 8.0 * smoothstep(0.0, 0.5, heat);
  let core = FLAME_CORE * 24.0 * smoothstep(0.35, 1.0, heat) * smoothstep(0.04, 0.30, tc)
    * (1.0 - 0.7 * smoothstep(0.55, 1.0, tc));
  let base = FLAME_BASE * 1.6 * smoothstep(0.0, 0.6, heat) * (1.0 - smoothstep(0.0, 0.20, tc));
  let flame = level * (body + core) + base;

  // The wall takes the light of the whole flame: this is the large area the caps exist for.
  let centre = WICK + vec2f(0.5 * lean, 0.42 * height);
  let d = length(q - centre);
  let falloff = pow(1.0 + (d * d) / (0.30 * 0.30), -1.25);
  var color = WALL_AMBIENT + WALL_LIT * (0.62 * level * falloff);

  // The candle itself: wax glowing just under the flame, darker down the stick.
  let wax_d = sd_rounded_box_2d(q - vec2f(0.0, 0.14), vec2f(0.058, 0.225), 0.02);
  let lit = exp(-max(0.365 - q.y, 0.0) / 0.085);
  let shade = 1.0 - 0.4 * smoothstep(0.0, 0.058, abs(q.x));
  let wax = mix(WAX_DEEP * 0.16, WAX, lit) * (level * shade);
  color = mix(color, wax, sd_coverage(wax_d, px));
  let wick_d = sd_segment_2d(q, vec2f(0.0, 0.36), WICK + vec2f(0.0, 0.012)) - 0.004;
  color = mix(color, vec3f(0.01), sd_coverage(wick_d, px));

  // The shelf: its top edge catches the light, its face stays dark. It also ends each cell.
  let edge = WALL_LIT * (0.30 * level * pow(1.0 + (q.x * q.x) / (0.22 * 0.22), -1.0));
  let face = mix(vec3f(0.006, 0.005, 0.005), edge, smoothstep(SHELF - 0.012, SHELF, q.y));
  color = mix(color, face, sd_coverage(q.y - SHELF, px));

  return color + flame;
}

// Rounds a rate to the whole number of knots per period the signal actually uses.
fn knot_rate(rate: f32) -> f32 {
  let knots = 4.0 * floor(clamp(rate, 0.0, FLICKER_RATE_LIMIT) * (FLICKER_PERIOD / 4.0) + 0.5);
  return knots / FLICKER_PERIOD;
}

// The oscilloscope: `at` in pixels from the plot's bottom-left corner, `size` the plot in pixels.
// Time runs left (now) to right (`span` seconds ago); the vertical axis is intensity 0..1.
fn scope(at: vec2f, size: vec2f, light: i32) -> vec3f {
  let uncapped = params.uncapped > 0.5;
  let req = params.settings;
  let requested = flicker_settings(req.x, req.y, req.z, req.w);
  // The settings that drive the candle: the request, clamped unless the caps are off.
  var live = flicker_clamp(requested);
  if (uncapped) {
    live = requested;
  }
  // The vertical axis ends at 1.0 and starts at the quarter below the live signal's range, so a
  // shallow flicker is not a hairline at the top. The 10% band shows the scale at any zoom.
  let depth = max(live.depth, 0.0) + max(live.shimmer, 0.0);
  let bottom = clamp(floor((1.0 - depth) * 4.0 + 1e-4) * 0.25, 0.0, 0.75);
  let unit = size.y * (1.0 - 2.0 * PLOT_PAD) / (1.0 - bottom);   // pixels per 1.0 of intensity
  let zero = size.y * PLOT_PAD - bottom * unit;                  // pixel row of intensity 0
  let value = (at.y - zero) / unit;                              // intensity at this pixel
  let thick = max(1.0, size.y / 120.0);                          // line weight, in pixels
  let age = at.x / size.x * params.span;
  let then = params.time - age;
  var color = SCREEN;

  // The 10% band, centred on the signal's mean: a change has to cross the whole band to count
  // towards a flash. The brighter strip inside it is the shimmer cap (4%).
  let mean = clamp(1.0 - 0.5 * depth, 0.05, 0.95);
  let off = abs(value - mean) * unit;
  let band = 0.05 * unit;
  let inner = 0.5 * FLICKER_SAFE_MAX_SHIMMER * unit;
  color += BAND * (1.0 - smoothstep(band - 0.5, band + 0.5, off));
  color += BAND * 0.9 * (1.0 - smoothstep(inner - 0.5, inner + 0.5, off));
  color += BAND * 2.2 * (1.0 - smoothstep(0.0, thick, abs(off - band)));

  // Horizontal rules every 0.25 up to 1.0, and a dashed one at 0.80: a flash needs its darker
  // state below it.
  let rule = abs(fract(value * 4.0 + 0.5) - 0.5) * 0.25 * unit;
  color += GRID * (1.0 - smoothstep(0.0, thick, rule)) * step(value, 1.0 + 0.5 / unit);
  let dashes = step(fract(at.x / (10.0 * thick)), 0.5);
  let dark = abs(value - 0.8) * unit;
  color += vec3f(0.11, 0.075, 0.035) * dashes * (1.0 - smoothstep(0.0, thick, dark));

  // Vertical rules every second, scrolling with the trace, and a tick at every knot of the slow
  // swing along the bottom: the signal can turn round at most once between two ticks.
  let second = abs(fract(then + 0.5) - 0.5) / params.span * size.x;
  color += GRID * 0.75 * (1.0 - smoothstep(0.0, thick, second));
  let rate = knot_rate(live.rate);
  let spacing = size.x / max(params.span * rate, 1e-3);
  let knot = abs(fract(then * rate + 0.5) - 0.5) * spacing;
  let ticks = step(at.y, 0.075 * size.y) * smoothstep(3.0, 7.0, spacing);
  color += TRACE_CAPPED * 0.16 * ticks * (1.0 - smoothstep(0.0, thick, knot));

  // Both traces as polylines through the signal texture, distance measured in pixels.
  let width = f32(textureDimensions(signals).x);
  let s = at.x / size.x * (width - 1.0);
  let i0 = i32(floor(s));
  let fr = s - floor(s);
  let dx = size.x / (width - 1.0);
  var dist = vec2f(1e6);
  var previous = vec2f(0.0);
  for (var k = -1; k <= 2; k++) {
    let texel = textureLoad(signals, vec2i(clamp(i0 + k, 0, i32(width) - 1), light), 0);
    let x = (f32(k) - fr) * dx;
    let y = zero + texel.xy * unit;
    if (k > -1) {
      let here = vec2f(0.0, at.y);
      dist.x = min(dist.x, sd_segment_2d(here, vec2f(x - dx, previous.x), vec2f(x, y.x)));
      dist.y = min(dist.y, sd_segment_2d(here, vec2f(x - dx, previous.y), vec2f(x, y.y)));
    }
    previous = y;
  }
  let lines = (1.0 - smoothstep(vec2f(thick - 0.5), vec2f(thick + 0.5), dist)) * step(0.0, at.x);
  // The signal that drives the candle is drawn bright; the other one is a dim ghost under it.
  // Amber is the capped signal, red the same settings with no caps.
  if (uncapped) {
    color = mix(color, TRACE_CAPPED * 0.45, lines.x);
    color = mix(color, TRACE_RAW * 1.6, lines.y);
  } else {
    color = mix(color, TRACE_RAW * 0.55, lines.y);
    color = mix(color, TRACE_CAPPED * 1.35, lines.x);
  }

  // The pen: the current value, computed on the CPU by the TypeScript twin of the signal. It sits
  // on the start of the line exactly as long as the two implementations agree.
  let pen = vec2f(0.0, zero + params.pen[light] * unit);
  let dot_radius = 2.2 * thick;
  let dot_d = length(at - pen) - dot_radius;
  color = mix(color, PEN * 4.0, 1.0 - smoothstep(-0.5, 0.5, dot_d));
  return color;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // A grid of cells, one light each: a column of rows, or a row of columns on a wide strip.
  let cell_id = min(floor(in.uv * params.grid), params.grid - 1.0);
  let light = i32(cell_id.x + cell_id.y);
  let cuv = in.uv * params.grid - cell_id;
  let cell_width = params.cell.x;
  let flame_width = params.cell.y;
  let margin = params.cell.z;
  let px = params.cell.w;
  // Cell space: x right, y up, one unit = the cell's height.
  let p = vec2f(cuv.x * cell_width, 1.0 - cuv.y);

  let now = textureLoad(signals, vec2i(0, light), 0);
  let level = select(now.x, now.y, params.uncapped > 0.5);
  var color = candle(p - vec2f(0.5 * flame_width, 0.0), level, now.zw * params.sway, px);

  // The scope screen fills the rest of the cell.
  let lo = vec2f(flame_width, margin);
  let hi = vec2f(cell_width - margin, 1.0 - margin);
  let screen_d = sd_rounded_box_2d(p - 0.5 * (lo + hi), 0.5 * (hi - lo), 0.025);
  // The plot starts a little inside the screen so the pen has room.
  let inset = vec2f(0.055, 0.0);
  let plot = scope((p - lo - inset) / px, (hi - lo - inset) / px, light);
  color = mix(color, plot, sd_coverage(screen_d, px));
  // The frame turns red when the caps are off.
  let frame = select(vec3f(0.085, 0.075, 0.065), vec3f(0.55, 0.06, 0.04), params.uncapped > 0.5);
  color = mix(color, frame, 1.0 - smoothstep(0.0, 1.5 * px, abs(screen_d)));

  return vec4f(color, 1.0);
}
