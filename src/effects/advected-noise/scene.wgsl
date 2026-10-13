#include "fullscreen.wgsl"
#include "advect.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

// Order of the strips, and the values of `variant`.
const SCROLL: i32 = 0;
const WARP: i32 = 1;
const FLOW: i32 = 2;
const CURL: i32 = 3;
const TWO_PHASE: i32 = 4;
const CURL_FLOW: i32 = 5;

const OCTAVES: i32 = 4;
// Noise in 0..1 times this is the heat at the base: about 0.58 on average, 1 only at the peaks.
const HEAT_GAIN: f32 = 1.15;
const DIVIDER = vec3f(0.11, 0.1, 0.09);
const LABEL = vec3f(0.5, 0.47, 0.43);

// One noise value in about +-0.75 for lattice position p, from the chosen way of moving it.
fn advected(variant: i32, p: vec2f) -> f32 {
  let drift = vec2f(0.0, params.drift * params.scale);
  switch variant {
    case WARP: {
      return advect_warp(p, drift, params.clock, params.warp, OCTAVES);
    }
    case FLOW: {
      return advect_flownoise(p, drift, params.spin, params.advection, OCTAVES);
    }
    case CURL: {
      return advect_curl(p, drift, params.clock, params.curl, OCTAVES);
    }
    case CURL_FLOW: {
      // The two cheap ideas composed: flow noise looked up at the curl-displaced position, turning
      // at half the rate of the flow strip because the displacement already changes it.
      let q = advect_curl_pos(p, drift, params.clock, params.curl);
      return advect_flownoise(q, vec2f(0.0), 0.5 * params.spin, params.advection, OCTAVES);
    }
    case TWO_PHASE: {
      return advect_twophase(p, drift, params.clock, params.flow, params.cycle, OCTAVES);
    }
    default: {
      return advect_scroll(p, drift, params.boil, OCTAVES);
    }
  }
}

// Which variant a cell of the layout shows. mode: 0 compare, 1 one variant, 2 split.
fn variant_of(cell: i32) -> i32 {
  if (params.mode == 0) {
    return cell;
  }
  return select(params.variant, SCROLL, params.mode == 2 && cell == 0);
}

// 3x5 pixel glyphs, 15 bits each, top-left pixel in bit 14. Nine per label.
const GLYPHS = array<u32, 54>(
  14478u, 14627u, 27565u, 31599u, 18727u, 18727u, 0u, 0u, 0u, // SCROLL
  23421u, 11245u, 27565u, 27556u, 0u, 0u, 0u, 0u, 0u, // WARP
  31140u, 18727u, 31599u, 23421u, 0u, 0u, 0u, 0u, 0u, // FLOW
  14627u, 23407u, 27565u, 18727u, 0u, 0u, 0u, 0u, 0u, // CURL
  25255u, 448u, 27556u, 23533u, 11245u, 14478u, 31143u, 0u, 0u, // 2-PHASE
  14627u, 23407u, 27565u, 18727u, 1488u, 31140u, 18727u, 31599u, 23421u, // CURL+FLOW
);
const LABEL_GLYPHS: i32 = 9;

// 1 where the label of `variant` covers the pixel `at` (pixels from the cell's top-left corner).
// Glyphs are 3 wide with a gap of 1; a label that does not fit its cell is left out.
fn label_mask(variant: i32, at: vec2f, cell_width: f32) -> f32 {
  let unit = params.labelPx;
  let columns = f32(LABEL_GLYPHS * 4 - 1);
  let g = floor((at - vec2f(3.0 * unit)) / max(unit, 1.0)); // in glyph pixels, after a margin
  let outside = g.x < 0.0 || g.y < 0.0 || g.x >= columns || g.y >= 5.0;
  if (unit <= 0.0 || cell_width < (columns + 6.0) * unit || outside) {
    return 0.0;
  }
  let column = i32(g.x) % 4;
  if (column == 3) {
    return 0.0;
  }
  var glyphs = GLYPHS;
  let bits = glyphs[clamp(variant, 0, 5) * LABEL_GLYPHS + i32(g.x) / 4];
  let bit = 14u - u32(i32(g.y) * 3 + column);
  return f32((bits >> bit) & 1u);
}

// Writes linear radiance into the HDR scene target; the tail turns it into canvas colour.
@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // The frame is cut into cells (strips side by side, or bands stacked when the frame is tall);
  // every cell shows the same patch of noise space with its own up axis.
  let cell_size = params.resolution / params.cells;
  let at = in.uv * params.resolution;
  let cell = min(floor(at / cell_size), params.cells - 1.0);
  let local = at - cell * cell_size;
  let variant = variant_of(i32(cell.x + cell.y));

  let up = 1.0 - local.y / cell_size.y;
  let p = vec2f(local.x - 0.5 * cell_size.x, cell_size.y - local.y) / cell_size.y * params.scale;

  // Hot at the base, cooling with height: noise minus a height ramp, as in `hello`. Above the
  // height where even the largest noise value is cancelled there is nothing to compute.
  var heat = 0.0;
  if (up * params.falloff < HEAT_GAIN) {
    let n = 0.5 + 0.5 * advected(variant, p);
    heat = clamp(n * HEAT_GAIN - up * params.falloff, 0.0, 1.0);
  }
  var color = ramp_fire(heat) * params.intensity;

  // Dividers on the boundaries between cells, and the labels.
  let nearest = round(at / cell_size);
  let between = (nearest >= vec2f(1.0)) & (nearest <= params.cells - 1.0);
  let gap = at - nearest * cell_size; // pixels past the boundary
  let on_line = between & (gap >= vec2f(0.0)) & (gap < vec2f(params.dividerPx));
  if (any(on_line)) {
    color = DIVIDER;
  }
  color = mix(color, LABEL, label_mask(variant, local, cell_size.x));
  return vec4f(color, 1.0);
}
