#include "fullscreen.wgsl"
#include "hash.wgsl"
#include "noise.wgsl"
#include "sdf.wgsl"
#include "firelight.wgsl"
#include "flicker.wgsl"
#include "params.wgsl"

// A dark stone page with a few cards on it, lit by one or two small flames. One fullscreen pass:
// read the baked ground (ground.wgsl), find the card under the pixel, then for each light take
// falloff * N.L * shadow from firelight.wgsl. Writes linear radiance; the tail does the rest.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var ground: texture_2d<f32>;

/// Depth of the ground relief in page units per relief unit, at relief = 1.
const RELIEF_DEPTH: f32 = 0.0075;
/// Width of the rounded shoulder at a card's edge, page units (capped by the corner radius).
const BEVEL: f32 = 0.011;
const BEVEL_SLOPE: f32 = 1.5;
/// Largest slow swing of a light's intensity at flicker = 1, as a fraction of full scale. Typical
/// swings are about a quarter of it either side of the mean (see flicker.wgsl).
const FLICKER_DEPTH: f32 = 0.6;

const STONE_A: vec3f = vec3f(0.165, 0.14, 0.12);
const STONE_B: vec3f = vec3f(0.13, 0.13, 0.142);
const CARD_ALBEDO: vec3f = vec3f(0.215, 0.205, 0.2);
const AMBIENT_TINT: vec3f = vec3f(0.5, 0.62, 1.0);

// Band-limited 1D value noise in [-1, 1]: one random value per unit of x, smoothly joined, so
// nothing in it is faster than half a cycle per unit.
fn slow_noise(x: f32, seed: f32) -> f32 {
  let i = floor(x);
  let f = x - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(hash_2to1(vec2f(i, seed)), hash_2to1(vec2f(i + 1.0, seed)), u) * 2.0 - 1.0;
}

// A light's brightness over time, around 1: the shared band-limited signal (flicker.wgsl), whose
// caps keep a light under the WCAG flash limit by construction. `seconds` must be real time or
// slower (index.ts sees to that), and both lights use the same rate so their sum is covered too.
fn light_flicker(seconds: f32, seed: f32) -> f32 {
  let s = flicker_clamp(
    flicker_settings(3.0, params.flicker * FLICKER_DEPTH, 0.03 * params.flicker, 13.0),
  );
  let mean = 1.0 - 0.5 * (s.depth + s.shimmer);
  return flicker_intensity(seconds, u32(abs(seed)), s) / mean;
}

// Unit vector pointing out of a rounded box at q (relative to its centre): the gradient of its SDF.
fn box_outward(q: vec2f, half_size: vec2f, radius: f32) -> vec2f {
  let r = clamp(radius, 0.0, min(half_size.x, half_size.y));
  let w = abs(q) - (half_size - vec2f(r));
  let s = select(vec2f(-1.0), vec2f(1.0), q >= vec2f(0.0));
  if (w.x > 0.0 && w.y > 0.0) {
    return normalize(w) * s;
  }
  return select(vec2f(0.0, s.y), vec2f(s.x, 0.0), w.x > w.y);
}

// Printed content, so a card reads as a card: a heading bar and lines of "text" in darker ink.
// q is relative to the card's centre; returns ink coverage 0..1.
fn card_ink(q: vec2f, half_size: vec2f, index: i32) -> f32 {
  let unit = params.unit;
  let pad = min(0.034 * unit, 0.45 * half_size.y);
  let size = 2.0 * (half_size - vec2f(pad));
  let l = q + half_size - vec2f(pad);
  var d = 1.0;
  if (size.y < 0.09 * unit) {
    // Too small for text: a button with one centred label.
    d = sd_rounded_box_2d(q, vec2f(size.x * 0.3, 0.006 * unit), 0.006 * unit);
  } else {
    let pitch = 0.036 * unit;
    let row = floor(l.y / pitch);
    let rows = floor(size.y / pitch);
    if (row >= 0.0 && row < rows && row != 1.0) {
      let heading = row == 0.0;
      let thick = select(0.0045, 0.008, heading) * unit;
      let width = size.x * select(0.5 + 0.48 * hash_2to1(vec2f(row, f32(index) + 0.5)), 0.5, heading);
      let centre = vec2f(0.5 * width, (row + 0.5) * pitch);
      d = sd_rounded_box_2d(l - centre, vec2f(0.5 * width, thick), thick);
    }
  }
  return sd_coverage(d, params.texel);
}

// Colour of the flame itself by heat 0..1: a wide dim red-orange rim, a yellow body, a pale core.
// HDR: the rim is below about 2.5, the body 3 to 10, the core up to about 28. (Through a filmic
// tonemap only the rim can stay orange: anything this bright goes yellow and then white.)
fn flame_colour(heat: f32, tint: vec3f) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let rim = vec3f(1.0, 0.11, 0.01) * 2.2;
  let body = mix(vec3f(1.0, 0.36, 0.05), tint, 0.3) * 8.0;
  let core = vec3f(1.0, 0.85, 0.56) * 28.0;
  let low = mix(rim * smoothstep(0.0, 0.2, h), body, smoothstep(0.25, 0.62, h));
  return mix(low, core, smoothstep(0.66, 1.0, h));
}

// A small teardrop flame standing at the light: q is the pixel relative to the light (page space,
// y down), `size` its half width. Returns radiance.
fn flame_glyph(q: vec2f, size: f32, seconds: f32, seed: f32, tint: vec3f) -> vec3f {
  let up = -q.y / size + 0.75;
  // Most pixels are nowhere near a flame: leave before any noise is evaluated.
  if (up < 0.0 || up > 4.2 || abs(q.x) > size * 1.8) {
    return vec3f(0.0);
  }
  let tall = 3.6 + 0.5 * slow_noise(seconds * 2.3, seed + 5.0);
  let y = clamp(up / tall, 0.0, 1.0);
  // The tongue sways more towards the tip, and the sway travels upwards.
  let sway = gnoise_2d(vec2f(up * 0.9 - seconds * 2.6, seed)) * 0.42 * y * y
    + slow_noise(seconds * 1.3, seed + 9.0) * 0.3 * y;
  let x = q.x / size - sway;
  // Half width along the height: a round base swelling to its widest low down, then a long taper.
  let width = sqrt(clamp(y * 7.0, 0.0, 1.0)) * pow(1.0 - y, 0.85) * 1.25 + 1e-4;
  let across = 1.0 - abs(x) / width;
  if (across <= 0.0 || up <= 0.0) {
    return vec3f(0.0);
  }
  // Hottest on the axis a little above the base; the tip cools.
  let along = smoothstep(0.0, 0.1, y) * (1.0 - 0.75 * smoothstep(0.25, 1.0, y));
  let heat = pow(across, 1.4) * (0.4 + 0.6 * along);
  return flame_colour(heat, tint);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  let p = in.uv * vec2f(params.aspect, 1.0);
  let texel = textureLoad(ground, vec2i(in.position.xy), 0);
  var occ = FirelightOccluders(params.occluder_count, params.rects, params.corners);

  // The nearest card, and how much of the pixel it covers.
  var edge = 1e6;
  var nearest = 0;
  for (var i = 0; i < params.occluder_count; i++) {
    let d = sd_rounded_box_2d(p - occ.rects[i].xy, occ.rects[i].zw, occ.corners[i].x);
    if (d < edge) {
      edge = d;
      nearest = i;
    }
  }
  let on_card = sd_coverage(edge, params.texel);

  // Ground: the baked flagstones. Contact darkening where it meets a card, so the card sits on it.
  let occlusion = mix(0.45, 1.0, smoothstep(0.0, 0.022 * params.unit, edge));
  var albedo = mix(STONE_A, STONE_B, texel.a) * texel.b;
  var gradient = texel.xy * (RELIEF_DEPTH * params.unit * params.relief);
  var gloss = 24.0;
  var sheen = 0.05;
  if (on_card > 0.0) {
    // Card: a flat top with a rounded shoulder. The height rises inwards over the bevel, so its
    // gradient points against the outward direction.
    let rect = occ.rects[nearest];
    let corner = occ.corners[nearest].x;
    let q = p - rect.xy;
    let bevel = max(min(BEVEL * params.unit, corner), 1e-4);
    let shoulder = 1.0 - clamp(-edge / bevel, 0.0, 1.0);
    let top = CARD_ALBEDO * (0.95 + 0.05 * texel.b) * mix(1.0, 0.42, card_ink(q, rect.zw, nearest));
    albedo = mix(albedo, top, on_card);
    gradient = mix(gradient, -box_outward(q, rect.zw, corner) * shoulder * BEVEL_SLOPE, on_card);
    gloss = mix(gloss, 48.0, on_card);
    sheen = mix(sheen, 0.12, on_card);
  }
  let normal = firelight_normal(gradient, 1.0);

  let tint = firelight_tint(params.warmth);
  // Shadow length 1 means the cards are walls; below that they are that fraction of the light's
  // height, and their shadows end.
  let reach = select(
    firelight_reach(params.shadow_length * params.height, params.height, params.source),
    FIRELIGHT_WALLS,
    params.shadow_length >= 0.999,
  );
  var radiance = albedo * AMBIENT_TINT * params.ambient * mix(occlusion, 1.0, on_card);
  var flames = vec3f(0.0);

  for (var i = 0; i < params.light_count; i++) {
    let light = params.lights[i];
    let flicker = light_flicker(params.flicker_time, light.z);
    let s = firelight_disc(p, light.xy, params.source, params.height, params.radius);
    if (s.atten > 0.0) {
      var shadow = 1.0;
      if (on_card < 1.0) {
        // Cards are all the same height, so they shadow the ground but not each other's tops.
        shadow = firelight_shadow(params.shadow_mode, p, s.pos, s.spread, reach, &occ, -1);
        shadow = mix(shadow * mix(1.0, occlusion, 0.5), 1.0, on_card);
      }
      let lobe = firelight_sheen(normal, s.dir, gloss) * sheen;
      radiance += tint * (params.intensity * flicker * s.atten * shadow)
        * (albedo * firelight_diffuse(normal, s.dir) + lobe);
    }
    // The flame itself; brighter and taller with the light's flicker.
    let size = clamp(params.source * 1.1, 0.014 * params.unit, 0.08);
    flames += flame_glyph(p - light.xy, size, params.time + light.w, light.z, tint)
      * (0.75 + 0.25 * flicker);
  }

  return vec4f(radiance + flames, 1.0);
}
