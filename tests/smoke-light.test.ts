import { describe, expect, it, vi } from 'vitest';
import * as firelightEval from './wgsl-eval.ts';
import * as smokeEval from './wgsl-eval.ts';

// smoke.wgsl (story 3.10) and firelight.wgsl (story 3.11), proven with numbers computed on the GPU
// (tests/wgsl-eval.ts). Each chunk has its own describe block below.

vi.setConfig({ testTimeout: 30_000 });

// --- smoke.wgsl ----------------------------------------------------------------------------------

describe('smoke.wgsl', () => {
  // Everything this block needs is local to it, so the two halves of the file stay independent.
  const INCLUDE = '#include "smoke.wgsl"';
  const { gpuF32, rowsOf, lane, scalars } = smokeEval;
  const at = (values: ArrayLike<number>, index: number): number => values[index] ?? Number.NaN;
  const range = (count: number, lo: number, hi: number): number[] =>
    Array.from({ length: count }, (_, i) => lo + ((hi - lo) * i) / (count - 1));
  /** Largest relative difference between two same-length lists. */
  const worstRelative = (actual: readonly number[], expected: readonly number[]): number =>
    actual.reduce(
      (worst, v, i) => Math.max(worst, Math.abs(v - at(expected, i)) / Math.abs(at(expected, i))),
      0,
    );
  /** The largest rise between neighbours of a list that should only fall. */
  const worstRise = (values: readonly number[]): number =>
    values.reduce((worst, v, i) => (i === 0 ? 0 : Math.max(worst, v - at(values, i - 1))), 0);
  /** True when every value is below the one before it. */
  const strictlyFalls = (values: readonly number[]): boolean =>
    values.every((v, i) => i === 0 || v < at(values, i - 1));

  // The albedo and extinction tint at the two ends of the soot scale, as the header states them.
  const PALE = [0.86, 0.88, 0.91];
  const SOOT = [0.17, 0.14, 0.11];

  it('Beer-Lambert transmittance matches exp(-tau) and composes multiplicatively', async () => {
    const a = range(64, 0, 9);
    const b = range(64, 7.5, 0.05);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let rgb = smoke_transmittance_rgb(vec3f(x.x, x.y, x.x + x.y));
         return vec4f(
           smoke_transmittance(x.x),
           smoke_transmittance(x.x + x.y) - smoke_transmittance(x.x) * smoke_transmittance(x.y),
           smoke_transmittance(x.x + x.y),
           max(abs(rgb.x - smoke_transmittance(x.x)), abs(rgb.z - smoke_transmittance(x.x + x.y))),
         );
       }`,
      rowsOf(a.map((value, i) => [value, at(b, i)])),
    );
    const single = lane(out, 0).slice(0, a.length);
    expect(
      worstRelative(
        single,
        a.map((tau) => Math.exp(-tau)),
      ),
    ).toBeLessThan(1e-5);
    const both = lane(out, 2).slice(0, a.length);
    expect(
      worstRelative(
        both,
        a.map((tau, i) => Math.exp(-tau - at(b, i))),
      ),
    ).toBeLessThan(1e-5);
    // T(a + b) = T(a) T(b), and the per-channel form is the scalar one three times.
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(at(out, i * 4 + 1))).toBeLessThan(1e-6);
      expect(at(out, i * 4 + 3)).toBeLessThan(1e-6);
    }

    const [none, negative, slab, clamped, clear, opaque, tinted] = await scalars(INCLUDE, [
      'smoke_transmittance(0.0)',
      'smoke_transmittance(-3.0)',
      'smoke_optical_depth(0.5, 8.0, 0.25)',
      'smoke_optical_depth(-0.5, 8.0, 0.25)',
      'smoke_coverage(vec3f(1.0))',
      'smoke_coverage(vec3f(0.0))',
      // Luminance-weighted: green counts for most of it.
      'smoke_coverage(vec3f(1.0, 0.0, 1.0))',
    ]);
    expect([none, negative, clamped, opaque]).toEqual([1, 1, 0, 1]);
    expect(slab).toBeCloseTo(1, 6);
    expect(clear).toBeCloseTo(0, 6);
    expect(tinted).toBeCloseTo(0.7152, 4);
  });

  it('shadow terms stay in 0..1 and fall monotonically with optical depth', async () => {
    const taus = range(400, 0, 24);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(
           smoke_shadow_from_depth(x.x),
           smoke_shadow_multi(vec3f(x.x), smoke_albedo(0.0)).y,
           smoke_shadow_multi(vec3f(x.x), smoke_albedo(0.2)).y,
           smoke_shadow_multi(vec3f(x.x), smoke_albedo(1.0)).y,
         );
       }`,
      rowsOf(taus.map((tau) => [tau])),
    );
    const beer = lane(out, 0).slice(0, taus.length);
    for (let m = 0; m < 4; m++) {
      const values = lane(out, m).slice(0, taus.length);
      expect(values[0]).toBe(1);
      expect(values.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(worstRise(values)).toBeLessThanOrEqual(0);
      // Never darker than plain Beer-Lambert.
      expect(values.every((v, i) => v >= at(beer, i))).toBe(true);
    }
    expect(
      worstRelative(
        beer.slice(0, 200),
        taus.slice(0, 200).map((tau) => Math.exp(-tau)),
      ),
    ).toBeLessThan(1e-5);
    // Black smoke (albedo below 2/3) gets no softening at all; pale smoke stays lit far deeper.
    expect(lane(out, 3).slice(0, taus.length)).toEqual(beer);
    expect(at(lane(out, 2), 50)).toBeGreaterThan(at(beer, 50));
    const pale = lane(out, 1);
    expect(at(pale, 50) / at(beer, 50)).toBeGreaterThan(2.5);
    // The closed form: mix(exp(-tau), exp(-rate tau), a), rate = sqrt(3 (1 - a)), for a = 0.88.
    const rate = Math.sqrt(3 * (1 - at(PALE, 1)));
    const expected = taus.map(
      (tau) => (1 - at(PALE, 1)) * Math.exp(-tau) + at(PALE, 1) * Math.exp(-rate * tau),
    );
    expect(worstRelative(pale.slice(0, 200), expected.slice(0, 200))).toBeLessThan(1e-4);
  });

  it('the marched shadow is exact for a uniform slab and converges for a varying one', async () => {
    // x: tap count. Density 1.7 everywhere (lane 0), and 3 t^2 along the ray (lane 1), whose
    // optical depth over [0, reach] is extinction * reach^3. Lane 2 adds up the tap lengths.
    const counts = [1, 2, 4, 8, 16, 32];
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let count = i32(x.x);
         let reach = 1.3;
         let extinction = 2.5;
         var uniform_tau = 0.0;
         var varying_tau = 0.0;
         var covered = 0.0;
         var ordered = 1.0;
         var last = 0.0;
         for (var i = 0; i < count; i++) {
           let tap = smoke_shadow_tap(i, count, reach);
           uniform_tau = smoke_shadow_step(uniform_tau, 1.7, extinction, tap.y);
           varying_tau = smoke_shadow_step(varying_tau, 3.0 * tap.x * tap.x, extinction, tap.y);
           covered += tap.y;
           ordered = min(ordered, f32(tap.x > last && tap.y > 0.0));
           last = tap.x;
         }
         return vec4f(uniform_tau, varying_tau, covered, ordered);
       }`,
      rowsOf(counts.map((count) => [count])),
    );
    const exact = 2.5 * 1.3 ** 3;
    const errors = counts.map((_, i) => Math.abs(at(out, i * 4 + 1) - exact) / exact);
    counts.forEach((_, i) => {
      expect(at(out, i * 4)).toBeCloseTo(1.7 * 2.5 * 1.3, 4);
      expect(at(out, i * 4 + 2)).toBeCloseTo(1.3, 5);
      expect(at(out, i * 4 + 3)).toBe(1);
      if (i > 0) expect(at(errors, i)).toBeLessThan(at(errors, i - 1));
    });
    // Four taps are within a few percent, 32 within a tenth of one.
    expect(at(errors, 2)).toBeLessThan(0.06);
    expect(at(errors, 5)).toBeLessThan(1e-3);

    const [shadow, closed] = await scalars(INCLUDE, [
      'smoke_shadow_from_depth(smoke_shadow_step(smoke_shadow_step(0.0, 0.5, 4.0, 0.25), 0.5, 4.0, 0.75))',
      'exp(-2.0)',
    ]);
    expect(shadow).toBeCloseTo(closed ?? Number.NaN, 6);
  });

  it('the gradient shadow is exact for a linear density and reads the slope the right way', async () => {
    // Density rho0 + slope * t along the ray toward the light, kept >= 0 over the reach.
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const cases = Array.from({ length: 200 }, () => {
      const reach = 0.2 + random() * 1.5;
      const rho0 = random() * 1.5;
      const slope = -rho0 / reach + random() * 2.5;
      const tap = reach * (0.1 + random() * 0.9);
      return [rho0, rho0 + slope * tap, tap, reach];
    });
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let tau = smoke_gradient_depth(x.x, x.y, x.z, 3.0, x.w);
         return vec4f(
           tau,
           smoke_shadow_gradient(x.x, x.y, x.z, 3.0, x.w),
           // A uniform medium is a slab of thickness reach.
           smoke_gradient_depth(x.x, x.x, x.z, 3.0, x.w),
           // With the tap halfway it is the midpoint rule (the line stays above zero when 2 b >= a).
           smoke_gradient_depth(x.x, x.x * 0.5 + x.y, 0.5 * x.w, 3.0, x.w),
         );
       }`,
      rowsOf(cases),
    );
    cases.forEach(([rho0 = 0, rho1 = 0, tap = 1, reach = 0], i) => {
      const slope = (rho1 - rho0) / tap;
      const exact = 3 * (rho0 * reach + 0.5 * slope * reach * reach);
      expect(Math.abs(at(out, i * 4) - exact)).toBeLessThan(2e-4 * (1 + exact));
      expect(at(out, i * 4 + 1)).toBeCloseTo(Math.exp(-exact), 4);
      expect(at(out, i * 4 + 1)).toBeGreaterThan(0);
      expect(at(out, i * 4 + 1)).toBeLessThanOrEqual(1);
      expect(at(out, i * 4 + 2)).toBeCloseTo(3 * rho0 * reach, 4);
      expect(at(out, i * 4 + 3)).toBeCloseTo(3 * (rho0 * 0.5 + rho1) * reach, 3);
    });

    // More smoke toward the light always means a darker shadow.
    const toward = range(128, 0, 2);
    const sweep = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(smoke_shadow_gradient(0.6, x.x, 0.2, 5.0, 0.5), 0.0, 0.0, 0.0);
       }`,
      rowsOf(toward.map((rho) => [rho])),
    );
    const shadows = lane(sweep, 0).slice(0, toward.length);
    expect(strictlyFalls(shadows)).toBe(true);
    expect(shadows.every((v) => v > 0 && v < 1)).toBe(true);

    const [edge, edgeLong, empty, uniform, thinning] = await scalars(INCLUDE, [
      // Density falling to nothing at the tap: only the wedge up to the tap counts (0.5 * rho * d),
      // however far the reach extends past it.
      'smoke_gradient_depth(0.8, 0.0, 0.25, 4.0, 0.5)',
      'smoke_gradient_depth(0.8, 0.0, 0.25, 4.0, 5.0)',
      // Leaving the smoke with none ahead: fully lit.
      'smoke_shadow_gradient(0.0, 0.0, 0.25, 4.0, 1.0)',
      'smoke_shadow_gradient(0.8, 0.8, 0.25, 4.0, 0.5)',
      'smoke_shadow_gradient(0.8, 0.4, 0.25, 4.0, 0.5)',
    ]);
    expect(edge).toBeCloseTo(0.5 * 0.8 * 0.25 * 4, 5);
    expect(edgeLong).toBeCloseTo(edge ?? Number.NaN, 6);
    expect(empty).toBe(1);
    expect(uniform).toBeCloseTo(Math.exp(-0.8 * 4 * 0.5), 5);
    expect(thinning ?? 0).toBeGreaterThan(uniform ?? 1);
  });

  it('albedo falls from pale to black with soot and splits extinction exactly', async () => {
    const soots = range(65, 0, 1);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let albedo = smoke_albedo(x.x);
         let sigma_t = smoke_extinction(0.7, 9.0, x.x);
         let split = smoke_scattering(sigma_t, albedo) + smoke_absorption(sigma_t, albedo) - sigma_t;
         return vec4f(albedo, max(abs(split.x), max(abs(split.y), abs(split.z))));
       }`,
      rowsOf(soots.map((soot) => [soot])),
    );
    for (let channel = 0; channel < 3; channel++) {
      const values = lane(out, channel).slice(0, soots.length);
      expect(values[0]).toBeCloseTo(at(PALE, channel), 5);
      expect(values.at(-1)).toBeCloseTo(at(SOOT, channel), 5);
      expect(values.every((v) => v > 0 && v < 1)).toBe(true);
      expect(strictlyFalls(values)).toBe(true);
    }
    // sigma_s + sigma_a = sigma_t to rounding (sigma_t is about 6 here).
    expect(Math.max(...lane(out, 3).slice(0, soots.length))).toBeLessThan(1e-6);

    const values = await scalars(INCLUDE, [
      'smoke_albedo(-2.0).x',
      'smoke_albedo(5.0).x',
      // Pale smoke scatters blue a little more; soot absorbs blue most.
      'smoke_albedo(0.0).z - smoke_albedo(0.0).x',
      'smoke_albedo(1.0).x - smoke_albedo(1.0).z',
      // The tint leaves green alone and extinguishes blue more than red.
      'smoke_extinction(0.7, 9.0, 0.3).y',
      'smoke_extinction_tint(0.0).z - smoke_extinction_tint(0.0).x',
      'smoke_extinction_tint(1.0).z - smoke_extinction_tint(1.0).x',
      'smoke_extinction(0.7, 9.0, 0.0).x',
      'smoke_scattering(vec3f(4.0), vec3f(0.25)).x',
      'smoke_absorption(vec3f(4.0), vec3f(0.25)).x',
      // Multiple scattering: a / (1 - 0.7 a), the series a + 0.7 a^2 + 0.49 a^3 + ...
      'smoke_multi_albedo(vec3f(0.5)).x',
      'smoke_multi_albedo(smoke_albedo(0.0)).y / smoke_albedo(0.0).y',
      'smoke_multi_albedo(smoke_albedo(1.0)).y / smoke_albedo(1.0).y',
    ]);
    expect(values[0]).toBeCloseTo(at(PALE, 0), 6);
    expect(values[1]).toBeCloseTo(at(SOOT, 0), 6);
    expect(at(values, 2)).toBeGreaterThan(0);
    expect(at(values, 3)).toBeGreaterThan(0);
    expect(values[4]).toBeCloseTo(6.3, 5);
    expect(at(values, 5)).toBeGreaterThan(at(values, 6));
    expect(at(values, 6)).toBeGreaterThan(0);
    expect(values[7]).toBeCloseTo(6.3 * 0.9, 5);
    expect(values[8]).toBeCloseTo(1, 6);
    expect(values[9]).toBeCloseTo(3, 6);
    expect(values[10]).toBeCloseTo(0.5 / 0.65, 5);
    expect(values[11]).toBeCloseTo(1 / (1 - 0.7 * 0.88), 4);
    expect(values[12]).toBeCloseTo(1 / (1 - 0.7 * 0.14), 4);
  });

  it('the fire falloff is finite at the source, decreasing, and inverse-square far away', async () => {
    const radius = 0.3;
    // Geometric spacing from far inside the source to more than 10000 radii out.
    const dists = Array.from({ length: 240 }, (_, i) => 1e-3 * 1.065 ** i);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let light = smoke_fire_light(vec3f(20.0, 8.0, 2.0), x.x, ${radius}, vec3f(0.5, 0.25, 1.0));
         return vec4f(smoke_fire_falloff(x.x, ${radius}), light);
       }`,
      rowsOf(dists.map((d) => [d])),
    );
    const falloff = lane(out, 0).slice(0, dists.length);
    // The fraction of the sphere a disc fills, in double precision. Agreeing with it to 1e-4 that
    // far out shows the shader form does not cancel.
    const exact = dists.map((d) => {
      const h = Math.hypot(d, radius);
      return (0.5 * radius * radius) / (h * (h + d));
    });
    expect(worstRelative(falloff, exact)).toBeLessThan(1e-4);
    expect(strictlyFalls(falloff)).toBe(true);
    expect(falloff.every((v) => v > 0 && v <= 0.5)).toBe(true);
    // Far field: r^2 / (4 d^2).
    const last = dists.length - 1;
    expect((at(falloff, last) * at(dists, last) ** 2) / (radius * radius * 0.25)).toBeCloseTo(1, 3);
    // The light is fire * falloff * occlusion, channel by channel.
    for (const i of [0, 60, 120, 200]) {
      expect(at(out, i * 4 + 1)).toBeCloseTo(20 * 0.5 * at(falloff, i), 4);
      expect(at(out, i * 4 + 2)).toBeCloseTo(8 * 0.25 * at(falloff, i), 4);
      expect(at(out, i * 4 + 3)).toBeCloseTo(2 * at(falloff, i), 4);
    }

    const [atSource, doubled, tiny, sky, cover, coverClosed] = await scalars(INCLUDE, [
      `smoke_fire_falloff(0.0, ${radius})`,
      'smoke_fire_falloff(40.0, 0.1) / smoke_fire_falloff(20.0, 0.1)',
      'smoke_fire_falloff(0.0, 0.0)',
      'smoke_sky_light(vec3f(0.2, 0.4, 0.8), vec3f(1.0, 0.5, 0.25)).z',
      'smoke_sky_occlusion(0.5, 8.0, 0.75, smoke_albedo(0.2)).y',
      'smoke_shadow_multi(vec3f(3.0), smoke_albedo(0.2)).y',
    ]);
    expect(atSource).toBeCloseTo(0.5, 6);
    expect(doubled).toBeCloseTo(0.25, 4);
    expect(tiny).toBeCloseTo(0.5, 5);
    // Half the sphere of directions is sky.
    expect(sky).toBeCloseTo(0.1, 6);
    expect(cover).toBeCloseTo(coverClosed ?? Number.NaN, 6);
  });

  it('the phase functions integrate to 1 over the sphere', async () => {
    // Midpoint rule over cos_theta, summed in double precision.
    const count = 4096;
    const mus = Array.from({ length: count }, (_, i) => -1 + (2 * (i + 0.5)) / count);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(
           smoke_phase(x.x, 0.4),
           smoke_phase(x.x, 0.8),
           smoke_phase_two_lobe(x.x, 0.7, -0.3, 0.6),
           smoke_phase(x.x, 0.0),
         );
       }`,
      rowsOf(mus.map((mu) => [mu])),
    );
    const integrate = (m: number, weight: (mu: number) => number = () => 1) =>
      (2 * Math.PI * 2 * lane(out, m).reduce((sum, v, i) => sum + v * weight(at(mus, i)), 0)) /
      count;
    for (let m = 0; m < 4; m++) {
      expect(integrate(m)).toBeCloseTo(1, 3);
      expect(lane(out, m).every((v) => v > 0)).toBe(true);
    }
    // Mean cosine of the default: 0.75 g + 0.25 (-g / 2) = 0.625 g.
    expect(integrate(0, (mu) => mu)).toBeCloseTo(0.625 * 0.4, 3);
    expect(integrate(2, (mu) => mu)).toBeCloseTo(0.6 * 0.7 - 0.4 * 0.3, 3);
    // g = 0 is the isotropic constant, 1 / (4 PI), in every direction.
    expect(lane(out, 3).every((v) => Math.abs(v * 4 * Math.PI - 1) < 1e-5)).toBe(true);

    const [isotropic, forward, back, lobe, hg, through, away] = await scalars(INCLUDE, [
      'smoke_phase_isotropic()',
      'smoke_phase(1.0, 0.6)',
      'smoke_phase(-1.0, 0.6)',
      'smoke_phase_two_lobe(0.3, 0.5, -0.2, 1.0)',
      'volume_phase_hg(0.3, 0.5)',
      // Looking through the smoke at the light is forward scattering.
      'smoke_cos_theta(vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, -1.0))',
      'smoke_cos_theta(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0))',
    ]);
    expect(isotropic).toBeCloseTo(1 / (4 * Math.PI), 7);
    expect(forward ?? 0).toBeGreaterThan(back ?? 1);
    expect(lobe).toBeCloseTo(hg ?? Number.NaN, 7);
    expect([through, away]).toEqual([1, -1]);
  });

  it('a uniform lit slab marched with volume_accumulate matches the closed form', async () => {
    // x: steps, thickness, soot, cos_theta. Returns the marched radiance, and in .w the
    // luminance coverage of what is left.
    const cases = [
      [1, 0.4, 0.1, 0.2],
      [24, 0.4, 0.1, 0.2],
      [7, 1.5, 0.5, -0.6],
      [48, 3, 0.9, 0.9],
      [16, 0.05, 0.3, 0],
    ];
    const density = 0.6;
    const extinction = 5;
    const g = 0.45;
    const direct = [3, 1.2, 0.4];
    const ambient = [0.1, 0.15, 0.3];
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let steps = i32(x.x);
         let sigma_t = smoke_extinction(${density}, ${extinction}.0, x.z);
         let albedo = smoke_albedo(x.z);
         let source = smoke_in_scatter(
           sigma_t, albedo, vec3f(${direct.join(', ')}), smoke_phase(x.w, ${g}), vec3f(${ambient.join(', ')}));
         var acc = volume_start();
         for (var i = 0; i < steps; i++) {
           acc = volume_accumulate(acc, sigma_t, source, x.y / f32(steps));
         }
         return vec4f(acc.radiance, smoke_coverage(acc.transmittance));
       }`,
      rowsOf(cases),
    );
    const hg = (mu: number, gg: number) =>
      (1 - gg * gg) / (4 * Math.PI * (1 + gg * gg - 2 * gg * mu) ** 1.5);
    cases.forEach(([, thickness = 0, soot = 0, mu = 0], i) => {
      const phase = 0.75 * hg(mu, g) + 0.25 * hg(mu, -0.5 * g);
      const through: number[] = [];
      for (let channel = 0; channel < 3; channel++) {
        const albedo = at(PALE, channel) + (at(SOOT, channel) - at(PALE, channel)) * soot;
        const tint =
          at([0.9, 1, 1.12], channel) +
          (at([0.97, 1, 1.04], channel) - at([0.9, 1, 1.12], channel)) * soot;
        const transmittance = Math.exp(-density * extinction * tint * thickness);
        through.push(transmittance);
        // L * albedo * phase term * (1 - exp(-sigma_t d)), plus the same for the ambient light.
        const expected =
          albedo *
          (at(direct, channel) * 4 * Math.PI * phase + at(ambient, channel)) *
          (1 - transmittance);
        expect(Math.abs(at(out, i * 4 + channel) - expected) / expected).toBeLessThan(2e-4);
      }
      const luminance = 0.2126 * at(through, 0) + 0.7152 * at(through, 1) + 0.0722 * at(through, 2);
      expect(at(out, i * 4 + 3)).toBeCloseTo(1 - luminance, 4);
    });
    // One big step and 24 small ones are the same integral.
    for (let channel = 0; channel < 3; channel++) {
      expect(at(out, channel) / at(out, 4 + channel)).toBeCloseTo(1, 4);
    }
  });
});

// --- firelight.wgsl ------------------------------------------------------------------------------

describe('firelight.wgsl', () => {
  // Everything this block needs is local to it, so the two halves of the file stay independent.
  const INCLUDE = '#include "firelight.wgsl"';
  const { gpuF32, rowsOf, lane, scalars } = firelightEval;

  /**
   * One rounded card at the origin (half size 0.1, corner radius 0.02) and a light to its left.
   * `t_shadows(p, light_radius, reach)` returns (hard, soft, trace, trace_classic).
   */
  const CARD = `${INCLUDE}
    const T_LIGHT = vec2f(-0.5, 0.0);
    fn t_card() -> FirelightOccluders {
      var occ: FirelightOccluders;
      occ.count = 1;
      occ.rects[0] = vec4f(0.0, 0.0, 0.1, 0.1);
      occ.corners[0] = vec4f(0.02, 0.0, 0.0, 0.0);
      return occ;
    }
    fn t_shadows(p: vec2f, light_radius: f32, reach: vec2f) -> vec4f {
      var occ = t_card();
      return vec4f(
        firelight_shadow_hard(p, T_LIGHT, reach, &occ, -1),
        firelight_shadow_soft(p, T_LIGHT, light_radius, reach, &occ, -1),
        firelight_shadow_trace(p, T_LIGHT, light_radius, reach, &occ, -1),
        firelight_shadow_trace_classic(p, T_LIGHT, light_radius, reach, &occ, -1),
      );
    }`;
  const METHODS = ['hard', 'soft', 'trace', 'trace_classic'] as const;

  /** Small deterministic PRNG (mulberry32). */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const at = (values: readonly number[], index: number): number => values[index] ?? Number.NaN;

  /** Where a rising profile first reaches `level`, linearly interpolated, in units of `xs`. */
  function crossing(xs: readonly number[], values: readonly number[], level: number): number {
    for (let i = 1; i < values.length; i++) {
      const a = at(values, i - 1);
      const b = at(values, i);
      if (a < level && b >= level) {
        return at(xs, i - 1) + ((level - a) / (b - a)) * (at(xs, i) - at(xs, i - 1));
      }
    }
    return Number.NaN;
  }

  /** The largest drop between neighbours of a profile that should only rise. */
  const worstDrop = (values: readonly number[]): number =>
    values.reduce((worst, v, i) => (i === 0 ? 0 : Math.max(worst, at(values, i - 1) - v)), 0);

  // The upper edge of the card's shadow is the tangent from the light to its top-left corner
  // circle (centre (-0.08, 0.08), radius 0.02): the profiles below cross it going up in y.
  const CORNER = { x: -0.08, y: 0.08, r: 0.02 };
  const LIGHT_X = -0.5;
  const toCorner = Math.hypot(CORNER.x - LIGHT_X, CORNER.y);
  const edgeAngle = Math.atan2(CORNER.y, CORNER.x - LIGHT_X) + Math.asin(CORNER.r / toCorner);
  /** Light to tangent point: the `g` of the penumbra width R * t / g. */
  const toTangent = Math.sqrt(toCorner ** 2 - CORNER.r ** 2);
  const edgeY = (x: number) => (x - LIGHT_X) * Math.tan(edgeAngle);

  /** Shadow profiles across the shadow edge at column `x`, for a light of radius `lightRadius`. */
  async function profile(x: number, lightRadius: number, samples = 512, span = 0.25) {
    const centre = edgeY(x);
    const ys = Array.from(
      { length: samples },
      (_, i) => centre - span + (2 * span * i) / (samples - 1),
    );
    const out = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f { return t_shadows(x.xy, x.z, FIRELIGHT_WALLS); }`,
      rowsOf(ys.map((y) => [x, y, lightRadius])),
    );
    return { ys, methods: METHODS.map((_, m) => lane(out, m).slice(0, samples)) };
  }

  it('the falloff window reaches exactly 0 at its radius and is 1, finite, at the light', async () => {
    const radii = [0.05, 0.3, 0.37, 1 / 3, 0.9, 1.7, 12.5];
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(
           firelight_window(x.x, x.x),
           firelight_falloff(x.x, x.x, 0.1),
           firelight_falloff(x.x * 1.5, x.x, 0.1),
           firelight_falloff(x.x * (1.0 - 1e-3), x.x, 0.1),
         );
       }`,
      rowsOf(radii.map((r) => [r])),
    );
    for (let i = 0; i < radii.length; i++) {
      expect(out[i * 4]).toBe(0);
      expect(out[i * 4 + 1]).toBe(0);
      expect(out[i * 4 + 2]).toBe(0);
      // Just inside the rim it is small but not yet zero.
      expect(out[i * 4 + 3]).toBeGreaterThan(0);
      expect(out[i * 4 + 3]).toBeLessThan(1e-3);
    }
    const [window0, falloff0, zeroCore, halfAtCore] = await scalars(INCLUDE, [
      'firelight_window(0.0, 0.5)',
      'firelight_falloff(0.0, 0.5, 0.1)',
      'firelight_falloff(0.0, 0.5, 0.0)',
      'firelight_falloff(0.1, 1000.0, 0.1)',
    ]);
    expect(window0).toBe(1);
    expect(falloff0).toBe(1);
    expect(zeroCore).toBe(1);
    expect(halfAtCore).toBeCloseTo(0.5, 5);
  });

  it('the falloff decreases monotonically and is inverse-square in the mid range', async () => {
    const count = 400;
    const ds = Array.from({ length: count }, (_, i) => (0.8 * i) / (count - 1));
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         return vec4f(firelight_falloff(x.x, 0.8, 0.06), firelight_falloff(x.x, 50.0, 0.004), 0.0, 0.0);
       }`,
      rowsOf(ds.map((d) => [d])),
    );
    const windowed = lane(out, 0).slice(0, count);
    for (let i = 1; i < count; i++) {
      expect(at(windowed, i)).toBeLessThan(at(windowed, i - 1));
      expect(at(windowed, i)).toBeGreaterThanOrEqual(0);
    }
    // core << d << radius: doubling the distance quarters the light, and f * d^2 = core^2.
    const wide = lane(out, 1).slice(0, count);
    for (const i of [50, 100, 150]) {
      expect(at(wide, i * 2) / at(wide, i)).toBeCloseTo(0.25, 2);
      expect((at(wide, i) * at(ds, i) ** 2) / 0.004 ** 2).toBeCloseTo(1, 2);
    }
  });

  it('a point light on a flat receiver matches the closed form h^3 / (d^2 + h^2)^1.5 * window', async () => {
    const random = makeRandom(11);
    const cases = Array.from({ length: 256 }, () => [
      random() * 1.2,
      0.02 + random() * 0.4,
      random() * 6.283,
    ]);
    const radius = 1;
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let light = vec2f(0.3, -0.2);
         let p = light + x.x * vec2f(cos(x.z), sin(x.z));
         let s = firelight_point(p, light, x.y, ${radius}.0);
         let n = firelight_normal(vec2f(0.0), 1.0);
         return vec4f(s.atten * firelight_diffuse(n, s.dir), length(s.dir), s.dir.z, s.spread);
       }`,
      rowsOf(cases),
    );
    cases.forEach(([d = 0, h = 0], i) => {
      const window = d >= radius ? 0 : (1 - (d / radius) ** 4) ** 2;
      const expected = (h ** 3 / (d * d + h * h) ** 1.5) * window;
      expect(Math.abs(at([...out], i * 4) - expected)).toBeLessThan(2e-5);
      expect(out[i * 4 + 1]).toBeCloseTo(1, 5);
      expect(out[i * 4 + 2]).toBeCloseTo(h / Math.hypot(d, h), 5);
      expect(out[i * 4 + 3]).toBe(0);
    });
  });

  it('the normal helper returns unit normals that lean against the slope; flat gives (0, 0, 1)', async () => {
    const random = makeRandom(5);
    const cases = Array.from({ length: 128 }, () => [
      (random() - 0.5) * 40,
      (random() - 0.5) * 40,
      random() * 3,
    ]);
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let n = firelight_normal(x.xy, x.z);
         return vec4f(n, length(n));
       }`,
      rowsOf(cases),
    );
    cases.forEach(([gx = 0, gy = 0, strength = 0], i) => {
      const scale = 1 / Math.hypot(gx * strength, gy * strength, 1);
      expect(out[i * 4]).toBeCloseTo(-gx * strength * scale, 4);
      expect(out[i * 4 + 1]).toBeCloseTo(-gy * strength * scale, 4);
      expect(out[i * 4 + 2]).toBeCloseTo(scale, 4);
      expect(out[i * 4 + 3]).toBeCloseTo(1, 5);
    });
    const flat = await scalars(INCLUDE, [
      'firelight_normal(vec2f(0.0), 1.0).x',
      'firelight_normal(vec2f(0.0), 1.0).y',
      'firelight_normal(vec2f(0.0), 1.0).z',
      'firelight_normal(vec2f(3.0, -2.0), 0.0).z',
      // Sheen: 1 for a flat surface lit from straight above, 0 for a light below the horizon.
      'firelight_sheen(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, 1.0), 32.0)',
      'firelight_sheen(vec3f(0.0, 0.0, 1.0), normalize(vec3f(1.0, 0.0, -0.2)), 32.0)',
      'firelight_diffuse(vec3f(0.0, 0.0, 1.0), normalize(vec3f(1.0, 0.0, -0.2)))',
    ]);
    // `+ 0` folds -0 into 0: which zero a flat normal's x and y come out as depends on the
    // driver (Metal gives +0, Mesa's software rasteriser -0), and both are right.
    expect(flat.map((value) => value + 0)).toEqual([0, 0, 1, 1, 1, 0, 0]);
  });

  it('the line light is the average of point lights along it and converges to one', async () => {
    const random = makeRandom(23);
    const cases = Array.from({ length: 96 }, () => [
      (random() - 0.5) * 1.2,
      (random() - 0.5) * 1.2,
      0.03 + random() * 0.3,
      random() * 0.5,
    ]);
    // x: receiver.xy, height, half length. Returns the line's attenuation, a 256-point average of
    // the point light, and (for a short segment) how far the line's direction is from the point's.
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let u = normalize(vec2f(0.8, 0.6));
         let radius = 1000.0;
         let line = firelight_line(x.xy, -u * x.w, u * x.w, x.z, radius);
         var sum = 0.0;
         for (var i = 0; i < 256; i++) {
           let s = (f32(i) + 0.5) / 256.0 * 2.0 - 1.0;
           sum += firelight_point(x.xy, u * x.w * s, x.z, radius).atten;
         }
         let short = firelight_line(x.xy, -u * 1e-3, u * 1e-3, x.z, 0.9);
         let point = firelight_point(x.xy, vec2f(0.0), x.z, 0.9);
         return vec4f(line.atten, sum / 256.0, short.atten - point.atten, dot(short.dir, point.dir));
       }`,
      rowsOf(cases),
    );
    let worstAverage = 0;
    let worstPoint = 0;
    for (let i = 0; i < cases.length; i++) {
      const average = at([...out], i * 4 + 1);
      worstAverage = Math.max(worstAverage, Math.abs(at([...out], i * 4) - average) / average);
      worstPoint = Math.max(worstPoint, Math.abs(at([...out], i * 4 + 2)));
      expect(out[i * 4 + 3]).toBeGreaterThan(0.9999);
    }
    expect(worstAverage).toBeLessThan(2e-3);
    expect(worstPoint).toBeLessThan(2e-3);

    // A zero-length segment is exactly the point light, and the footprint is a capsule.
    const [degenerate, point, insideCap, outsideCap, spreadSide, spreadEnd] = await scalars(
      INCLUDE,
      [
        'firelight_line(vec2f(0.2, 0.1), vec2f(0.0), vec2f(0.0), 0.1, 0.9).atten',
        'firelight_point(vec2f(0.2, 0.1), vec2f(0.0), 0.1, 0.9).atten',
        'firelight_line(vec2f(0.3, 0.49), vec2f(-0.3, 0.0), vec2f(0.3, 0.0), 0.1, 0.5).atten',
        'firelight_line(vec2f(0.3, 0.5), vec2f(-0.3, 0.0), vec2f(0.3, 0.0), 0.1, 0.5).atten',
        // Seen from the side the whole half length spreads the source; seen end-on, none of it.
        'firelight_line(vec2f(0.0, 0.4), vec2f(-0.3, 0.0), vec2f(0.3, 0.0), 0.1, 2.0).spread',
        'firelight_line(vec2f(0.9, 0.0), vec2f(-0.3, 0.0), vec2f(0.3, 0.0), 0.1, 2.0).spread',
      ],
    );
    expect(degenerate).toBe(point);
    expect(insideCap).toBeGreaterThan(0);
    expect(outsideCap).toBe(0);
    expect(spreadSide).toBeCloseTo(0.3, 5);
    expect(spreadEnd).toBeCloseTo(0, 5);
  });

  it('the disc light converges to the point light and tracks the true disc average', async () => {
    const ratios = [0.01, 0.25, 0.5, 1, 2];
    // Under the centre the exact average of the point kernel over a disc of radius a is
    // (h^2 / a^2) ln(1 + a^2 / h^2).
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         let h = 0.1;
         let disc = firelight_disc(vec2f(0.0), vec2f(0.0), h * x.x, h, 1000.0);
         let far_disc = firelight_disc(vec2f(3.0, 0.0), vec2f(0.0), h * x.x, h, 1000.0);
         let far_point = firelight_point(vec2f(3.0, 0.0), vec2f(0.0), h, 1000.0);
         return vec4f(disc.atten, far_disc.atten / far_point.atten, disc.spread, disc.dir.z);
       }`,
      rowsOf(ratios.map((ratio) => [ratio])),
    );
    const errors = ratios.map((ratio, i) => {
      const exact = Math.log(1 + ratio * ratio) / (ratio * ratio);
      return at([...out], i * 4) / exact - 1;
    });
    expect(Math.abs(at(errors, 0))).toBeLessThan(1e-4);
    expect(Math.abs(at(errors, 1))).toBeLessThan(0.002);
    expect(Math.abs(at(errors, 2))).toBeLessThan(0.01);
    expect(Math.abs(at(errors, 3))).toBeLessThan(0.04);
    expect(Math.abs(at(errors, 4))).toBeLessThan(0.18);
    ratios.forEach((ratio, i) => {
      // Same far field as the point light, whatever the size.
      expect(out[i * 4 + 1]).toBeCloseTo(1, 2);
      expect(out[i * 4 + 2]).toBeCloseTo(0.1 * ratio, 6);
      expect(out[i * 4 + 3]).toBeCloseTo(1, 5);
    });
  });

  it('the warmth tint runs from ember red to pale flame with a unit maximum', async () => {
    const count = 33;
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f { return vec4f(firelight_tint(x.x), 0.0); }`,
      rowsOf(Array.from({ length: count }, (_, i) => [-0.2 + (1.4 * i) / (count - 1)])),
    );
    for (let i = 0; i < count; i++) {
      expect(out[i * 4]).toBe(1);
      expect(at([...out], i * 4 + 1)).toBeGreaterThan(at([...out], i * 4 + 2));
      if (i > 0) {
        expect(at([...out], i * 4 + 1)).toBeGreaterThanOrEqual(at([...out], i * 4 - 3));
        expect(at([...out], i * 4 + 2)).toBeGreaterThanOrEqual(at([...out], i * 4 - 2));
      }
    }
    // Clamped outside 0..1.
    expect([...out.slice(0, 3)].map((v) => Math.round(v * 100))).toEqual([100, 18, 3]);
    const pale = [...out.slice((count - 1) * 4, count * 4 - 1)];
    expect(pale.map((v) => Math.round(v * 100))).toEqual([100, 86, 62]);
  });

  it('every shadow method stays in 0..1', async () => {
    const random = makeRandom(3);
    const cases = Array.from({ length: 4096 }, () => [
      (random() - 0.5) * 2.4,
      (random() - 0.5) * 2.4,
      0.002 + random() * 0.2,
      random(),
    ]);
    // Two cards, a light between them; .w picks walls or a finite reach.
    const out = await gpuF32(
      `${INCLUDE}
       fn f(x: vec4f) -> vec4f {
         var occ: FirelightOccluders;
         occ.count = 2;
         occ.rects[0] = vec4f(-0.4, 0.1, 0.2, 0.12);
         occ.corners[0] = vec4f(0.03, 0.0, 0.0, 0.0);
         occ.rects[1] = vec4f(0.45, -0.2, 0.1, 0.3);
         occ.corners[1] = vec4f(0.1, 0.0, 0.0, 0.0);
         let light = vec2f(0.05, 0.3);
         let reach = select(firelight_reach(0.5 * x.w, 0.3, x.z), FIRELIGHT_WALLS, x.w > 0.5);
         return vec4f(
           firelight_shadow_hard(x.xy, light, reach, &occ, -1),
           firelight_shadow_soft(x.xy, light, x.z, reach, &occ, -1),
           firelight_shadow_trace(x.xy, light, x.z, reach, &occ, -1),
           firelight_shadow_trace_classic(x.xy, light, x.z, reach, &occ, -1),
         );
       }`,
      rowsOf(cases),
    );
    let outside = 0;
    for (const value of out) if (!(value >= 0 && value <= 1)) outside++;
    expect(outside).toBe(0);
    // Hard shadows are binary, and the scene has both lit and shadowed receivers.
    const hard = lane(out, 0);
    expect(hard.every((v) => v === 0 || v === 1)).toBe(true);
    expect(hard.filter((v) => v === 0).length).toBeGreaterThan(200);
    expect(hard.filter((v) => v === 1).length).toBeGreaterThan(200);
  });

  it('behind the occluder is fully shadowed, a clear line of sight is fully lit', async () => {
    const receivers = [
      [0.3, 0], // straight behind the card
      [0.9, 0.05], // far behind it, still in the umbra
      [0.3, 0.6], // off to the side
      [-0.3, 0], // between the light and the card
      [-0.8, 0.1], // behind the light
      [0, 0.25], // level with the card, above it
    ];
    const out = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f { return t_shadows(x.xy, 0.04, FIRELIGHT_WALLS); }`,
      rowsOf(receivers),
    );
    const expected = [0, 0, 1, 1, 1, 1];
    receivers.forEach((_, i) => {
      for (let m = 0; m < METHODS.length; m++) {
        expect(out[i * 4 + m], `${METHODS[m]} at receiver ${i}`).toBe(expected[i]);
      }
    });

    // A receiver on the card is in its shadow unless that occluder is excluded.
    const onCard = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f {
         var occ = t_card();
         return vec4f(
           f32(firelight_occluder_at(x.xy, &occ)),
           firelight_shadow_soft(x.xy, T_LIGHT, 0.04, FIRELIGHT_WALLS, &occ, -1),
           firelight_shadow_soft(x.xy, T_LIGHT, 0.04, FIRELIGHT_WALLS, &occ, 0),
           firelight_sd_occluders(x.xy, &occ, 0),
         );
       }`,
      rowsOf([
        [0.02, 0.03],
        [0.3, 0.6],
      ]),
    );
    expect([...onCard]).toEqual([0, 0, 1, 1e6, -1, 1, 1, 1e6]);
  });

  it('the shadow lifts monotonically as the receiver moves out from behind the occluder', async () => {
    const { methods } = await profile(0.4, 0.04);
    const [hard = [], soft = [], trace = [], classic = []] = methods;
    for (const values of [hard, soft, trace, classic]) {
      expect(values[0]).toBe(0);
      expect(values.at(-1)).toBe(1);
    }
    expect(worstDrop(hard)).toBe(0);
    expect(worstDrop(soft)).toBe(0);
    // Marching samples the edge at discrete depths, so its profile may wobble a little.
    expect(worstDrop(trace)).toBeLessThan(0.02);
    expect(worstDrop(classic)).toBeLessThan(0.02);
  });

  it('the penumbra widens with distance from the occluder and with the light radius', async () => {
    // Width between 10% and 90% lit, measured along y; the model predicts
    // 1.217 * R * t / g across the ray (1.217 = the 10-90 span of a smoothstep, twice over).
    const width = (ys: readonly number[], values: readonly number[]) =>
      crossing(ys, values, 0.9) - crossing(ys, values, 0.1);
    const predicted = (x: number, lightRadius: number) => {
      const t = (x - LIGHT_X) / Math.cos(edgeAngle) - toTangent;
      return (1.217 * lightRadius * t) / toTangent / Math.cos(edgeAngle);
    };
    const near = await profile(0.2, 0.04);
    const far = await profile(0.7, 0.04);
    const wide = await profile(0.2, 0.08);

    // Analytic (index 1) and sphere-traced (index 2) penumbrae.
    for (const m of [1, 2]) {
      const nearWidth = width(near.ys, near.methods[m] ?? []);
      const farWidth = width(far.ys, far.methods[m] ?? []);
      const wideWidth = width(wide.ys, wide.methods[m] ?? []);
      expect(farWidth / nearWidth, METHODS[m]).toBeGreaterThan(2);
      expect(wideWidth / nearWidth, METHODS[m]).toBeGreaterThan(1.7);
      expect(nearWidth / predicted(0.2, 0.04), METHODS[m]).toBeGreaterThan(0.85);
      expect(nearWidth / predicted(0.2, 0.04), METHODS[m]).toBeLessThan(1.15);
      expect(farWidth / predicted(0.7, 0.04), METHODS[m]).toBeGreaterThan(0.85);
      expect(farWidth / predicted(0.7, 0.04), METHODS[m]).toBeLessThan(1.15);
      // Half lit exactly on the geometric shadow edge.
      expect(crossing(near.ys, near.methods[m] ?? [], 0.5)).toBeCloseTo(edgeY(0.2), 2);
    }
    // The hard edge sits on the same line...
    expect(crossing(near.ys, near.methods[0] ?? [], 0.5)).toBeCloseTo(edgeY(0.2), 2);
    // ...and the classic trace only has the outer half of the penumbra: it starts there.
    const classicStart = crossing(near.ys, near.methods[3] ?? [], 0.02);
    expect(classicStart).toBeGreaterThan(edgeY(0.2) - 0.004);
    const classicWidth = width(near.ys, near.methods[3] ?? []);
    expect(classicWidth / width(near.ys, near.methods[1] ?? [])).toBeLessThan(0.7);
  });

  it('hard, analytic and traced shadows agree away from the penumbra', async () => {
    const random = makeRandom(41);
    const cases = Array.from({ length: 8192 }, () => [
      (random() - 0.5) * 2.2,
      (random() - 0.5) * 1.6,
    ]);
    const out = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f { return t_shadows(x.xy, 0.03, FIRELIGHT_WALLS); }`,
      rowsOf(cases),
    );
    let saturated = 0;
    let disagreements = 0;
    let wrongSide = 0;
    let traceError = 0;
    let traceWorst = 0;
    for (let i = 0; i < cases.length; i++) {
      const hard = at([...out.subarray(i * 4, i * 4 + 4)], 0);
      const soft = at([...out.subarray(i * 4, i * 4 + 4)], 1);
      const trace = at([...out.subarray(i * 4, i * 4 + 4)], 2);
      if (soft < 1e-3 || soft > 1 - 1e-3) {
        saturated++;
        if (hard !== Math.round(soft)) disagreements++;
      }
      // The hard edge is the half-lit contour of the soft shadow.
      if ((hard === 1 && soft < 0.49) || (hard === 0 && soft > 0.51)) wrongSide++;
      traceError += Math.abs(trace - soft);
      traceWorst = Math.max(traceWorst, Math.abs(trace - soft));
    }
    expect(saturated).toBeGreaterThan(6000);
    expect(disagreements).toBe(0);
    expect(wrongSide).toBe(0);
    // The march reproduces the analytic penumbra: same model, sampled.
    expect(traceError / cases.length).toBeLessThan(0.004);
    expect(traceWorst).toBeLessThan(0.2);
  });

  it('an occluder of finite height casts a shadow that ends', async () => {
    // Card 0.05 tall, light 0.1 up, radius 0.01: reach = (0.05 / 0.11, 0.05 / 0.09). The far
    // edge of the card is 0.6 from the light, so its shadow is about 0.6 * e / (h - e) = 0.6 long.
    const xs = Array.from({ length: 200 }, (_, i) => 0.11 + (1.4 * i) / 199);
    const out = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f { return t_shadows(vec2f(x.x, 0.0), 0.01, firelight_reach(0.05, 0.1, 0.01)); }`,
      rowsOf(xs.map((x) => [x])),
    );
    const [reachLo, reachHi, wallsLo, wallsHi, noneLo] = await scalars(INCLUDE, [
      'firelight_reach(0.05, 0.1, 0.01).x',
      'firelight_reach(0.05, 0.1, 0.01).y',
      'firelight_reach(0.2, 0.1, 0.01).x',
      'firelight_reach(0.2, 0.1, 0.01).y',
      'firelight_reach(0.0, 0.1, 0.01).y',
    ]);
    expect(reachLo).toBeCloseTo(0.05 / 0.11, 5);
    expect(reachHi).toBeCloseTo(0.05 / 0.09, 5);
    expect([wallsLo, wallsHi, noneLo]).toEqual([1, 1, 0]);
    for (let m = 0; m < METHODS.length; m++) {
      const values = lane(out, m).slice(0, xs.length);
      expect(values[0], METHODS[m]).toBe(0);
      expect(values.at(-1), METHODS[m]).toBe(1);
      expect(worstDrop(values), METHODS[m]).toBeLessThan(0.02);
      const end = crossing(xs, values, 0.5);
      expect(end, METHODS[m]).toBeGreaterThan(0.1 + 0.45);
      expect(end, METHODS[m]).toBeLessThan(0.1 + 0.75);
    }
  });

  it('the dispatcher selects each method, and mode 0 is unshadowed', async () => {
    const out = await gpuF32(
      `${CARD}
       fn f(x: vec4f) -> vec4f {
         var occ = t_card();
         let direct = t_shadows(x.xy, 0.05, FIRELIGHT_WALLS);
         var same = 1.0;
         for (var mode = 1; mode <= 4; mode++) {
           let got = firelight_shadow(mode, x.xy, T_LIGHT, 0.05, FIRELIGHT_WALLS, &occ, -1);
           same = min(same, f32(got == direct[mode - 1]));
         }
         let none = firelight_shadow(FIRELIGHT_SHADOW_NONE, x.xy, T_LIGHT, 0.05, FIRELIGHT_WALLS, &occ, -1);
         return vec4f(same, none, f32(FIRELIGHT_SHADOW_SOFT), f32(FIRELIGHT_MAX_OCCLUDERS));
       }`,
      rowsOf([
        [0.3, 0],
        [0.3, 0.19],
        [0.5, 0.21],
        [0.2, 0.6],
      ]),
    );
    for (let i = 0; i < 4; i++) {
      expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual([1, 1, 2, 8]);
    }
  });
});
