#include "fullscreen.wgsl"
#include "noisetex.wgsl"
#include "sdf.wgsl"
#include "flame.wgsl"
#include "params.wgsl"

// Cartoon fire: flat bands of colour with hard edges, an ink outline, a couple of logs and a few
// square sparks. One pass into the HDR scene target, PREMULTIPLIED with real coverage in alpha:
// the shapes are opaque paint, not light, which is what lets them sit on a light page.
//
// Everything is a distance field. The flame is one to three teardrops (flame.wgsl) joined with a
// smooth minimum; the bands are the same field pushed inward by a fixed inset each, so every band
// is a smaller flame inside the last. Two fetches of the shared noise tile move it: one read along
// a vertical line bends the tongues, the other pushes each band's edge in and out as it rises.
// `params.time` is already stepped (stepped.ts), so the drawing holds still between steps.

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var noise_tex: texture_2d<f32>;
@group(0) @binding(2) var noise_smp: sampler;

// The noise is read from a coarse level of the tile: the fine octaves are averaged away there,
// which is what makes the shapes bold instead of frilly. Level 3 is 32 texels, 4 per noise cell.
const TF_NOISE_LEVEL: f32 = 3.0;
const TF_NOISE_SIZE: f32 = 32.0;
// Noise cells per flame height across the flame; the cells are twice as tall as wide.
const TF_LICK_CELLS: f32 = 2.8;
// How fast the two noise fields climb, in noise cells per second. Slow on purpose: at ten
// drawings a second a feature should move about a quarter of its own size per drawing, or each
// drawing looks unrelated to the last (and a large bright shape changing that much is a flash).
const TF_LICK_RISE: f32 = 0.7;
const TF_BEND_RISE: f32 = 0.5;

const TF_BARK = vec3f(0.2, 0.082, 0.032);
const TF_BARK_LIGHT = vec3f(0.36, 0.16, 0.058);
const TF_CUT = vec3f(0.66, 0.42, 0.2);

// The tile at `p` (noise cells), with the blend between texels eased (smoothstep instead of
// linear). Plain bilinear filtering of a magnified texture has a crease along every texel edge,
// and a hard threshold turns each crease into a corner in the outline. One fetch.
fn tf_noise(p: vec2f) -> vec4f {
  let st = noisetex_uv(p) * TF_NOISE_SIZE - vec2f(0.5);
  let cell = floor(st);
  let f = st - cell;
  let eased = f * f * (vec2f(3.0) - 2.0 * f);
  return textureSampleLevel(
    noise_tex,
    noise_smp,
    (cell + eased + vec2f(0.5)) / TF_NOISE_SIZE,
    TF_NOISE_LEVEL,
  );
}

// `source` painted over `under`, both premultiplied.
fn tf_over(under: vec4f, source: vec4f) -> vec4f {
  return source + under * (1.0 - source.a);
}

// One log: a capsule lying at `angle`, with a lighter top and a sawn end. Premultiplied.
fn tf_log(q: vec2f, centre: vec2f, angle: f32, half_length: f32, radius: f32, aa: f32) -> vec4f {
  let c = cos(angle);
  let s = sin(angle);
  let rel = q - centre;
  let local = vec2f(c * rel.x + s * rel.y, -s * rel.x + c * rel.y);
  let d = sd_rounded_box_2d(local, vec2f(half_length, radius), radius);
  let ink = params.outline * 0.75;
  let cover = sd_coverage(d - ink, aa);
  if (cover <= 0.0) {
    return vec4f(0.0);
  }
  var color = params.colors[0].rgb;
  let bark = mix(TF_BARK, TF_BARK_LIGHT, sd_coverage(0.2 * radius - local.y, aa));
  color = mix(color, bark, sd_coverage(d, aa));
  // The sawn end: a pale disc with one ring.
  let face = length(local - vec2f(half_length - radius, 0.0));
  color = mix(color, TF_CUT, sd_coverage(face - 0.72 * radius, aa));
  color = mix(color, TF_BARK, sd_coverage(abs(face - 0.36 * radius) - 0.07 * radius, aa));
  return vec4f(color * cover, cover);
}

// Can the flame, with all its sway and licks, reach q at all? An outline of everywhere it could
// be, a dozen ALU operations, tested before either fetch: most of the picture's bounding box is
// empty air, and this keeps the fetches to the pixels near the fire. The bound is exact, not a
// guess: level 3 of the noise tile stays inside 0.17 .. 0.86 (read back from the texture), so
//   the bend is at most   2.4 * sway * w * tip * 0.72        <= 1.75 * sway * w * tip
//   a lick grows it by    3.4 * lick * w * (0.15 + t) * 0.31  <= 1.05 * lick * w * (0.15 + t)
// and the smooth join of the tongues adds at most a quarter of its blend width, 0.09 w.
fn tf_near(q: vec2f, t: f32, aa: f32) -> bool {
  let w = params.width;
  let slack = (1.75 * params.sway * t * sqrt(t) + 1.05 * params.lick * (0.15 + t) + 0.09) * w +
    params.outline + 2.0 * aa;
  if (q.y < -slack || q.y > 1.0 + slack) {
    return false;
  }
  // The main teardrop: full width up to its widest point, then straight in to the tip.
  var half = w * clamp((1.0 - q.y) / (1.0 - 1.6 * w), 0.0, 1.0);
  if (params.spread > 0.0 && q.y < 0.68 + slack) {
    // The side tongues: their axes lean outward as they rise.
    half = max(half, (0.92 * w + 0.3 * q.y) * params.spread + 0.66 * w);
  }
  return abs(q.x) < half + slack;
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Flame space: origin at the middle of the flame's base, y up, one unit = the flame's height.
  let p = vec2f(in.uv.x * params.aspect, 1.0 - in.uv.y);
  let q = (p - params.origin) / params.size;
  if (abs(q.x) > params.reach.x || q.y < -params.reach.y || q.y > params.reach.z) {
    return vec4f(0.0);
  }
  let aa = 1.5 * params.pixel / params.size;
  let w = params.width;
  let t = clamp(q.y, 0.0, 1.0);
  // Everything moves more toward the tip and not at all at the base.
  let tip = t * sqrt(t);

  var paint = vec4f(0.0);

  // Sparks: little diamonds that leave the flame, drift and shrink. Where each one is this
  // drawing is worked out on the CPU (sparks.ts), so a pixel only measures its distance to them.
  // Drawn first, so the flame hides them until they are clear of it.
  let sparks = select(0, i32(params.sparks), q.y > 0.36 && q.y < 1.4 && abs(q.x) < params.reach.w);
  for (var i = 0; i < sparks; i++) {
    let spark = params.spark[i];
    let d = abs(q.x - spark.x) + abs(q.y - spark.y) - spark.z;
    let cover = sd_coverage(d, aa);
    paint = tf_over(paint, vec4f(params.colors[3].rgb * cover, cover));
  }

  if (tf_near(q, t, aa)) {
    // The flame. Fetch one: three slow values per height, rising, one for each tongue.
    let bend = (tf_noise(vec2f(2.3, q.y * 1.3 - params.time * TF_BEND_RISE)).rgb * 2.0 - vec3f(1.0)) *
      (2.4 * params.sway * w * tip);
    var d = flame_sd_teardrop(vec2f(q.x - bend.r, q.y), w, 1.0);
    if (params.spread > 0.0) {
      // Two shorter tongues beside the main one, leaning away from it.
      let offset = 0.92 * w * params.spread;
      let lean = 0.3 * params.spread * q.y;
      let left = flame_sd_teardrop(vec2f(q.x + offset + lean - 0.7 * bend.g, q.y), 0.66 * w, 0.68);
      let right = flame_sd_teardrop(vec2f(q.x - offset - lean - 0.7 * bend.b, q.y), 0.66 * w, 0.6);
      d = smin_poly(d, min(left, right), 0.35 * w);
    }

    // A lick can push the outline out by at most this much (the bound of tf_near). Further from
    // the bent flame than that there is nothing to draw, and the second fetch is skipped.
    let lick_reach = 1.05 * params.lick * w * (0.15 + t) + params.outline + aa;
    if (d < lick_reach) {
      // Fetch two: the licks. Each band gets its own channel, so the inner flames do not simply
      // copy the outline.
      let lick = (tf_noise(vec2f(
        q.x * TF_LICK_CELLS + 1.7,
        q.y * TF_LICK_CELLS * 0.5 - params.time * TF_LICK_RISE,
      )).rgb - vec3f(0.48)) * (3.4 * params.lick * w * (0.15 + t));

      // Insets shrink toward the base, so the inner flames sit low and share its foot.
      let hug = w * (0.45 + 0.55 * smoothstep(0.0, 1.6 * w, q.y));
      let gap = 0.1 * w;
      let d0 = d + lick.r;
      let d1 = max(d + lick.g + 0.36 * hug, d0 + gap);
      let d2 = max(d + lick.b + 0.64 * hug, d1 + gap);
      let d3 = max(d + lick.r + 0.86 * hug, d2 + gap);

      let cover = sd_coverage(d0 - params.outline, aa);
      if (cover > 0.0) {
        var color = mix(params.colors[0].rgb, params.colors[1].rgb, sd_coverage(d0, aa));
        color = mix(color, params.colors[2].rgb, sd_coverage(d1, aa));
        if (params.bands >= 3.0) {
          color = mix(color, params.colors[3].rgb, sd_coverage(d2, aa));
        }
        if (params.bands >= 4.0) {
          color = mix(color, params.colors[4].rgb, sd_coverage(d3, aa));
        }
        paint = tf_over(paint, vec4f(color * cover, cover));
      }
    }
  }

  if (params.logs > 0.5) {
    let half_length = 2.1 * w;
    let radius = 0.3 * w;
    let lift = vec2f(0.0, 0.1 * w);
    paint = tf_over(paint, tf_log(q, lift + vec2f(0.12 * w, 0.0), -0.24, half_length, radius, aa));
    // The second log is the mirror image of the first, laid across it.
    let mirrored = vec2f(-q.x, q.y);
    paint = tf_over(
      paint,
      tf_log(mirrored, lift + vec2f(0.12 * w, 0.0), -0.24, half_length, radius, aa),
    );
  }

  return paint;
}
