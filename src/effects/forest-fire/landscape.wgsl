// Draws the forest-fire automaton (src/gpu/sim/forest.ts) as a map seen from above.
//
// The state is a small grid: fuel, burning, scorch and smoke per cell. Per pixel this reads the
// noise tile twice (the lie of the land, and a fine grain) and the state as a smooth surface: a
// quadratic B-spline through the cells of between.wgsl's output, which is already blended between
// the last two steps. So nothing in the picture jumps at the step rate or shows as squares.
#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "ramp.wgsl"
#include "forest-land.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var state_tex: texture_2d<f32>;
@group(0) @binding(3) var state_smp: sampler;
@group(0) @binding(4) var noise_tex: texture_2d<f32>;
@group(0) @binding(5) var noise_smp: sampler;

const PALETTE_FOREST: i32 = 0;
const PALETTE_EMBERS: i32 = 1;
const PALETTE_NIGHT: i32 = 2;

// Noise cells of grain per canvas height.
const GRAIN_SCALE: f32 = 26.0;

fn state_tap(uv: vec2f) -> vec4f {
  return textureSampleLevel(state_tex, state_smp, uv, 0.0);
}

fn state_at(uv: vec2f) -> vec4f {
  if (params.pixelated > 0.5) {
    let cell = clamp(vec2i(uv * params.size), vec2i(0), vec2i(params.size) - 1);
    return textureLoad(state_tex, cell, 0);
  }
  // Four bilinear taps half a cell apart are a quadratic B-spline: smooth in value and in slope,
  // so a front one cell wide is a line and not a string of diamonds.
  let h = 0.5 / params.size;
  return 0.25 * (
    state_tap(uv + vec2f(h.x, h.y)) + state_tap(uv + vec2f(-h.x, h.y)) +
    state_tap(uv + vec2f(h.x, -h.y)) + state_tap(uv + vec2f(-h.x, -h.y)));
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = vec2f(in.uv.x * params.aspect, in.uv.y);
  let fine = noisetex_sample_lod(noise_tex, noise_smp, p * GRAIN_SCALE, params.grain_lod);
  let land = forest_land(noise_tex, noise_smp, in.uv, params.aspect, params.terrain, params.land_offset);

  // The lookup is nudged by the grain (up to 0.6 of a cell), which roughens every edge the grid
  // would otherwise draw straight.
  let nudge = (fine.rg - 0.5) * 1.2 / params.size * (1.0 - params.pixelated);
  let s = state_at(in.uv + nudge);
  let fuel = s.r;
  let burning = s.g;
  let scorch = s.b;
  let smoke = s.a;
  let grain = fine.b;
  let palette = i32(params.palette);

  var ground: vec3f;
  var veil_color: vec3f;
  var fire: vec3f;
  // Burning peaks near 0.55 in a cell of full fuel; the B-spline takes about a third off a thin
  // front. Shaped so a strong front reaches the pale end of the ramp and the cooling tail is red.
  let heat = clamp(pow(burning * 2.6, 0.8), 0.0, 1.0);

  if (palette == PALETTE_EMBERS) {
    // Fuel as a neutral dark texture; what burns is the picture.
    ground = vec3f(0.007, 0.007, 0.008) + vec3f(0.036, 0.031, 0.028) * fuel * (0.45 + 1.1 * grain);
    ground *= 1.0 - 0.9 * smoothstep(0.0, 0.7, scorch);
    ground = mix(ground, vec3f(0.003, 0.004, 0.006), land.y);
    veil_color = vec3f(0.055, 0.048, 0.045);
    fire = ramp_whiten(ramp_blackbody(heat, 800.0, 1900.0), 6.0);
  } else {
    var soil = vec3f(0.060, 0.047, 0.033);
    var grass = vec3f(0.046, 0.066, 0.022);
    var trees = vec3f(0.008, 0.034, 0.015);
    var char_color = vec3f(0.007, 0.006, 0.006);
    var ash = vec3f(0.030, 0.028, 0.027);
    var water = vec3f(0.008, 0.020, 0.036);
    veil_color = vec3f(0.11, 0.108, 0.105);
    if (palette == PALETTE_NIGHT) {
      soil = vec3f(0.020, 0.022, 0.030);
      grass = vec3f(0.016, 0.028, 0.030);
      trees = vec3f(0.004, 0.012, 0.016);
      char_color = vec3f(0.003, 0.003, 0.004);
      ash = vec3f(0.022, 0.022, 0.026);
      water = vec3f(0.010, 0.018, 0.034);
      veil_color = vec3f(0.050, 0.052, 0.060);
    }
    // Thin soil on high ground shows through as bare earth.
    let thin = 1.0 - smoothstep(0.3, 0.75, land.x);
    ground = mix(soil, grass, smoothstep(0.04, 0.42, fuel) * (1.0 - 0.6 * thin));
    ground = mix(ground, trees, smoothstep(0.42, 0.9, fuel));
    // The grain reads as canopy over trees and as tussocks over grass.
    ground *= 0.62 + 0.76 * grain;
    // Fresh scorch is black; as it fades the ground is ash-grey before the green comes back.
    let fresh = smoothstep(0.0, 0.75, scorch);
    ground = mix(ground, char_color * (0.7 + 0.6 * grain), fresh);
    ground = mix(ground, ash * (0.5 + grain), 0.5 * scorch * (1.0 - scorch) * 4.0 * (1.0 - fresh));
    ground = mix(ground, water * (0.8 + 0.4 * fine.r), land.y);
    fire = ramp_fire(heat);
  }

  // Smoke lies over the ground and is lit from below where it stands over the fire.
  let veil = 1.0 - exp(-1.8 * params.smoke * smoke);
  let lit = veil_color + ramp_fire(0.42).rgb * 0.3 * heat;
  var color = mix(ground, lit, veil);
  color += fire * params.intensity * (1.0 - 0.45 * veil);
  return vec4f(color, 1.0);
}
