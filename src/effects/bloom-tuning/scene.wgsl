// Bloom test chart: hot shapes at KNOWN radiance on black, so a bloom setting can be judged by eye
// and by number. "Radiance" here is the brightest channel, which is what the bloom threshold tests;
// every fire-coloured element is CHART_TINT times its stated radiance. 1.0 is paper white.
//
//   strip      bottom: 0.5 at the left to 50 at the right, logarithmic, with ticks under
//              0.5, 1, 2, 5, 10, 20 and 50 (the tall tick is 1.0, the default threshold)
//   filaments  top left: three 1.5 px wires at 4, 12 and 40
//   blob       left: a soft Gaussian ball peaking at 12, and beside it a hard-edged disc at 12
//   sparks     right: 1 to 2.5 px dots between 8 and 60, drifting upwards
//   white      top right: a neutral square at exactly 1.0, which should not glow
#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

const CHART_TINT = vec3f(1.0, 0.36, 0.08);
const CHART_TICKS = array<f32, 7>(0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0);

// Coverage of a shape whose edge is `d` pixels away (negative inside), one pixel of anti-aliasing.
fn chart_aa(d: f32) -> f32 {
  return clamp(0.5 - d, 0.0, 1.0);
}

// Radiance of the strip at s in 0..1: 0.5 * 100^s.
fn chart_strip(s: f32) -> f32 {
  return 0.5 * pow(100.0, s);
}

// Where radiance L sits on the strip, 0..1.
fn chart_strip_pos(radiance: f32) -> f32 {
  return log(radiance / 0.5) / log(100.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let res = params.resolution;
  let px = in.position.xy;
  let uv = in.uv;
  // Sizes that should stay a sensible number of pixels at any canvas size.
  let unit = min(res.x, res.y);
  var radiance = vec3f(0.0);

  // --- Strip and ticks ---------------------------------------------------------------------------
  let strip_lo = 0.06;
  let strip_w = 0.88;
  let s = (uv.x - strip_lo) / strip_w;
  if (s >= 0.0 && s <= 1.0) {
    if (uv.y > 0.80 && uv.y < 0.88) {
      radiance = CHART_TINT * chart_strip(s);
    }
    for (var i = 0; i < 7; i++) {
      let tick = strip_lo + strip_w * chart_strip_pos(CHART_TICKS[i]);
      let tall = select(0.925, 0.95, i == 1);
      if (uv.y > 0.90 && uv.y < tall) {
        radiance += vec3f(0.35) * chart_aa(abs(uv.x - tick) * res.x - 1.0);
      }
    }
  }

  // --- Filaments: three thin wires, slowly waving --------------------------------------------------
  let wire_radiance = array<f32, 3>(4.0, 12.0, 40.0);
  if (uv.x > 0.05 && uv.x < 0.56 && uv.y < 0.42) {
    for (var i = 0; i < 3; i++) {
      let fi = f32(i);
      let phase = params.time * (0.35 + 0.1 * fi) + fi * 2.1;
      let centre = 0.10 + 0.11 * fi + 0.028 * sin(uv.x * (9.0 + 3.0 * fi) + phase);
      let slope = 0.028 * (9.0 + 3.0 * fi) * cos(uv.x * (9.0 + 3.0 * fi) + phase) * res.y / res.x;
      // Distance to the curve in pixels, corrected for its slope so the wire keeps its width.
      let d = abs(uv.y - centre) * res.y / sqrt(1.0 + slope * slope);
      let ends = smoothstep(0.05, 0.08, uv.x) * smoothstep(0.56, 0.53, uv.x);
      radiance += CHART_TINT * wire_radiance[i] * chart_aa(d - 0.75) * ends;
    }
  }

  // --- Blob (soft) and disc (hard), both peaking at 12 ---------------------------------------------
  let blob_centre = vec2f(0.17, 0.58) * res;
  let blob_r = 0.085 * unit;
  let bd = (px - blob_centre) / blob_r;
  radiance += CHART_TINT * 12.0 * exp(-dot(bd, bd) * 2.2) * step(dot(bd, bd), 4.0);
  let disc_centre = vec2f(0.17, 0.58) * res + vec2f(0.26 * unit, 0.0);
  radiance += CHART_TINT * 12.0 * chart_aa(length(px - disc_centre) - 0.055 * unit);

  // --- Sparks: one per cell of a coarse grid, rising, each with its own size and radiance ----------
  if (uv.x > 0.58 && uv.y < 0.74) {
    let cells = vec2f(7.0, 5.0);
    let area_lo = vec2f(0.60, 0.04);
    let area = vec2f(0.36, 0.68);
    let local = (uv - area_lo) / area;
    for (var j = -1; j <= 0; j++) {
      let column = floor(local.x * cells.x);
      let h = hash_2to3(vec2f(column, 7.0));
      // Each column scrolls at its own speed; y wraps so a spark leaving the top returns below.
      let scroll = params.time * (0.02 + 0.05 * h.x);
      let row = floor(local.y * cells.y + scroll * cells.y) + f32(j);
      let cell = vec2f(column, row);
      let r = hash_2to3(cell + vec2f(3.0, 11.0));
      let r2 = hash_2to1(cell + vec2f(19.0, 5.0));
      let centre_local = vec2f((column + 0.2 + 0.6 * r.x) / cells.x, (row + 0.2 + 0.6 * r.y) / cells.y - scroll);
      let centre_px = (area_lo + centre_local * area) * res;
      let radius = 0.5 + 1.0 * r.z + 0.0012 * unit;
      let level = 8.0 * pow(7.5, r2);
      // Fade at the top and bottom of the area so sparks do not pop in and out.
      let fade = smoothstep(0.0, 0.12, centre_local.y) * smoothstep(1.0, 0.88, centre_local.y);
      radiance += CHART_TINT * level * fade * chart_aa(length(px - centre_px) - radius);
    }
  }

  // --- Paper white: must not glow at the default threshold ----------------------------------------
  let white = abs(px - vec2f(0.5 * res.x + 0.02 * unit, 0.58 * res.y)) - vec2f(0.045 * unit);
  radiance += vec3f(1.0) * chart_aa(max(white.x, white.y));

  return vec4f(radiance, 1.0);
}
