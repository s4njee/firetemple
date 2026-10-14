#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "sdf.wgsl"
#include "picture-params.wgsl"

// The stand-in pictures fire-haze bends: what is behind the hot air until the visitor drops a photo or
// a video on the canvas (the repository ships no image files). Drawn ONCE into an sRGB texture at
// canvas size, again only on a resize or a change of picture, so nothing here is on the per-frame
// budget. All three are made of thin straight strokes, which is what makes a shimmer easy to see.
//
//   page        a printed page: a headline, two columns of text in pseudo-glyphs, a framed bar chart
//   brick wall  courses of brick and a window with a cross frame
//   test grid   a fine and a coarse grid, rings and two diagonals
//
// Output is ordinary picture colour, linear, at or below 1.0.
// Coordinates: p = uv * (aspect, 1), y DOWN, one unit = the picture height.

@group(0) @binding(0) var<uniform> picture: PictureParams;

const FH_PAPER = vec3f(0.80, 0.77, 0.70);
const FH_INK = vec3f(0.025, 0.024, 0.03);

// A line of the given width, never thinner than a pixel.
fn fh_line(p: vec2f, a: vec2f, b: vec2f, width: f32, px: f32) -> f32 {
  return sd_coverage(sd_segment_2d(p, a, b) - 0.5 * max(width, px), px);
}

// ---- Page ---------------------------------------------------------------------------------------

// One pseudo-glyph: q is the position in the letter (baseline at y = 0, x-height at y = -h), `kind`
// picks a template of strokes: o n l e d p v i t. Returns the distance to the strokes' centre lines.
fn fh_glyph(q: vec2f, kind: i32, gw: f32, h: f32) -> f32 {
  let c = vec2f(0.5 * gw, -0.5 * h);
  let ring = abs(length((q - c) * vec2f(h / gw, 1.0)) - 0.5 * h) * (gw / h);
  let left = sd_segment_2d(q, vec2f(0.0, 0.0), vec2f(0.0, -h));
  switch kind {
    case 0: {
      return ring;
    }
    case 1: {
      let arch = min(
        sd_segment_2d(q, vec2f(0.0, -0.7 * h), vec2f(0.5 * gw, -h)),
        sd_segment_2d(q, vec2f(0.5 * gw, -h), vec2f(gw, -0.7 * h)),
      );
      return min(min(left, arch), sd_segment_2d(q, vec2f(gw, 0.0), vec2f(gw, -0.7 * h)));
    }
    case 2: {
      return sd_segment_2d(q, vec2f(0.5 * gw, 0.0), vec2f(0.5 * gw, -1.6 * h));
    }
    case 3: {
      return min(ring, sd_segment_2d(q, vec2f(0.0, -0.5 * h), vec2f(gw, -0.5 * h)));
    }
    case 4: {
      return min(ring, sd_segment_2d(q, vec2f(gw, 0.0), vec2f(gw, -1.6 * h)));
    }
    case 5: {
      return min(ring, sd_segment_2d(q, vec2f(0.0, 0.55 * h), vec2f(0.0, -h)));
    }
    case 6: {
      return min(
        sd_segment_2d(q, vec2f(0.0, -h), vec2f(0.5 * gw, 0.0)),
        sd_segment_2d(q, vec2f(0.5 * gw, 0.0), vec2f(gw, -h)),
      );
    }
    case 7: {
      let stem = sd_segment_2d(q, vec2f(0.5 * gw, 0.0), vec2f(0.5 * gw, -h));
      return min(stem, length(q - vec2f(0.5 * gw, -1.4 * h)));
    }
    default: {
      let stem = sd_segment_2d(q, vec2f(0.4 * gw, 0.0), vec2f(0.4 * gw, -1.4 * h));
      return min(stem, sd_segment_2d(q, vec2f(0.0, -h), vec2f(gw, -h)));
    }
  }
}

// Ink coverage of a block of text: lines `pitch` apart starting at `top`, from x0 to x1, with letters
// of x-height `h`. `seed` makes each block's words different; `rows` is how many lines there are.
fn fh_text(p: vec2f, x0: f32, x1: f32, top: f32, pitch: f32, h: f32, rows: f32, seed: i32, px: f32) -> f32 {
  let row = floor((p.y - top) / pitch);
  if (row < 0.0 || row >= rows || p.x < x0 || p.x > x1) {
    return 0.0;
  }
  let advance = 0.78 * h;
  let column = floor((p.x - x0) / advance);
  let r = i32(row);
  // Ragged right, and a short last line every few lines for a paragraph end.
  let paragraph_end = ihash_2to1(vec2i(r, seed)) < 0.16;
  let run = (x1 - x0) * select(1.0 - 0.08 * ihash_2to1(vec2i(r, seed + 1)), 0.35 + 0.4 * ihash_2to1(vec2i(r, seed + 2)), paragraph_end);
  if (p.x - x0 > run) {
    return 0.0;
  }
  let cell = vec3i(r, i32(column), seed);
  // A space about one letter in six.
  if (ihash_3to1(cell) < 0.17) {
    return 0.0;
  }
  let kind = i32(ihash_3to1(cell + vec3i(0, 0, 97)) * 9.0);
  let baseline = top + row * pitch + 0.72 * pitch;
  let gw = 0.56 * h;
  let q = vec2f(p.x - x0 - column * advance - 0.11 * advance, p.y - baseline);
  let stroke = 0.15 * h;
  return sd_coverage(fh_glyph(q, kind, gw, h) - 0.5 * stroke, px);
}

fn fh_page(p: vec2f, aspect: f32, px: f32) -> vec3f {
  var color = FH_PAPER;
  let margin = 0.09;
  let x0 = margin;
  let x1 = aspect - margin;
  // Headline, a rule under it, then the body.
  color = mix(color, FH_INK, fh_text(p, x0, min(x1, x0 + 1.25), 0.06, 0.1, 0.042, 1.0, 3, px));
  color = mix(color, FH_INK, 0.85 * fh_line(p, vec2f(x0, 0.185), vec2f(x1, 0.185), 0.003, px));
  let pitch = 0.034;
  let h = 0.0125;
  let top = 0.215;
  let rows = floor((0.94 - top) / pitch);
  if (aspect > 1.15) {
    let gap = 0.07;
    let mid = 0.5 * (x0 + x1);
    color = mix(color, FH_INK, fh_text(p, x0, mid - 0.5 * gap, top, pitch, h, rows, 11, px));
    // The second column: text above and below a framed bar chart.
    let c0 = mid + 0.5 * gap;
    let chart_top = top + 6.0 * pitch;
    let chart_rows = 9.0;
    let chart_bottom = chart_top + chart_rows * pitch;
    color = mix(color, FH_INK, fh_text(p, c0, x1, top, pitch, h, 6.0, 23, px));
    color = mix(color, FH_INK, fh_text(p, c0, x1, chart_bottom, pitch, h, rows - 6.0 - chart_rows, 29, px));
    let frame = sd_box_2d(p - vec2f(0.5 * (c0 + x1), 0.5 * (chart_top + chart_bottom)), vec2f(0.5 * (x1 - c0), 0.5 * (chart_bottom - chart_top)) - vec2f(0.0, 0.25 * pitch));
    color = mix(color, FH_INK, 0.8 * sd_coverage(abs(frame) - 0.0012, px));
    let inner = vec2f(c0 + 0.03, chart_bottom - 0.4 * pitch);
    let span = x1 - c0 - 0.06;
    for (var i = 0; i < 9; i++) {
      let x = inner.x + span * (f32(i) + 0.5) / 9.0;
      let tall = (chart_bottom - chart_top - 0.06) * (0.25 + 0.7 * ihash_2to1(vec2i(i, 41)));
      let bar = sd_box_2d(p - vec2f(x, inner.y - 0.5 * tall), vec2f(0.32 * span / 9.0, 0.5 * tall));
      color = mix(color, vec3f(0.62, 0.14, 0.05), sd_coverage(bar, px));
    }
  } else {
    color = mix(color, FH_INK, fh_text(p, x0, x1, top, pitch, h, rows, 11, px));
  }
  return color;
}

// ---- Brick wall ---------------------------------------------------------------------------------

fn fh_bricks(p: vec2f, aspect: f32, px: f32) -> vec3f {
  let size = vec2f(0.11, 0.045);
  let course = floor(p.y / size.y);
  let shifted = p.x / size.x + 0.5 * (course - 2.0 * floor(course * 0.5));
  let brick = vec2f(floor(shifted), course);
  let local = vec2f(fract(shifted) * size.x, fract(p.y / size.y) * size.y);
  let tone = ihash_2to2(vec2i(brick));
  var face = mix(vec3f(0.30, 0.085, 0.04), vec3f(0.46, 0.16, 0.07), tone.x);
  face *= 0.85 + 0.25 * tone.y;
  // Mortar: the distance to the nearest joint.
  let joint = min(min(local.x, size.x - local.x), min(local.y, size.y - local.y));
  var color = mix(vec3f(0.36, 0.34, 0.3), face, sd_coverage(0.004 - joint, px));

  // A window with a dark frame, four panes and a cross of glazing bars.
  let centre = vec2f(0.7 * aspect, 0.42);
  let half = vec2f(0.17, 0.22);
  let outer = sd_box_2d(p - centre, half + vec2f(0.02));
  color = mix(color, vec3f(0.06, 0.05, 0.045), sd_coverage(outer, px));
  let pane = sd_box_2d(p - centre, half);
  let sky = mix(vec3f(0.12, 0.2, 0.32), vec3f(0.02, 0.03, 0.06), clamp((p.y - centre.y + half.y) / (2.0 * half.y), 0.0, 1.0));
  let glint = 0.25 * sd_coverage(abs(p.x - centre.x + 0.6 * (p.y - centre.y) + 0.05) - 0.012, px);
  color = mix(color, sky + glint, sd_coverage(pane, px));
  let bars = min(abs(p.x - centre.x), abs(p.y - centre.y)) - 0.008;
  color = mix(color, vec3f(0.06, 0.05, 0.045), sd_coverage(max(bars, pane), px));
  // A sill under it and a lamp bracket beside it: horizontal and vertical edges to watch.
  let sill = sd_box_2d(p - vec2f(centre.x, centre.y + half.y + 0.035), vec2f(half.x + 0.05, 0.012));
  color = mix(color, vec3f(0.55, 0.53, 0.48), sd_coverage(sill, px));
  let lamp = vec2f(0.3 * aspect, 0.3);
  color = mix(color, vec3f(0.03), fh_line(p, lamp, lamp + vec2f(0.0, 0.12), 0.006, px));
  color = mix(color, vec3f(0.03), fh_line(p, lamp, lamp + vec2f(0.06, 0.0), 0.006, px));
  color = mix(color, vec3f(0.9, 0.75, 0.45), sd_coverage(length(p - lamp - vec2f(0.06, 0.03)) - 0.02, px));
  return color;
}

// ---- Test grid ----------------------------------------------------------------------------------

fn fh_grid_lines(p: vec2f, cell: f32, width: f32, px: f32) -> f32 {
  let d = abs(fract(p / cell + 0.5) - 0.5) * cell;
  return sd_coverage(min(d.x, d.y) - 0.5 * max(width, px), px);
}

fn fh_chart(p: vec2f, aspect: f32, px: f32) -> vec3f {
  let q = p - vec2f(0.5 * aspect, 0.5);
  var color = vec3f(0.035, 0.036, 0.045);
  color = mix(color, vec3f(0.16, 0.17, 0.2), 0.8 * fh_grid_lines(q, 1.0 / 36.0, 0.0, px));
  color = mix(color, vec3f(0.42, 0.43, 0.47), 0.9 * fh_grid_lines(q, 1.0 / 9.0, 0.002, px));
  for (var i = 1; i <= 4; i++) {
    let ring = abs(length(q) - 0.111111 * f32(i)) - 0.001;
    color = mix(color, vec3f(0.85, 0.83, 0.78), 0.85 * sd_coverage(ring, px));
  }
  let rising = fh_line(p, vec2f(0.0, 1.0), vec2f(aspect, 0.0), 0.002, px);
  let falling = fh_line(p, vec2f(0.0), vec2f(aspect, 1.0), 0.002, px);
  return mix(color, vec3f(0.95, 0.4, 0.08), 0.85 * max(rising, falling));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let aspect = picture.aspect;
  let p = in.uv * vec2f(aspect, 1.0);
  if (picture.style == 1u) {
    return vec4f(fh_bricks(p, aspect, picture.pixel), 1.0);
  }
  if (picture.style == 2u) {
    return vec4f(fh_chart(p, aspect, picture.pixel), 1.0);
  }
  return vec4f(fh_page(p, aspect, picture.pixel), 1.0);
}
