#include "fullscreen.wgsl"
#include "noise.wgsl"
#include "color.wgsl"
#include "volume.wgsl"
#include "smoke.wgsl"
#include "params.wgsl"

@group(0) @binding(0) var<uniform> params: Params;

// A smoke plume above a small fire, ray-marched in one fragment pass. World space, +Y up, the fire at the
// origin, a fixed camera. The density field and the scene are here; everything that shades the smoke is in
// smoke.wgsl, and the accumulation along the ray in volume.wgsl.
// Output is PREMULTIPLIED linear radiance, with the coverage of the page in alpha (which the tail's `luminance`
// and `coverage` modes both use).

// `params.shadowing`, in the order of the select in index.ts.

const SHADOW_NONE = 0u;
const SHADOW_GRADIENT = 1u;
const SHADOW_MARCH = 2u;

// Plume: a leaning cone. Its radius grows linearly with height, as a turbulent plume's does.
const PLUME_TOP = 3.4;
const PLUME_R0 = 0.15;
const PLUME_SPREAD = 0.28;
const PLUME_LEAN = 0.11;
// The noise can push smoke out to this many plume radii; nothing exists beyond it.
const PLUME_REACH = 1.45;
// The bounding cone the march is clipped to: PLUME_REACH radii plus room for the meander.
const BOUND_R0 = 0.27;
const BOUND_SPREAD = 0.5;
// Extinction per world unit at density 1 and `density` = 1.
const EXTINCTION = 13.0;

const FIRE_POS = vec3f(0.0, 0.3, 0.0);
const FIRE_RADIUS = 0.5;
const FLAME_HEIGHT = 0.72;
const BED_RADIUS = 0.36;
// Radiance of the fire as a light on the smoke: the flame body's colour, averaged over the flame.
const FIRE_LIGHT = vec3f(10.0, 3.5, 0.75);
const SKY_COLOUR = vec3f(0.74, 0.83, 1.0);
// The sky is brightest up and to the left, a little toward the camera: side light shows form.
const SKY_DIR = vec3f(-0.4575, 0.8133, 0.3592);

// Shadow taps read the density field with this many octaves of detail; the eye's ray uses 4.
const SHADOW_OCTAVES = 1;
const FIRE_TAPS = 3;
const SKY_TAPS = 2;
const SKY_REACH = 1.1;

// Linear radiance of fire at `heat` 0..1: deep red embers, an orange body (3..15), a pale core (15..45).
fn fire_colour(heat: f32) -> vec3f {
  let h = clamp(heat, 0.0, 1.0);
  let red = vec3f(1.0, 0.1, 0.01) * smoothstep(0.0, 0.35, h) * 2.0;
  let body = vec3f(1.0, 0.33, 0.045) * smoothstep(0.2, 0.75, h) * 10.0;
  let core = vec3f(1.0, 0.8, 0.45) * pow(h, 4.0) * 32.0;
  return red + body + core;
}

fn plume_radius(h: f32) -> f32 {
  return PLUME_R0 + PLUME_SPREAD * h;
}

// Centre line of the plume: a steady lean plus a slow meander that travels up with the smoke.
fn plume_axis(h: f32) -> vec2f {
  let t = params.time;
  let sway = vec2f(
    sin(h * 1.7 - t * 0.55) + 0.6 * sin(h * 3.1 - t * 0.83 + 1.3),
    cos(h * 1.4 - t * 0.47 + 0.7) + 0.6 * sin(h * 2.6 - t * 0.71 + 4.1),
  );
  return vec2f(PLUME_LEAN * h, 0.0) + sway * 0.045 * h;
}

// Smoke density at a world position, 0 outside the plume. `octaves` of detail: the eye's ray uses 4, shadow
// taps SHADOW_OCTAVES (the same field, less fine detail).
fn plume_density(p: vec3f, octaves: i32) -> f32 {
  let h = p.y;
  if (h < 0.02 || h > PLUME_TOP) { return 0.0; }
  let radius = plume_radius(h);
  let q = (p.xz - plume_axis(h)) / radius;
  let r2 = dot(q, q);
  if (r2 > PLUME_REACH * PLUME_REACH) { return 0.0; }

  // A soft column that the noise erodes, breaking into separate puffs toward the top:
  // shape = envelope + gain * noise, and the smoke is where shape > 0.
  let fray = smoothstep(0.3, 1.0, h / PLUME_TOP);
  let envelope = (1.0 - r2) * 0.5 - max(r2 - 1.0, 0.0) * 1.1 + 0.05 - 0.3 * fray;
  let gain = 0.85 + 0.25 * fray;

  // Noise space moves with the smoke. Across the plume it is measured in plume radii, so puffs grow as
  // they rise; along it the coordinate is the integral of dh / sqrt(radius), which makes the smoke streaky
  // and fast near the fire and round and slower-looking higher up.
  let climb = (2.0 / PLUME_SPREAD) * (sqrt(radius) - sqrt(PLUME_R0));
  let t = params.time;
  let np = vec3f(q.x, climb * 1.2 - t * 0.5, q.y) * 1.2;
  // A swirl of nested sines bends the pattern, and climbs more slowly than the pattern does, so billows
  // change shape on the way up instead of sliding past as one texture. Sines, not noise: this runs for
  // every density tap, and six sines cost far less than one more noise evaluation.
  let w = np * 1.7 + vec3f(0.0, t * 0.42, 0.0);
  let warp = vec3f(
    sin(w.y + 1.6 * sin(w.z + 0.9)),
    sin(w.z * 1.13 + 1.6 * sin(w.x + 2.3) + 2.0),
    sin(w.x * 0.91 + 1.6 * sin(w.y + 4.1) + 4.0),
  );

  // The two coarse octaves are part "billow" noise (|n|: round bumps with creases between them, the
  // cauliflower look of turbulent smoke); the finer ones are plain gradient noise for wispy detail.
  var sum = 0.0;
  var amp = 1.0;
  var f = np + warp * 0.17 + vec3f(0.0, 0.0, t * 0.05);
  for (var i = 0; i < octaves; i++) {
    // The two fine octaves cannot add more than 0.375: where the coarse shape is further below zero
    // than that there is no smoke, and the samples in the gaps between puffs stop here.
    if (i == 2 && envelope + gain * (sum + 0.375) <= 0.0) { return 0.0; }
    let n = gnoise_3d(f);
    // sqrt(n^2 + e) instead of |n|: the crease stays a valley but is no longer a knife cut.
    sum += amp * select(n, mix(n, sqrt(n * n + 0.03) * 2.2 - 0.6, 0.6), i < 2);
    f = f.yzx * 2.03 + vec3f(17.3, 5.1, 9.7);
    amp *= 0.5;
  }
  let body = pow(clamp(envelope + gain * sum, 0.0, 1.0), 1.7);

  // Smoke forms above the flame, thins as the plume widens, and has dispersed by the top.
  let rise = smoothstep(0.2, 0.95, h);
  let thin = pow(PLUME_R0 / radius, 0.6) * 1.3;
  let fade = 1.0 - smoothstep(0.42 * PLUME_TOP, PLUME_TOP, h);
  return body * rise * thin * fade * fade;
}

// Heat of the flame at the base, 0..1.
fn flame_heat(p: vec3f) -> f32 {
  let height = FLAME_HEIGHT * params.flame;
  if (height < 0.01 || p.y < 0.0 || p.y > height * 1.2) { return 0.0; }
  let t = params.time;
  let y = p.y / height;
  let wobble = vec2f(
    gnoise_2d(vec2f(p.y * 3.2 - t * 2.4, 1.3)),
    gnoise_2d(vec2f(p.y * 3.2 - t * 2.4, 7.9)),
  ) * 0.11 * y;
  let width = 0.17 * pow(1.0 - 0.85 * min(y, 1.0), 0.7) + 0.012;
  let d = (p.xz - wobble) / width;
  let r2 = dot(d, d);
  if (r2 > 2.5) { return 0.0; }
  let n = gnoise_3d(vec3f(p.x * 8.0, p.y * 5.0 - t * 4.5, p.z * 8.0));
  let heat = clamp(1.0 - r2 - 0.6 * y * y + n * (0.25 + 0.9 * y), 0.0, 1.0);
  // Cooler toward the tip, so only the base of the flame reaches the pale core colour.
  return heat * (0.88 - 0.45 * y);
}

// The ember bed, a disc on the ground: rgb = radiance (premultiplied by .a), a = coverage.
fn ember_bed(xz: vec2f) -> vec4f {
  let t = params.time;
  let r = length(xz) / BED_RADIUS;
  if (r > 1.3) { return vec4f(0.0); }
  let ragged = r + 0.14 * gnoise_2d(xz * 11.0);
  let cover = 1.0 - smoothstep(0.78, 1.0, ragged);
  let coals = 0.5 + 0.5 * gnoise_2d(xz * 17.0 + vec2f(4.0, 9.0));
  let breathe = 0.5 + 0.5 * gnoise_3d(vec3f(xz * 6.0, t * 0.5));
  let heat = clamp((1.0 - r * r) * 0.75 + (coals - 0.5) * 0.9, 0.0, 1.0) * (0.55 + 0.45 * breathe);
  let glow = fire_colour(heat * 0.62) + vec3f(0.02, 0.012, 0.01);
  return vec4f(glow * cover, cover);
}

// Where the ray is inside the plume's bounding cone and between the ground and the plume top.
// The lean is a shear in x, so shearing the ray instead turns the leaning cone into an upright one.
fn plume_span(origin: vec3f, dir: vec3f) -> vec2f {
  let o = vec3f(origin.x - PLUME_LEAN * origin.y, origin.y, origin.z);
  let d = vec3f(dir.x - PLUME_LEAN * dir.y, dir.y, dir.z);
  let apex = -BOUND_R0 / BOUND_SPREAD;
  let k2 = BOUND_SPREAD * BOUND_SPREAD;
  let oy = o.y - apex;
  let a = d.x * d.x + d.z * d.z - k2 * d.y * d.y;
  let b = o.x * d.x + o.z * d.z - k2 * oy * d.y;
  let c = o.x * o.x + o.z * o.z - k2 * oy * oy;
  let disc = b * b - a * c;
  // The camera looks across the plume, so `a` is positive and the inside is between the two roots.
  if (disc <= 0.0 || a <= 1e-6) { return vec2f(0.0, -1.0); }
  let root = sqrt(disc);
  var near = (-b - root) / a;
  var far = (-b + root) / a;
  if (abs(dir.y) > 1e-5) {
    let t0 = (0.0 - origin.y) / dir.y;
    let t1 = (PLUME_TOP - origin.y) / dir.y;
    near = max(near, min(t0, t1));
    far = min(far, max(t0, t1));
  } else if (origin.y < 0.0 || origin.y > PLUME_TOP) {
    return vec2f(0.0, -1.0);
  }
  return vec2f(max(near, 0.0), far);
}

// Coverage for the page. In linear light the result is page * T + radiance, so alpha would be 1 - T
// (smoke_coverage). But the canvas is blended over the page AFTER the tail has tonemapped and sRGB-encoded
// it, and in encoded numbers 1 - T hides far too little of a light page: half-transparent grey smoke over
// white comes out white. This is the alpha that makes the blend over a WHITE page equal the linear-light
// answer: the page that stays visible is encode(T + shown) - encode(shown). Over black any alpha gives the
// same picture, and in between it is closer than 1 - T. It assumes the tail's ACES curve and no bloom.
fn page_alpha(radiance: vec3f, transmittance: vec3f) -> f32 {
  let shown = luminance(tonemap_aces(radiance * params.exposure));
  let through = 1.0 - smoke_coverage(transmittance);
  let visible = linear_to_srgb_f(min(through + shown, 1.0)) - linear_to_srgb_f(shown);
  return clamp(1.0 - visible, 0.0, 1.0);
}

@fragment fn fs(in: FullscreenVarying) -> @location(0) vec4f {
  // Camera: level, looking down -z at the plume. The distance is whatever fits the plume's height AND its
  // width, so a tall narrow frame gets a smaller plume standing at the bottom rather than a cropped one.
  let tan_half = 0.36;
  let dist = max(1.8 / tan_half, 1.35 / (tan_half * params.aspect));
  let eye = vec3f(0.3, -0.3 + dist * tan_half, dist);
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let ray = normalize(vec3f(ndc.x * tan_half * params.aspect, ndc.y * tan_half, -1.0));

  let albedo = smoke_albedo(params.soot);
  // What the smoke sends back toward the eye, with the bounces single scattering leaves out.
  let bright = smoke_multi_albedo(albedo);
  let tint = smoke_extinction_tint(params.soot);
  let extinction = EXTINCTION * params.density;
  // The fire's brightness wanders by a few percent: the shared flicker signal, evaluated once per
  // frame in index.ts (src/gpu/emission/flicker.ts) so it runs on real seconds, not on `speed`.
  let fire = FIRE_LIGHT * params.fire_light * (0.3 + 0.7 * params.flame) * params.flicker;
  let sky = SKY_COLOUR * params.sky;
  let flame_scale = FLAME_HEIGHT * params.flame;

  var acc = volume_start();
  let span = plume_span(eye, ray);
  if (span.y > span.x) {
    let steps = clamp(i32(params.steps), 8, 96);
    let ds = (span.y - span.x) / f32(steps);
    var t = span.x + ds * volume_jitter(in.position.xy, params.frame);
    for (var i = 0; i < steps; i++) {
      let p = eye + ray * t;
      t += ds;
      var sigma_t = vec3f(0.0);
      var source = vec3f(0.0);

      let rho = plume_density(p, 4);
      if (rho > 0.003) {
        let to_fire = FIRE_POS - p;
        let fire_dist = length(to_fire);
        let fire_dir = to_fire / max(fire_dist, 1e-4);
        var fire_shadow = vec3f(1.0);
        var sky_shadow = vec3f(1.0);
        if (params.shadowing == SHADOW_GRADIENT) {
          // One tap toward each light, halfway along the stretch it stands for: the whole way to the
          // fire, and SKY_REACH toward the sky.
          let fire_tap = 0.5 * fire_dist;
          let fire_tau = smoke_gradient_depth(
            rho, plume_density(p + fire_dir * fire_tap, SHADOW_OCTAVES), fire_tap, extinction, fire_dist);
          let sky_tap = 0.5 * SKY_REACH;
          let sky_tau = smoke_gradient_depth(
            rho, plume_density(p + SKY_DIR * sky_tap, SHADOW_OCTAVES), sky_tap, extinction, SKY_REACH);
          fire_shadow = smoke_shadow_multi(fire_tau * tint, albedo);
          sky_shadow = smoke_shadow_multi(sky_tau * tint, albedo);
        } else if (params.shadowing == SHADOW_MARCH) {
          var fire_tau = 0.0;
          for (var j = 0; j < FIRE_TAPS; j++) {
            let tap = smoke_shadow_tap(j, FIRE_TAPS, fire_dist);
            fire_tau = smoke_shadow_step(
              fire_tau, plume_density(p + fire_dir * tap.x, SHADOW_OCTAVES), extinction, tap.y);
          }
          var sky_tau = 0.0;
          for (var j = 0; j < SKY_TAPS; j++) {
            let tap = smoke_shadow_tap(j, SKY_TAPS, SKY_REACH);
            sky_tau = smoke_shadow_step(
              sky_tau, plume_density(p + SKY_DIR * tap.x, SHADOW_OCTAVES), extinction, tap.y);
          }
          fire_shadow = smoke_shadow_multi(fire_tau * tint, albedo);
          sky_shadow = smoke_shadow_multi(sky_tau * tint, albedo);
        }
        sigma_t = smoke_extinction(rho, extinction, params.soot);
        let phase = smoke_phase(smoke_cos_theta(fire_dir, ray), params.g);
        let direct = smoke_fire_light(fire, fire_dist, FIRE_RADIUS, fire_shadow);
        let ambient = smoke_sky_light(sky, sky_shadow);
        source = smoke_in_scatter(sigma_t, bright, direct, phase, ambient);
      }

      if (p.y < flame_scale * 1.2) {
        let heat = flame_heat(p);
        if (heat > 0.0) {
          // An emissive medium: thick parts converge on the flame colour, thin edges fade out.
          let sigma_flame = 9.0 * smoothstep(0.0, 0.3, heat);
          sigma_t += vec3f(sigma_flame);
          source += sigma_flame * fire_colour(heat);
        }
      }

      acc = volume_accumulate(acc, sigma_t, source, ds);
      if (volume_opaque(acc, 0.02)) { break; }
    }
  }

  // The ember bed lies on the ground, behind everything the march just crossed.
  if (ray.y < -1e-4) {
    let hit = eye + ray * (-eye.y / ray.y);
    let bed = ember_bed(hit.xz);
    acc.radiance += acc.transmittance * bed.rgb;
    acc.transmittance *= 1.0 - bed.a;
  }

  return vec4f(acc.radiance, page_alpha(acc.radiance, acc.transmittance));
}
