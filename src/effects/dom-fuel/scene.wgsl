// The page as fuel: draws the burn-front solver's state (src/gpu/sim/burn.ts) as an overlay on
// the elements whose rectangles were rasterised into its fuel map. The canvas cannot see the
// elements' pixels, so it never redraws them: it adds a glowing front, small flames rising off
// whatever is alight, and a dark scorch (real coverage) where fuel has burnt. Everything else is
// (0, 0, 0, 0) and the page shows through untouched.
//
// Three fetches per pixel and no noise: the fuel map (distance to the nearest element, and a
// static noise field the solver already baked), the state (heat for the front, char for the
// scorch) and the flames (licks.wgsl).
#include "fullscreen.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var state_tex: texture_2d<f32>;
@group(0) @binding(2) var map_tex: texture_2d<f32>;
@group(0) @binding(3) var grid_smp: sampler;
@group(0) @binding(4) var licks_tex: texture_2d<f32>;

const SCORCH_COLOR = vec3f(0.016, 0.011, 0.008);
// The stand-in cards drawn when the page has no marked elements.
const DEMO_COLOR = vec3f(0.075, 0.068, 0.062);
const DEMO_EDGE = vec3f(0.2, 0.18, 0.16);

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let m = textureSampleLevel(map_tex, grid_smp, in.uv, 0.0);
  // Nothing burns, glows or scorches further from an element than a flame can reach.
  if (m.r > params.reach) { return vec4f(0.0); }
  let inside = clamp(0.5 - m.r / params.pixel, 0.0, 1.0);

  let s = textureSampleLevel(state_tex, grid_smp, in.uv, 0.0);
  let lick = textureSampleLevel(licks_tex, grid_smp, in.uv, 0.0).r;

  // The front itself, a thin line on the element (squared, as in the paper effect), and the
  // flame above it, which has cooled as it climbed: orange, then red, then nothing. The flame
  // is never hotter than orange, so the line stays the brightest thing.
  let heat = clamp(s.g, 0.0, 1.0);
  let line = heat * heat * 0.9;
  let flame = lick * 0.72;
  let hot = min(max(line, flame), 1.0);
  let glow = ramp_fire(hot) * params.glow;

  var out = vec4f(0.0);
  // Stand-in cards, only when there is no DOM to burn: a dark panel with a lighter rim.
  if (params.demo > 0.5) {
    let rim = clamp(1.0 - abs(m.r) / (params.pixel * 1.5), 0.0, 1.0);
    out = vec4f(mix(DEMO_COLOR, DEMO_EDGE, rim), 1.0) * inside * 0.94;
  }

  // Scorch: where fuel has become char, darker at the cell-scale noise the map carries. It has
  // coverage, so it darkens a light element and a dark one alike, and it fades as the char does.
  let charred = clamp(s.b, 0.0, 1.0);
  let mark = smoothstep(0.02, 0.75, charred) * (0.86 + 0.14 * m.b);
  let scorch = clamp(mark * params.scorch, 0.0, 1.0) * inside;
  out = out * (1.0 - scorch) + vec4f(SCORCH_COLOR * scorch, scorch);

  return vec4f(out.rgb + glow, out.a);
}
