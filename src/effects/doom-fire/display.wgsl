// Doom fire, the part that is seen: the heat grid stretched over the canvas and coloured.
// Two fetches per pixel (the newest state and the one before it, blended by how far the frame is
// between two simulation steps), a ramp, and nothing else. Emission only: scene alpha stays 0 and
// the tail derives the canvas alpha from the light, so the page shows wherever the grid is cold.
#include "fullscreen.wgsl"
#include "ramp.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var heat_now: texture_2d<f32>;
@group(0) @binding(2) var heat_before: texture_2d<f32>;
// Linear, clamp-to-edge: the bilinear upsample is the sampler's.
@group(0) @binding(3) var heat_smp: sampler;
// 37 x 1: the original palette, one texel per heat level.
@group(0) @binding(4) var doom_palette: texture_2d<f32>;

const PALETTE_FIRE: i32 = 0;
const PALETTE_DOOM: i32 = 1;
const PALETTE_GAS: i32 = 2;
// Heat levels of the original; with `pixelated` the doom palette is not blended between them.
const DOOM_LEVELS: f32 = 37.0;

fn heat_at(uv: vec2f) -> f32 {
  var p = uv;
  if (params.pixelated > 0.5) {
    // The classic look: every pixel of a cell reads the cell's own centre.
    let size = vec2f(textureDimensions(heat_now));
    p = (floor(uv * size) + 0.5) / size;
  }
  let now = textureSampleLevel(heat_now, heat_smp, p, 0.0).r;
  let before = textureSampleLevel(heat_before, heat_smp, p, 0.0).r;
  return mix(before, now, params.blend);
}

fn colour_of(heat: f32) -> vec3f {
  let kind = i32(params.palette);
  if (kind == PALETTE_DOOM) {
    var h = clamp(heat, 0.0, 1.0);
    if (params.pixelated > 0.5) {
      h = round(h * (DOOM_LEVELS - 1.0)) / (DOOM_LEVELS - 1.0);
    }
    return ramp_lookup(doom_palette, heat_smp, h, 0);
  }
  if (kind == PALETTE_GAS) {
    return ramp_gas(heat);
  }
  return ramp_fire(heat);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let heat = heat_at(in.uv);
  // Most of the canvas is above the fire: nothing to colour there.
  if (heat <= 0.0) {
    return vec4f(0.0);
  }
  return vec4f(colour_of(heat) * params.intensity, 0.0);
}
