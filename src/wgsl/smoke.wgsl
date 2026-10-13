// smoke.wgsl -- shading for smoke as a participating medium: Beer-Lambert absorption, a soot colour model
// (single-scattering albedo), three ways to self-shadow, light from a fire below, sky light from above, a
// two-lobe phase function, and the in-scatter term that volume_accumulate (volume.wgsl) integrates.
//
// CONVENTIONS AND UNITS
//   density        dimensionless amount of smoke at a point, >= 0 (1 = "full"; the effect's own field).
//   extinction     per unit of world length at density 1. sigma_t = density * extinction is the chance per unit
//                  length that light is scattered or absorbed. A mean free path is 1 / sigma_t.
//   optical depth  tau = integral of sigma_t along a segment, dimensionless. Transmittance = exp(-tau).
//   albedo         single-scattering albedo, per channel, in (0, 1): the fraction of extinguished light that is
//                  scattered rather than absorbed. sigma_s = albedo * sigma_t, sigma_a = (1 - albedo) * sigma_t.
//   light          LINEAR rgb in scene radiance units (1.0 = paper white). Light arguments are "isotropic
//                  equivalent": the radiance of the source times the fraction of the sphere of directions it
//                  fills. A thick, unshadowed medium of albedo 1 lit by `direct` = 1 with the isotropic phase
//                  function saturates at radiance 1, so the numbers read like surface colours.
//   directions     unit vectors. `to_light` points from the sample toward the light, `ray_dir` from the eye
//                  into the scene (the march direction).
// Chunks cannot sample the caller's density field (WGSL has no function pointers), so wherever a shadow needs
// density along a second ray this file provides the arithmetic and the caller owns the loop:
//
//   var tau = 0.0;                                            // (b) secondary march, N taps toward the light
//   for (var i = 0; i < N; i++) {
//     let tap = smoke_shadow_tap(i, N, reach);                // .x distance of the tap, .y length it stands for
//     tau = smoke_shadow_step(tau, my_density(p + to_light * tap.x), extinction, tap.y);
//   }
//   let shadow = smoke_shadow_multi(tau * smoke_extinction_tint(soot), albedo);
//
//   let tau = smoke_gradient_depth(rho, my_density(p + to_light * d), d, extinction, reach);   // (c) one tap
//
// Absorption (Beer-Lambert)
//   smoke_optical_depth(density, extinction, thickness) -> f32    tau of a uniform slab: density * extinction *
//                                                                 thickness, each clamped to >= 0
//   smoke_transmittance(optical_depth: f32) -> f32                exp(-tau), in (0, 1], 1 at tau <= 0.
//                                                                 T(a + b) = T(a) * T(b)
//   smoke_transmittance_rgb(optical_depth: vec3f) -> vec3f        the same per channel
//   smoke_coverage(transmittance: vec3f) -> f32                   1 - luminance(T), in [0, 1]: the alpha of a
//                                                                 premultiplied result whose T is per channel
//
// Soot colour
//   smoke_albedo(soot) -> vec3f          soot in [0, 1] (clamped). 0 = pale wood smoke / steam-like, albedo
//                                        (0.86, 0.88, 0.91); 1 = black oil smoke, (0.17, 0.14, 0.11). Linear in
//                                        soot, so every channel falls monotonically. Pale smoke scatters a
//                                        little more blue; soot absorbs blue most, so thick sooty smoke is brown.
//   smoke_extinction_tint(soot) -> vec3f per-channel multiplier on extinction (green is exactly 1): small
//                                        particles extinguish short wavelengths more, (0.90, 1, 1.12) at soot 0,
//                                        flattening to (0.97, 1, 1.04) at soot 1. Thin pale smoke therefore
//                                        scatters blue-ish and reddens what is seen through it. Subtle on purpose.
//   smoke_extinction(density, extinction, soot) -> vec3f    sigma_t per channel = density * extinction * tint
//   smoke_multi_albedo(albedo: vec3f) -> vec3f   ART TERM: albedo / (1 - 0.7 * albedo), the albedo to hand to
//                                        smoke_in_scatter when pale smoke should look as bright as it does in
//                                        life. Single scattering returns `albedo` of the light; each further
//                                        bounce returns albedo again of the 0.7 assumed not to have escaped, a
//                                        geometric series. Pale smoke gains about 2.4x (and can exceed 1), black
//                                        smoke 1.1x. Use it for the in-scatter only, never for sigma_s or shadows.
//   smoke_scattering(sigma_t, albedo) -> vec3f              sigma_s = albedo * sigma_t
//   smoke_absorption(sigma_t, albedo) -> vec3f              sigma_a = (1 - albedo) * sigma_t; s + a = t exactly
//
// Self-shadowing: how much light reaches a sample. Three options, cheapest first.
//  (a) none: use 1. Zero taps. Smoke reads as a flat, self-luminous fog.
//  (b) secondary march (loop above). N extra density taps per sample.
//   smoke_shadow_tap(index, count, reach) -> vec2f     tap `index` of `count` over [0, reach], quadratically
//                                        spaced (boundaries at reach * (i / count)^2) so the nearby smoke, which
//                                        matters most, is sampled finest. Returns (distance of the tap's midpoint,
//                                        length of its interval); the lengths add up to `reach`.
//   smoke_shadow_step(optical_depth, density, extinction, ds) -> f32      optical_depth + density * extinction * ds
//   smoke_shadow_from_depth(optical_depth: f32) -> f32  plain Beer-Lambert shadow, exp(-tau), in (0, 1]
//   smoke_shadow_multi(optical_depth: vec3f, albedo: vec3f) -> vec3f
//                                        ART TERM, not a derivation: a shadow that lets pale smoke stay lit
//                                        deeper than exp(-tau) does, standing in for light that arrives after
//                                        several scatterings. mix(exp(-tau), exp(-rate * tau), albedo) with
//                                        rate = clamp(sqrt(3 (1 - albedo)), 0.25, 1), the diffusion-style decay
//                                        of an isotropic medium. Equals exp(-tau) wherever albedo <= 2/3, so
//                                        sooty smoke keeps its hard black cores. In (0, 1], 1 at tau = 0, falls
//                                        monotonically with tau, never below exp(-tau). (A Schneider-style
//                                        "powder" darkening of lit edges was tried and left out: on smoke it only
//                                        removed the bright rim that makes a puff read as round.)
//  (c) gradient trick. ONE extra tap, at distance `tap_distance` toward the light.
//   smoke_gradient_depth(density_here, density_toward_light, tap_distance, extinction, reach) -> f32
//                                        The optical depth toward the light if the density kept changing at the
//                                        rate the two samples show: the integral over [0, reach] of
//                                        max(0, rho0 + t * (rho1 - rho0) / tap_distance), times extinction. Exact
//                                        for a field that is linear along the ray; a uniform medium gives
//                                        rho * extinction * reach; with tap_distance = reach / 2 it is the
//                                        midpoint rule, rho1 * extinction * reach. WHERE IT BREAKS: it knows
//                                        nothing beyond the tap, so a separate puff further toward the light
//                                        casts no shadow, and density that rises toward the light is extrapolated
//                                        for the whole reach (keep reach <= about 3 * tap_distance). With a short
//                                        reach the shadows are local form shading, not cast shadows, and a light
//                                        far below leaks up through the whole plume; with the tap at the midpoint
//                                        of the whole path to the light the far field is right but rests on one
//                                        sample, so it steps where that sample enters or leaves a dense puff.
//   smoke_shadow_gradient(density_here, density_toward_light, tap_distance, extinction, reach) -> f32
//                                        exp(-smoke_gradient_depth(..)), in (0, 1]
//
// Light from the fire below
//   smoke_fire_falloff(dist, source_radius) -> f32     fraction of the sphere of directions that a disc of
//                                        radius `source_radius` fills when seen face-on from `dist`:
//                                        0.5 * (1 - dist / sqrt(dist^2 + r^2)). 0.5 at dist 0 (finite: the fire
//                                        fills half the view), falls monotonically, and tends to r^2 / (4 dist^2)
//                                        (inverse square) once dist >> r. Computed without cancellation.
//   smoke_fire_light(fire: vec3f, dist, source_radius, occlusion: vec3f) -> vec3f
//                                        `fire` is the linear radiance of the fire's surface (flames are 3..50).
//                                        Returns fire * falloff * occlusion: the `direct` argument of
//                                        smoke_in_scatter. `occlusion` is the shadow of the smoke between the
//                                        sample and the fire, from any of (a)-(c) with the fire as the light.
//
// Sky / ambient
//   smoke_sky_light(sky: vec3f, occlusion: vec3f) -> vec3f     `sky` is the radiance of a uniform sky filling the
//                                        upper hemisphere; returns 0.5 * sky * occlusion (half the sphere), the
//                                        `ambient` argument of smoke_in_scatter.
//   smoke_sky_occlusion(density, extinction, cover, albedo: vec3f) -> vec3f
//                                        Zero-tap occlusion: pretends the smoke overhead has the local density for
//                                        a thickness `cover` (world units: the distance to the top of the plume, or
//                                        a constant) and returns smoke_shadow_multi of that. Darkens dense cores
//                                        and deep layers; has no idea which way is up beyond `cover`.
//
// Phase functions (all integrate to 1 over the sphere; multiply by 4 PI to get "1 = isotropic")
//   smoke_phase_isotropic() -> f32       1 / (4 PI) = 0.0795775
//   smoke_cos_theta(to_light, ray_dir) -> f32     the cos_theta these phase functions (and volume_phase_hg)
//                                        expect: +1 when the eye looks through the smoke at the light
//   smoke_phase_two_lobe(cos_theta, g_forward, g_back, forward_weight) -> f32
//                                        forward_weight * HG(g_forward) + (1 - forward_weight) * HG(g_back);
//                                        weight clamped to [0, 1], g to (-1, 1) by volume_phase_hg
//   smoke_phase(cos_theta, g) -> f32     the smoke default: 0.75 forward lobe at g, 0.25 back lobe at -g / 2, so a
//                                        plume lit from the camera side does not go black as g rises. Mean cosine
//                                        0.625 g. g = 0 is isotropic; smoke looks right around 0.3 to 0.6.
//
// Combining
//   smoke_in_scatter(sigma_t: vec3f, albedo: vec3f, direct: vec3f, phase: f32, ambient: vec3f) -> vec3f
//                                        Radiance scattered toward the eye per unit length:
//                                        albedo * sigma_t * (direct * 4 PI * phase + ambient). Pass it to
//                                        volume_accumulate(acc, sigma_t, in_scatter, ds). A uniform slab of
//                                        thickness d then gives albedo * (direct * 4 PI * phase + ambient)
//                                        * (1 - exp(-sigma_t d)).
//
// WHICH TO USE (measured on the smoke-shading effect, see its notes): (c) with the tap at the midpoint of the
// path to each light is the default, at 1 tap per light; (b) with 3 to 4 taps where the budget allows or the
// smoke has separate layers; (a) only for smoke too thin to shadow itself.
//
// Cost per sample, besides the caller's density taps: smoke_shadow_multi is 6 exp and 3 sqrt, the phase is 2 pow,
// the fire light 1 sqrt; everything else is a few multiply-adds. The density taps dominate: 0 for (a), 1 per light
// for (c), N per light for (b).
// Credits: Beer-Lambert law; Henyey & Greenstein 1941; the albedo-weighted second exponential follows the
// multi-scattering approximations of Wrenninge et al., "Oz: The Great and Volumetric" (SIGGRAPH 2013 talk) and
// A. Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015); the disc solid angle
// is the textbook on-axis form.
#include "color.wgsl"
#include "volume.wgsl"

const _SMOKE_FOUR_PI: f32 = 12.566370614;
const _SMOKE_REBOUND: f32 = 0.7;
const _SMOKE_ALBEDO_PALE: vec3f = vec3f(0.86, 0.88, 0.91);
const _SMOKE_ALBEDO_SOOT: vec3f = vec3f(0.17, 0.14, 0.11);
const _SMOKE_TINT_PALE: vec3f = vec3f(0.90, 1.0, 1.12);
const _SMOKE_TINT_SOOT: vec3f = vec3f(0.97, 1.0, 1.04);

fn smoke_optical_depth(density: f32, extinction: f32, thickness: f32) -> f32 {
  return max(density, 0.0) * max(extinction, 0.0) * max(thickness, 0.0);
}

fn smoke_transmittance(optical_depth: f32) -> f32 {
  return exp(-max(optical_depth, 0.0));
}

fn smoke_transmittance_rgb(optical_depth: vec3f) -> vec3f {
  return exp(-max(optical_depth, vec3f(0.0)));
}

fn smoke_coverage(transmittance: vec3f) -> f32 {
  return clamp(1.0 - luminance(transmittance), 0.0, 1.0);
}

fn smoke_albedo(soot: f32) -> vec3f {
  return mix(_SMOKE_ALBEDO_PALE, _SMOKE_ALBEDO_SOOT, clamp(soot, 0.0, 1.0));
}

fn smoke_multi_albedo(albedo: vec3f) -> vec3f {
  let a = clamp(albedo, vec3f(0.0), vec3f(1.0));
  return a / (vec3f(1.0) - _SMOKE_REBOUND * a);
}

fn smoke_extinction_tint(soot: f32) -> vec3f {
  return mix(_SMOKE_TINT_PALE, _SMOKE_TINT_SOOT, clamp(soot, 0.0, 1.0));
}

fn smoke_extinction(density: f32, extinction: f32, soot: f32) -> vec3f {
  return max(density, 0.0) * max(extinction, 0.0) * smoke_extinction_tint(soot);
}

fn smoke_scattering(sigma_t: vec3f, albedo: vec3f) -> vec3f {
  return albedo * sigma_t;
}

fn smoke_absorption(sigma_t: vec3f, albedo: vec3f) -> vec3f {
  return sigma_t - albedo * sigma_t;
}

fn smoke_shadow_tap(index: i32, count: i32, reach: f32) -> vec2f {
  let n = f32(max(count, 1));
  let a = f32(index) / n;
  let b = f32(index + 1) / n;
  let near = reach * a * a;
  let far = reach * b * b;
  return vec2f(0.5 * (near + far), far - near);
}

fn smoke_shadow_step(optical_depth: f32, density: f32, extinction: f32, ds: f32) -> f32 {
  return optical_depth + smoke_optical_depth(density, extinction, ds);
}

fn smoke_shadow_from_depth(optical_depth: f32) -> f32 {
  return smoke_transmittance(optical_depth);
}

fn smoke_shadow_multi(optical_depth: vec3f, albedo: vec3f) -> vec3f {
  let tau = max(optical_depth, vec3f(0.0));
  let a = clamp(albedo, vec3f(0.0), vec3f(1.0));
  let rate = clamp(sqrt(3.0 * (vec3f(1.0) - a)), vec3f(0.25), vec3f(1.0));
  let direct = exp(-tau);
  // Written as direct + a * (slow - direct) so that it is exactly `direct` when the rate is 1 and exactly 1 at tau = 0.
  return direct + a * (exp(-rate * tau) - direct);
}

fn smoke_gradient_depth(
  density_here: f32,
  density_toward_light: f32,
  tap_distance: f32,
  extinction: f32,
  reach: f32,
) -> f32 {
  let rho0 = max(density_here, 0.0);
  let rho1 = max(density_toward_light, 0.0);
  let span = max(reach, 0.0);
  let slope = (rho1 - rho0) / max(tap_distance, 1e-6);
  let rho_end = rho0 + slope * span;
  // A trapezoid while the extrapolated line stays above zero; otherwise the triangle up to where it reaches zero.
  let trapezoid = 0.5 * (rho0 + rho_end) * span;
  let triangle = 0.5 * rho0 * rho0 / max(-slope, 1e-6);
  return select(trapezoid, triangle, rho_end < 0.0) * max(extinction, 0.0);
}

fn smoke_shadow_gradient(
  density_here: f32,
  density_toward_light: f32,
  tap_distance: f32,
  extinction: f32,
  reach: f32,
) -> f32 {
  return exp(-smoke_gradient_depth(density_here, density_toward_light, tap_distance, extinction, reach));
}

fn smoke_fire_falloff(dist: f32, source_radius: f32) -> f32 {
  let d = max(dist, 0.0);
  let r = max(source_radius, 1e-4);
  let h = sqrt(d * d + r * r);
  // 0.5 * (1 - d / h) rewritten as r^2 / (2 h (h + d)): no cancellation when d >> r.
  return 0.5 * r * r / (h * (h + d));
}

fn smoke_fire_light(fire: vec3f, dist: f32, source_radius: f32, occlusion: vec3f) -> vec3f {
  return fire * smoke_fire_falloff(dist, source_radius) * occlusion;
}

fn smoke_sky_light(sky: vec3f, occlusion: vec3f) -> vec3f {
  return 0.5 * sky * occlusion;
}

fn smoke_sky_occlusion(density: f32, extinction: f32, cover: f32, albedo: vec3f) -> vec3f {
  return smoke_shadow_multi(vec3f(smoke_optical_depth(density, extinction, cover)), albedo);
}

fn smoke_phase_isotropic() -> f32 {
  return 1.0 / _SMOKE_FOUR_PI;
}

fn smoke_cos_theta(to_light: vec3f, ray_dir: vec3f) -> f32 {
  // Light travels along -to_light and the eye is along -ray_dir, so the two signs cancel.
  return dot(to_light, ray_dir);
}

fn smoke_phase_two_lobe(cos_theta: f32, g_forward: f32, g_back: f32, forward_weight: f32) -> f32 {
  return mix(
    volume_phase_hg(cos_theta, g_back),
    volume_phase_hg(cos_theta, g_forward),
    clamp(forward_weight, 0.0, 1.0),
  );
}

fn smoke_phase(cos_theta: f32, g: f32) -> f32 {
  return smoke_phase_two_lobe(cos_theta, g, -0.5 * g, 0.75);
}

fn smoke_in_scatter(sigma_t: vec3f, albedo: vec3f, direct: vec3f, phase: f32, ambient: vec3f) -> vec3f {
  return smoke_scattering(sigma_t, albedo) * (direct * (_SMOKE_FOUR_PI * phase) + ambient);
}
