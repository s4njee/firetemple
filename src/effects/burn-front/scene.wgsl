// Burning paper: draws the state of the burn-front solver (src/gpu/sim/burn.ts) as a sheet with
// real coverage. Unburnt paper is opaque, the front is a thin line of light where each cell is
// half burnt, char follows it and crumbles to nothing, and where nothing is left the pixel is
// (0, 0, 0, 0): the page shows through the hole.
//
// Three fetches per pixel: the shared noise tile (to roughen the edges and grain the paper), the
// state (bilinear, so the front moves smoothly between cells) and the fuel map (the sheet's edge).
// No procedural noise.
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var state_tex: texture_2d<f32>;
@group(0) @binding(2) var map_tex: texture_2d<f32>;
@group(0) @binding(3) var grid_smp: sampler;
@group(0) @binding(4) var noise_tex: texture_2d<f32>;
@group(0) @binding(5) var noise_smp: sampler;

const PATTERN_RULED: i32 = 1;
const PATTERN_PRINT: i32 = 2;

// Noise cells per canvas height for the edge and the grain of the paper.
const ROUGH_SCALE: f32 = 14.0;
// How far the noise pushes the state lookup, in grid cells: enough to break up the straight runs
// bilinear filtering leaves between cell centres.
const ROUGH_CELLS: f32 = 1.6;
const CHAR_COLOR = vec3f(0.012, 0.009, 0.008);
const ASH_COLOR = vec3f(0.11, 0.1, 0.095);
// What heat does to paper before it blackens.
const SCORCH_TINT = vec3f(0.5, 0.31, 0.15);

// Ink on the sheet, 0..1, so there is something on the paper to watch burn. p in canvas heights.
fn paper_ink(p: vec2f, width: f32) -> vec4f {
  let kind = i32(params.pattern);
  let aa = params.pixel * 1.5;
  if (kind == PATTERN_RULED) {
    // A notebook page: feint rules and a margin line.
    // Never closer than 26 pixels apart, or a short canvas turns them into a grey wash.
    let rules = min(17.0, 1.0 / (params.pixel * 26.0));
    let y = p.y * rules;
    let rule = 1.0 - smoothstep(0.0, aa * rules + 0.035, abs(fract(y) - 0.5));
    let margin = 1.0 - smoothstep(0.0, aa + 0.0022, abs(p.x - 0.14));
    let ink = mix(vec3f(0.16, 0.3, 0.62), vec3f(0.7, 0.1, 0.1), step(rule, margin));
    return vec4f(ink, max(rule * 0.55 * step(0.06, p.y), margin * 0.7));
  }
  if (kind == PATTERN_PRINT) {
    // Lines of "text": dashes of hashed length, with ragged right ends and paragraph breaks.
    // Lines at least 14 pixels apart, for the same reason.
    let rows = min(32.0, 1.0 / (params.pixel * 14.0));
    let row = floor(p.y * rows);
    let fy = fract(p.y * rows);
    let band = smoothstep(0.28, 0.28 + aa * rows, fy) * (1.0 - smoothstep(0.7 - aa * rows, 0.7, fy));
    let columns = rows * 2.2;
    let column = floor(p.x * columns);
    let fx = fract(p.x * columns);
    let letter = ihash_2to1(vec2i(i32(column), i32(row)));
    let line = ihash_2to1(vec2i(-7, i32(row)));
    let left = 0.1;
    let right = min(width - 0.1, left + (width - 0.2) * (0.55 + 0.45 * line));
    let inside = step(left, p.x) * step(p.x, right) * step(0.08, p.y) * step(p.y, 0.92);
    let paragraph = step(0.5, f32(i32(row) % 6));
    let glyph = step(0.2, letter) * smoothstep(0.08, 0.08 + aa * columns, fx);
    return vec4f(vec3f(0.07, 0.07, 0.09), band * glyph * inside * paragraph * 0.8);
  }
  return vec4f(0.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = vec2f(in.uv.x * params.aspect, in.uv.y);
  // rg: two fractal fields for the roughness; b: a finer one for fibres; a: grain.
  let n = noisetex_sample_lod(noise_tex, noise_smp, p * ROUGH_SCALE, params.lod);
  let rough = (n.rg - 0.5) * 2.0 * ROUGH_CELLS * params.cell;

  let s = textureSampleLevel(state_tex, grid_smp, in.uv + rough, 0.0);
  let fuel = clamp(s.r, 0.0, 1.0);
  let heat = clamp(s.g, 0.0, 1.0);
  let charred = clamp(s.b, 0.0, 1.0);

  // The sheet's own edge, from the distance the map keeps: sharp at any grid resolution.
  let distance_to_sheet = textureSampleLevel(map_tex, grid_smp, in.uv, 0.0).r;
  let sheet = clamp(0.5 - distance_to_sheet / params.pixel, 0.0, 1.0);
  if (sheet <= 0.0) { return vec4f(0.0); }

  // What is left here, paper and char together. It leaves along a ragged threshold, so the hole
  // has a torn edge, and comes back the same way when the paper regrows.
  let solid = clamp(fuel + charred, 0.0, 1.0);
  // Mostly the fine fractal field, stretched to fill 0..1; the value-noise grain alone tears in
  // square crumbs.
  let grain = clamp(0.5 + (n.b - 0.5) * 2.4 + (n.a - 0.5) * 0.45, 0.0, 1.0);
  let threshold = 0.12 + 0.45 * grain;
  let cover = smoothstep(threshold, threshold + 0.16, solid) * sheet;

  // Paper: its colour, a little fibre, whatever is printed on it.
  let ink = paper_ink(p, params.aspect);
  var paper = params.paper * (1.0 - params.fibre * (0.5 - n.b) * 0.9);
  paper = mix(paper, ink.rgb, ink.a);

  // How much of what is left is char: paper browns, then blackens. Char that is crumbling goes
  // from black to the grey of ash, which is what shows its edge against a dark page.
  let burnt = charred / max(solid, 1e-3);
  // Print survives as a faint sheen on the ash, as it does on a burnt page.
  let remains = mix(ASH_COLOR, CHAR_COLOR, smoothstep(0.35, 0.9, solid)) * (0.7 + 0.6 * n.b)
    + vec3f(0.02) * ink.a;
  var color = mix(paper, paper * SCORCH_TINT, smoothstep(0.0, 0.25, burnt));
  color = mix(color, remains, smoothstep(0.18, 0.6, burnt));

  // The front: heat peaks where a cell is half burnt, on the line between paper and char.
  // Squaring it keeps the line thin: a pale core with an orange and red fringe, not a white
  // band. Behind it the cooling char holds a few embers, picked out by the grain.
  let ember = mix(1.0, 0.3 + 1.2 * grain, smoothstep(0.5, 1.0, burnt));
  let hot = min(heat * heat * 0.92 * ember, 1.0);
  let glow = ramp_fire(hot) * params.glow * sheet;

  // Premultiplied: opaque matter where there is paper or char, light on top of it.
  return vec4f(color * cover + glow, cover);
}
