// volume.wgsl -- the ray-march kernel for a participating medium (flame, smoke, fog, ink) inside a box: the
// ray-box intersection, clipping against scene depth, step-count control, per-pixel jitter, the analytic
// emission-absorption accumulation of one step, early termination, a phase function, and the weights of a
// depth-aware upsample for marching at reduced resolution (src/gpu/volume/ is the TypeScript half).
//
// CONVENTIONS. World space, +Y up (camera.wgsl). A medium fills an axis-aligned box [box_min, box_max]; a ray is
// `origin + t * dir` with `dir` a UNIT vector (so t is a distance). Extinction `sigma_t` is per unit of world
// length and per channel (coloured absorption makes ink read as ink rather than smoke), radiance is LINEAR rgb
// in the site's units (1.0 = paper white). The march is front to back: `VolumeAccum` holds the radiance gathered
// so far and the transmittance still left. A march writes `vec4f(radiance, transmittance)`: the radiance is
// already "premultiplied" (it is what reaches the eye), and what is behind is multiplied by the transmittance:
// final = scene * transmittance + radiance.
//
// THE LOOP every effect writes (the chunk cannot sample the effect's density, so the loop is the effect's):
//   var span = volume_ray_box(eye, dir, box_min, box_max);
//   span = volume_clip_span(span, volume_depth_to_distance(scene_view_depth, dir, view_forward));
//   if (!volume_hit(span)) { return vec4f(0.0, 0.0, 0.0, 1.0); }
//   let m = volume_march_length(span, step_length, max_steps, volume_jitter(in.position.xy, 0u));
//   var acc = volume_start();
//   for (var i = 0; i < m.steps; i++) {
//     let p = eye + dir * volume_march_t(m, i);
//     acc = volume_accumulate_medium(acc, my_medium(p), m.ds);    // fire and smoke together
//     if (volume_opaque(acc, 0.01)) { break; }                    // early termination
//   }
//   return volume_resolve(acc, 0.01);
//
// Box
//   volume_ray_box(origin, dir, box_min, box_max) -> vec2f
//       (t_near, t_far) where the ray enters and leaves the box, t_near clamped to >= 0 (a camera inside the box
//       starts at 0). The ray misses when t_far <= t_near: use volume_hit. Rays parallel to a pair of faces are
//       handled (they hit only if they are between them). Cost: 6 divides, a few min/max.
//   volume_hit(span: vec2f) -> bool                 true when volume_ray_box found a segment of positive length
//   volume_to_uvw(p, box_min, box_max) -> vec3f     world position -> 0..1 texture coordinate inside the box
//   volume_clip_span(span, t_max) -> vec2f          the span cut off at distance t_max along the ray (opaque
//       geometry in front of or inside the box); may come back empty, so test volume_hit afterwards
//   volume_depth_to_distance(view_depth, dir, view_forward) -> f32
//       view-space depth (camera_linear_depth: distance along the view axis) -> distance t along the unit ray
//       `dir`. `view_forward` is the unit direction the camera looks in, -(cam.inv_view[2].xyz).
//
// Stepping
//   struct VolumeMarch { t: f32, ds: f32, steps: i32 }
//       t = distance of the first sample, ds = step length, steps = how many. Sample i sits at t + i * ds and
//       stands for the whole interval of length ds around it (the jitter slides the sample inside its interval).
//   volume_march_steps(span, steps, jitter) -> VolumeMarch
//       exactly `steps` samples across the span, however short it is: constant cost per pixel, ds varies.
//   volume_march_length(span, step_length, max_steps, jitter) -> VolumeMarch
//       samples about `step_length` apart, so a short span (a ray stopped by geometry, a box corner) takes fewer
//       steps; if the span needs more than `max_steps` the step is stretched to cover it. Prefer this one: the
//       noise grain is the same across the image and the cost follows the amount of medium. Both clamp the count
//       to [1, VOLUME_MAX_STEPS = 256]; `jitter` is in [0, 1).
//   volume_march_t(m, i) -> f32                     distance of sample i
//   volume_jitter(pixel: vec2f, frame: u32) -> f32  [0, 1) interleaved gradient noise of the pixel position
//       (Jimenez 2014); with `frame` = 0 it is a fixed pattern, with a frame counter it moves every frame. Start the
//       march at t_near + jitter * step and the banding of a fixed step count turns into fine noise. No texture.
//   volume_jitter_blue(noise: texture_2d<f32>, pixel: vec2f, frame: u32) -> f32
//       [0, 1) from a tiling blue-noise texture (r8unorm, any size; src/gpu/volume/blue-noise.ts makes a 64x64
//       void-and-cluster one), read with textureLoad so it needs no sampler. Its error has no low frequencies, so
//       after the bloom, an upsample or the eye's own blur far less of it is left than of white noise or IGN.
//       `frame` shifts every value by the golden ratio (volume_jitter_animate), which keeps the pattern blue.
//   volume_jitter_animate(jitter, frame: u32) -> f32   fract(jitter + frame * 0.618...): any [0, 1) jitter moved
//       along a low-discrepancy sequence in time, so a temporal filter (or the eye at 60 Hz) averages it out fast
//
// Accumulation (one step of length `ds`)
//   struct VolumeAccum { radiance: vec3f, transmittance: vec3f }
//   volume_start() -> VolumeAccum                   no radiance, full transmittance
//   volume_accumulate(acc, sigma_t, in_scatter, ds) -> VolumeAccum
//       `in_scatter` is the radiance the medium sends toward the eye per unit length (scattering coefficient times
//       the light that reaches it times the phase function; or an emission). The step adds the analytic integral over
//       the step, T * in_scatter * (1 - exp(-sigma_t ds)) / sigma_t, and multiplies T by exp(-sigma_t ds). That
//       is exact for a constant medium over the step, so a few big steps do not brighten or darken it (a plain
//       in_scatter * ds sum would). sigma_t -> 0 gives T * in_scatter * ds. Negative sigma_t or ds count as 0.
//   volume_opaque(acc, threshold) -> bool           true when the largest channel of the transmittance is below
//       `threshold`: stop marching (early exit). What is skipped is at most `threshold` times whatever radiance
//       was still to come, so 0.01 is invisible and 0.05 is still safe under bloom.
//   volume_resolve(acc, threshold) -> vec4f         the march result, vec4f(radiance, transmittance): the
//       transmittance is the mean of the three channels, remapped so `threshold` becomes exactly 0 (a ray that
//       exited early is fully opaque instead of letting `threshold` of the background through). Use the same
//       threshold as volume_opaque, or 0 for no remap.
//   volume_slab_transmittance(sigma_t, thickness) -> vec3f     exp(-sigma_t * thickness): what a uniform slab leaves
//   volume_slab_radiance(source, sigma_t, thickness) -> vec3f  what a uniform slab with source term `source` sends
//       out of its near face: source * (1 - exp(-sigma_t d)) / sigma_t (source * d when sigma_t is 0). The closed
//       form the march is tested against.
//
// Emission and absorption: fire and smoke in the same march
//   struct VolumeMedium { source: vec3f, sigma_t: vec3f }
//       what one point of the medium does: `source` is radiance added per unit length toward the eye (emission
//       plus in-scattered light), `sigma_t` is extinction per unit length. Media that share space add up.
//   volume_vacuum() -> VolumeMedium                 nothing: no source, no extinction
//   volume_emitter(emission, sigma_a) -> VolumeMedium
//       a glowing gas: `emission` is radiance per unit length (so a flame twice as thick is twice as bright until
//       its own absorption `sigma_a` catches up). The art-directable form: brightness and opacity are separate.
//   volume_emitter_thermal(radiance, sigma_a) -> VolumeMedium
//       a glowing gas in thermal equilibrium (Kirchhoff): source = sigma_a * radiance. However thick the flame
//       gets it never exceeds `radiance`, thin parts are dim and see-through, and the result does not depend on
//       the step count. Give `radiance` the flame colour at full brightness (3-50) and shape with sigma_a.
//   volume_scatterer(sigma_t, albedo, incoming) -> VolumeMedium
//       smoke: extinction `sigma_t`, of which `albedo` (0..1 per channel) is scattered and the rest absorbed;
//       `incoming` is the light arriving at the point already multiplied by the phase function and by any
//       shadowing (for isotropic light from all sides: the average radiance around the point).
//   volume_combine(a, b) -> VolumeMedium            two media in the same place (flame inside smoke): sums both
//   volume_accumulate_medium(acc, medium, ds) -> VolumeAccum    volume_accumulate for a VolumeMedium
//
// Phase
//   volume_phase_hg(cos_theta, g) -> f32            Henyey-Greenstein phase function, normalised over the sphere
//       (integrates to 1); g in (-1, 1): 0 isotropic, > 0 forward scattering. cos_theta is the cosine of the
//       angle between the direction the light travels and the direction toward the eye.
//
// Reduced-resolution marching (the weights; the passes are in src/gpu/volume/reduced.ts)
//   volume_bilinear_weights(f: vec2f) -> vec4f      weights of the four texels around a point whose fractional
//       position between them is f, in the order (0,0), (1,0), (0,1), (1,1). They sum to 1.
//   volume_upsample_weights(bilinear, depths, depth, tolerance) -> vec4f
//       joint-bilateral weights for upsampling a low-resolution march under a full-resolution depth buffer:
//       `depths` are the view-space depths the four low-resolution texels were marched against, `depth` is the
//       full-resolution pixel's. A texel whose depth differs by the relative amount r gets its bilinear weight
//       divided by (1 + (r / tolerance)^2)^2, so on a smooth surface the result is bilinear, and across a
//       silhouette the texels on the wrong side drop out (r = 10 tolerances leaves 1e-4). If no texel matches,
//       the ones closest in depth dominate. The result sums to 1; blend as first + sum(w_i * (v_i - first)) and
//       a constant field is reproduced bit for bit.
//       tolerance: relative depth difference, typically 0.01-0.03.
//
// Cost: the accumulate is 3 exp and a few divides per step; IGN jitter is one fract and two multiplies, blue
// noise one textureLoad; the upsample weights are about 30 ALU ops per pixel.
// Credits: slab method (Kay & Kajiya 1986); interleaved gradient noise from J. Jimenez, "Next Generation Post
// Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014); Henyey & Greenstein 1941; void-and-cluster blue
// noise, R. Ulichney 1993; analytic step integration, S. Hillaire, "Physically Based and Unified Volumetric
// Rendering in Frostbite" (SIGGRAPH 2015); depth-aware upsampling after P. Shopf, "Mixed Resolution Rendering"
// (GDC 2009) and L. Bavoil's nearest-depth filter.

const _VOLUME_EPS: f32 = 1e-8;

struct VolumeAccum {
  radiance: vec3f,
  transmittance: vec3f,
}

fn volume_ray_box(origin: vec3f, dir: vec3f, box_min: vec3f, box_max: vec3f) -> vec2f {
  // A direction component of ~0 would divide by zero; give it a huge reciprocal of the right sign instead,
  // which sends that slab's distances to +-1e30 (or, outside the slab, makes the segment empty).
  let safe = select(dir, vec3f(_VOLUME_EPS), abs(dir) < vec3f(_VOLUME_EPS));
  let inv = 1.0 / safe;
  let t0 = (box_min - origin) * inv;
  let t1 = (box_max - origin) * inv;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  return vec2f(near, far);
}

fn volume_hit(span: vec2f) -> bool {
  return span.y > span.x;
}

fn volume_to_uvw(p: vec3f, box_min: vec3f, box_max: vec3f) -> vec3f {
  return (p - box_min) / (box_max - box_min);
}

fn volume_jitter(pixel: vec2f, frame: u32) -> f32 {
  // The frame shifts the pattern along its own diagonal (5.588238 px per frame), the usual way to animate it.
  let p = pixel + 5.588238 * f32(frame % 64u);
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

fn volume_start() -> VolumeAccum {
  return VolumeAccum(vec3f(0.0), vec3f(1.0));
}

fn volume_accumulate(acc: VolumeAccum, sigma_t: vec3f, in_scatter: vec3f, ds: f32) -> VolumeAccum {
  let extent = max(ds, 0.0);
  let tau = max(sigma_t, vec3f(0.0)) * extent;
  let step_t = exp(-tau);
  // (1 - exp(-tau)) / sigma_t, with its limit ds as sigma_t -> 0.
  let ratio = select((vec3f(1.0) - step_t) / max(sigma_t, vec3f(1e-12)), vec3f(extent), tau < vec3f(1e-5));
  var out: VolumeAccum;
  out.radiance = acc.radiance + acc.transmittance * in_scatter * ratio;
  out.transmittance = acc.transmittance * step_t;
  return out;
}

fn volume_opaque(acc: VolumeAccum, threshold: f32) -> bool {
  return max(acc.transmittance.x, max(acc.transmittance.y, acc.transmittance.z)) < threshold;
}

fn volume_slab_transmittance(sigma_t: vec3f, thickness: f32) -> vec3f {
  return exp(-max(sigma_t, vec3f(0.0)) * max(thickness, 0.0));
}

fn volume_phase_hg(cos_theta: f32, g: f32) -> f32 {
  let gg = clamp(g, -0.999, 0.999);
  let denom = 1.0 + gg * gg - 2.0 * gg * cos_theta;
  return (1.0 - gg * gg) / (12.566370614 * pow(max(denom, 1e-6), 1.5));
}

// ---- Clipping and stepping ----------------------------------------------------------------------

const VOLUME_MAX_STEPS: i32 = 256;
const _VOLUME_GOLDEN: f32 = 0.61803398875;

struct VolumeMarch {
  t: f32,
  ds: f32,
  steps: i32,
}

fn volume_clip_span(span: vec2f, t_max: f32) -> vec2f {
  return vec2f(span.x, min(span.y, t_max));
}

fn volume_depth_to_distance(view_depth: f32, dir: vec3f, view_forward: vec3f) -> f32 {
  return view_depth / max(dot(dir, view_forward), 1e-4);
}

fn volume_march_steps(span: vec2f, steps: i32, jitter: f32) -> VolumeMarch {
  let count = clamp(steps, 1, VOLUME_MAX_STEPS);
  let ds = max(span.y - span.x, 0.0) / f32(count);
  return VolumeMarch(span.x + jitter * ds, ds, count);
}

fn volume_march_length(span: vec2f, step_length: f32, max_steps: i32, jitter: f32) -> VolumeMarch {
  let extent = max(span.y - span.x, 0.0);
  let wanted = i32(ceil(min(extent / max(step_length, 1e-6), f32(VOLUME_MAX_STEPS))));
  let count = clamp(wanted, 1, clamp(max_steps, 1, VOLUME_MAX_STEPS));
  let ds = extent / f32(count);
  return VolumeMarch(span.x + jitter * ds, ds, count);
}

fn volume_march_t(m: VolumeMarch, i: i32) -> f32 {
  return m.t + f32(i) * m.ds;
}

fn volume_jitter_animate(jitter: f32, frame: u32) -> f32 {
  return fract(jitter + f32(frame % 1024u) * _VOLUME_GOLDEN);
}

fn volume_jitter_blue(noise: texture_2d<f32>, pixel: vec2f, frame: u32) -> f32 {
  let size = textureDimensions(noise);
  let texel = vec2u(max(pixel, vec2f(0.0))) % size;
  // An 8-bit texel is one of 256 levels: centre it in its bin so the value is never 0 or 1.
  let value = textureLoad(noise, texel, 0).r * (255.0 / 256.0) + (0.5 / 256.0);
  return volume_jitter_animate(value, frame);
}

// ---- Emission and absorption --------------------------------------------------------------------

struct VolumeMedium {
  source: vec3f,
  sigma_t: vec3f,
}

fn volume_vacuum() -> VolumeMedium {
  return VolumeMedium(vec3f(0.0), vec3f(0.0));
}

fn volume_emitter(emission: vec3f, sigma_a: vec3f) -> VolumeMedium {
  return VolumeMedium(max(emission, vec3f(0.0)), max(sigma_a, vec3f(0.0)));
}

fn volume_emitter_thermal(radiance: vec3f, sigma_a: vec3f) -> VolumeMedium {
  let sigma = max(sigma_a, vec3f(0.0));
  return VolumeMedium(sigma * max(radiance, vec3f(0.0)), sigma);
}

fn volume_scatterer(sigma_t: vec3f, albedo: vec3f, incoming: vec3f) -> VolumeMedium {
  let sigma = max(sigma_t, vec3f(0.0));
  return VolumeMedium(sigma * clamp(albedo, vec3f(0.0), vec3f(1.0)) * max(incoming, vec3f(0.0)), sigma);
}

fn volume_combine(a: VolumeMedium, b: VolumeMedium) -> VolumeMedium {
  return VolumeMedium(a.source + b.source, a.sigma_t + b.sigma_t);
}

fn volume_accumulate_medium(acc: VolumeAccum, medium: VolumeMedium, ds: f32) -> VolumeAccum {
  return volume_accumulate(acc, medium.sigma_t, medium.source, ds);
}

fn volume_slab_radiance(source: vec3f, sigma_t: vec3f, thickness: f32) -> vec3f {
  return volume_accumulate(volume_start(), sigma_t, source, thickness).radiance;
}

fn volume_resolve(acc: VolumeAccum, threshold: f32) -> vec4f {
  let cut = clamp(threshold, 0.0, 0.99);
  let left = clamp((acc.transmittance - vec3f(cut)) / (1.0 - cut), vec3f(0.0), vec3f(1.0));
  return vec4f(acc.radiance, (left.x + left.y + left.z) / 3.0);
}

// ---- Reduced-resolution upsampling --------------------------------------------------------------

fn volume_bilinear_weights(f: vec2f) -> vec4f {
  let g = vec2f(1.0) - f;
  return vec4f(g.x * g.y, f.x * g.y, g.x * f.y, f.x * f.y);
}

fn volume_upsample_weights(bilinear: vec4f, depths: vec4f, depth: f32, tolerance: f32) -> vec4f {
  let relative = abs(depths - vec4f(depth)) / max(depth, 1e-6);
  // Capped so the fourth power stays finite; four texels at the cap fall back to plain bilinear.
  let q = min(relative / max(tolerance, 1e-6), vec4f(1e4));
  let falloff = vec4f(1.0) + q * q;
  // The small floor lets a texel on the right side of an edge win even when its bilinear weight is 0.
  let w = (bilinear + vec4f(1e-4)) / (falloff * falloff);
  return w / (w.x + w.y + w.z + w.w);
}
