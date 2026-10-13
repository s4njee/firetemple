#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "sdf.wgsl"
#include "backdrop-params.wgsl"

// The thing behind the haze, drawn ONCE into a texture (and again when the canvas is resized or
// the style changes). It stands in for content a real page would re-render or upload: a wireframe
// article with greeked text, rules and a gridded figure, or a plain test chart. Everything in it
// is a straight edge, because straight edges are what make refraction easy to judge.
//
// Output is linear "page" colour, at or below 1.0 (paper white); the target is rgba8unorm-srgb.

@group(0) @binding(0) var<uniform> backdrop_params: BackdropParams;

struct BdPalette {
  page: vec3f,
  card: vec3f,
  ink: vec3f,
  faint: vec3f,
  line: vec3f,
  accent: vec3f,
}

fn bd_palette(light: bool) -> BdPalette {
  if (light) {
    return BdPalette(
      vec3f(0.90, 0.87, 0.82),
      vec3f(0.97, 0.955, 0.93),
      vec3f(0.035, 0.032, 0.035),
      vec3f(0.36, 0.34, 0.33),
      vec3f(0.62, 0.59, 0.56),
      vec3f(0.62, 0.11, 0.015),
    );
  }
  return BdPalette(
    vec3f(0.0105, 0.0100, 0.0125),
    vec3f(0.022, 0.021, 0.025),
    vec3f(0.78, 0.76, 0.72),
    vec3f(0.20, 0.19, 0.19),
    vec3f(0.085, 0.082, 0.088),
    vec3f(0.95, 0.36, 0.07),
  );
}

// Greeked text: lines of words made of letter-sized blocks, some with ascenders and descenders,
// ragged right, in paragraphs of `paragraph` lines with a short last line and a blank line after.
// `origin` is the top-left corner and `size` the extent of the block; `line_height` the leading.
fn bd_text(
  p: vec2f,
  origin: vec2f,
  size: vec2f,
  line_height: f32,
  paragraph: i32,
  seed: i32,
  px: f32,
) -> f32 {
  let local = p - origin;
  if (local.x < 0.0 || local.y < 0.0 || local.x > size.x || local.y > size.y) {
    return 0.0;
  }
  let row = i32(floor(local.y / line_height));
  let rows = i32(floor(size.y / line_height));
  let in_paragraph = row % (paragraph + 1);
  if (row >= rows || in_paragraph == paragraph) {
    return 0.0;
  }
  var reach = size.x * (0.84 + 0.16 * ihash_2to1(vec2i(row, seed)));
  if (in_paragraph == paragraph - 1 || row == rows - 1) {
    reach = size.x * (0.25 + 0.45 * ihash_2to1(vec2i(row, seed + 3)));
  }

  let letter = line_height * 0.34;
  let fy = fract(local.y / line_height);
  var cursor = 0.0;
  for (var word = 0; word < 40; word++) {
    let pick = ihash_2to1(vec2i(row * 97 + word, seed + 11));
    let letters = 1.0 + floor(pick * pick * 9.0);
    let width = letters * letter;
    if (cursor + width > reach || local.x < cursor) {
      break;
    }
    if (local.x < cursor + width) {
      let along = (local.x - cursor) / letter;
      let shape = ihash_3to1(vec3i(row, word * 16 + i32(floor(along)), seed));
      // x-height band, with one letter in four reaching up and one in seven hanging down.
      let top = select(0.34, 0.12, shape < 0.25);
      let bottom = select(0.74, 0.93, shape > 0.86);
      let d = vec2f(
        (abs(fract(along) - 0.5) - 0.37) * letter,
        (abs(fy - 0.5 * (top + bottom)) - 0.5 * (bottom - top)) * line_height,
      );
      return sd_coverage(max(d.x, d.y), px);
    }
    cursor += width + letter * 1.15;
  }
  return 0.0;
}

// Coverage of the lines of a square grid of pitch `cell`, each `width` wide (never thinner than
// a pixel).
fn bd_grid(p: vec2f, cell: f32, width: f32, px: f32) -> f32 {
  let d = abs(fract(p / cell + 0.5) - 0.5) * cell;
  return sd_coverage(min(d.x, d.y) - 0.5 * max(width, px), px);
}

fn bd_rule(p: vec2f, a: vec2f, b: vec2f, width: f32, px: f32) -> f32 {
  return sd_coverage(sd_segment_2d(p, a, b) - 0.5 * max(width, px), px);
}

fn bd_ring(p: vec2f, centre: vec2f, radius: f32, width: f32, px: f32) -> f32 {
  return sd_coverage(abs(sd_circle(p - centre, radius)) - 0.5 * max(width, px), px);
}

// A dark test chart: fine grid, heavier every fourth line, a few rings and diagonals.
fn bd_chart(p: vec2f, aspect: f32, px: f32) -> vec3f {
  let colors = bd_palette(false);
  let centre = vec2f(0.5 * aspect, 0.5);
  let q = p - centre;
  var color = colors.page;
  color = mix(color, colors.line, 0.75 * bd_grid(q, 1.0 / 36.0, 0.0, px));
  color = mix(color, colors.faint, 0.85 * bd_grid(q, 1.0 / 9.0, 0.0015, px));
  for (var i = 1; i <= 3; i++) {
    color = mix(color, colors.ink, 0.8 * bd_ring(p, centre, 0.111111 * f32(i), 0.0018, px));
  }
  let rising = bd_rule(p, vec2f(0.0, 1.0), vec2f(aspect, 0.0), 0.0018, px);
  let falling = bd_rule(p, vec2f(0.0), vec2f(aspect, 1.0), 0.0018, px);
  return mix(color, colors.accent, 0.8 * max(rising, falling));
}

// The figure: a card with graph paper, a ring, a trend line and bars, and a caption under it.
fn bd_figure(base: vec3f, p: vec2f, lo: vec2f, hi: vec2f, colors: BdPalette, px: f32) -> vec3f {
  let centre = 0.5 * (lo + hi);
  let half = 0.5 * (hi - lo);
  let inset = 0.03;
  let edge = sd_rounded_box_2d(p - centre, half, 0.012);
  let inside = sd_coverage(edge, px);
  let q = p - lo;
  var color = mix(base, colors.card, inside);
  color = mix(color, colors.line, 0.55 * inside * bd_grid(q, 0.025, 0.0, px));
  color = mix(color, colors.line, inside * bd_grid(q, 0.1, 0.0016, px));
  color = mix(color, colors.faint, sd_coverage(abs(edge) - 0.5 * px, px));

  let ring = bd_ring(p, centre + vec2f(-0.3, -0.1) * half, 0.5 * min(half.x, half.y), 0.003, px);
  color = mix(color, colors.ink, inside * ring);
  let low = vec2f(lo.x + inset, hi.y - inset);
  let high = vec2f(hi.x - inset, lo.y + inset);
  let trend = bd_rule(p, low, high, 0.004, px);
  color = mix(color, colors.accent, inside * trend);

  let bars = 9.0;
  let slot = (2.0 * half.x - 2.0 * inset) / bars;
  let index = floor((p.x - lo.x - inset) / slot);
  if (index >= 0.0 && index < bars) {
    let tall = (0.15 + 0.6 * ihash_2to1(vec2i(i32(index), 71))) * half.y;
    let middle = vec2f(lo.x + inset + (index + 0.5) * slot, hi.y - inset - 0.5 * tall);
    let bar = sd_box_2d(p - middle, vec2f(0.3 * slot, 0.5 * tall));
    color = mix(color, colors.ink, 0.7 * inside * sd_coverage(bar, px));
  }

  let caption = bd_text(p, vec2f(lo.x, hi.y + 0.03), vec2f(2.0 * half.x, 0.34), 0.028, 3, 83, px);
  return mix(color, colors.faint, caption);
}

// A wireframe article: a nav row, a headline, body text, and (when there is room) a figure.
fn bd_article(p: vec2f, aspect: f32, light: bool, px: f32) -> vec3f {
  let colors = bd_palette(light);
  let margin = min(0.07, 0.08 * aspect);
  let right = aspect - margin;
  let wide = aspect > 1.25;
  let column = select(right - margin, aspect * 0.54 - margin, wide);
  var color = colors.page;

  // Nav: a mark, a few links, a hairline.
  let mark = sd_coverage(sd_circle(p - vec2f(margin + 0.012, 0.062), 0.012), px);
  let links_width = min(0.5, right - margin - 0.05);
  let links = bd_text(p, vec2f(margin + 0.045, 0.047), vec2f(links_width, 0.03), 0.03, 4, 5, px);
  color = mix(color, colors.accent, mark);
  color = mix(color, colors.faint, links);
  color = mix(color, colors.line, bd_rule(p, vec2f(margin, 0.105), vec2f(right, 0.105), 0.0, px));

  // Headline, standfirst, body.
  let headline = bd_text(p, vec2f(margin, 0.145), vec2f(column, 0.17), 0.085, 4, 21, px);
  let standfirst = bd_text(p, vec2f(margin, 0.335), vec2f(column * 0.8, 0.034), 0.034, 4, 33, px);
  let body = bd_text(p, vec2f(margin, 0.40), vec2f(column, 0.62), 0.0345, 5, 47, px);
  color = mix(color, colors.ink, headline);
  color = mix(color, colors.accent, standfirst);
  // Body text is a step quieter than the headline. On paper that takes far less transparency:
  // the mix is in linear light, where a little white lifts dark ink a long way.
  color = mix(color, colors.ink, select(0.82, 0.985, light) * body);

  if (wide) {
    color = bd_figure(color, p, vec2f(aspect * 0.60, 0.145), vec2f(right, 0.62), colors, px);
  }
  return color;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let aspect = backdrop_params.aspect;
  let p = in.uv * vec2f(aspect, 1.0);
  let px = backdrop_params.pixel;
  if (backdrop_params.style == 2u) {
    return vec4f(bd_chart(p, aspect, px), 1.0);
  }
  return vec4f(bd_article(p, aspect, backdrop_params.style == 1u, px), 1.0);
}
