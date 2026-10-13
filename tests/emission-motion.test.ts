import { describe, expect, it, vi } from 'vitest';
import {
  countFlashes,
  FLICKER_DEFAULT,
  FLICKER_DRIFT_SHARE,
  FLICKER_FLASH_DARK,
  FLICKER_FLASH_DELTA,
  FLICKER_FLASH_LIMIT,
  FLICKER_PERIOD,
  FLICKER_RATE_LIMIT,
  FLICKER_SAFE_MAX_DEPTH,
  FLICKER_SAFE_MAX_RATE,
  FLICKER_SAFE_MAX_SHIMMER,
  FLICKER_SAFE_MAX_SHIMMER_RATE,
  flickerBasis,
  flickerClamp,
  flickerIntensity,
  flickerIntensityUnsafe,
  flickerIsSafe,
  flickerOffset,
  flickerOffsetUnsafe,
  type FlickerSettings,
} from '../src/gpu/emission/flicker.ts';
import { mountHeadless } from './headless.ts';
import { gpuF32, lane, rowsOf, scalars } from './wgsl-eval.ts';

// Stories 3.6 to 3.8: flicker signals (flicker.wgsl and its TypeScript twin), flame shaping
// (flame.wgsl) and advected noise (advect.wgsl). Each chunk has one describe block; the numbers
// quoted in the chunk headers and in the three effects' notes are asserted or printed here.

describe('flicker', () => {
  // Long windows sampled densely: a few million evaluations per test on a busy machine.
  const SLOW_TEST = 120_000;

  /** Sampling rate of the flash measurements: four times a 60 Hz display, as the story asks. */
  const SAMPLE_HZ = 240;

  /** Settings far outside every cap. Clamped, they are the worst case the safe path can produce. */
  const WILD: FlickerSettings = { rate: 1e6, depth: 1e6, shimmer: 1e6, shimmerRate: 1e6 };
  /** The worst case of the safe range: fastest and deepest slow swing, largest and fastest shimmer. */
  const WORST = flickerClamp(WILD);
  /** The other corner: no shimmer, so the slow swing gets the whole range. */
  const DEEPEST = flickerClamp({ rate: 1e6, depth: 1e6, shimmer: 0, shimmerRate: 0 });

  function flickerSample(signal: (t: number) => number, seconds: number, hz = SAMPLE_HZ) {
    const samples = new Float64Array(Math.round(seconds * hz));
    for (let i = 0; i < samples.length; i++) samples[i] = signal(i / hz);
    return samples;
  }

  function flickerStats(samples: ArrayLike<number>) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!;
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    const mean = sum / samples.length;
    let squares = 0;
    for (let i = 0; i < samples.length; i++) squares += (samples[i]! - mean) ** 2;
    const sorted = Float64Array.from(samples).sort();
    return {
      min,
      max,
      mean,
      deviation: Math.sqrt(squares / samples.length),
      p05: sorted[Math.floor(sorted.length * 0.05)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
    };
  }

  function flickerCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const sa = flickerStats(a);
    const sb = flickerStats(b);
    let covariance = 0;
    for (let i = 0; i < a.length; i++) covariance += (a[i]! - sa.mean) * (b[i]! - sb.mean);
    return covariance / a.length / (sa.deviation * sb.deviation);
  }

  function flickerMaxStep(samples: ArrayLike<number>): number {
    let step = 0;
    for (let i = 1; i < samples.length; i++)
      step = Math.max(step, Math.abs(samples[i]! - samples[i - 1]!));
    return step;
  }

  /** Small deterministic PRNG (mulberry32). */
  function flickerRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A square wave between `lo` and `hi`, `hz` full cycles a second, starting high. */
  const flickerSquare = (hz: number, lo: number, hi: number) => (t: number) =>
    Math.floor(t * hz * 2 + 1e-9) % 2 ? lo : hi;

  describe('settings and caps', () => {
    it('clamps arbitrary settings to the documented safe range', () => {
      expect(WORST).toEqual({
        rate: FLICKER_SAFE_MAX_RATE,
        depth: FLICKER_SAFE_MAX_DEPTH - FLICKER_SAFE_MAX_SHIMMER,
        shimmer: FLICKER_SAFE_MAX_SHIMMER,
        shimmerRate: FLICKER_SAFE_MAX_SHIMMER_RATE,
      });
      expect(DEEPEST).toEqual({ rate: 4, depth: 1, shimmer: 0, shimmerRate: 0 });
      expect(flickerClamp({ rate: -3, depth: -1, shimmer: -0.5, shimmerRate: -9 })).toEqual({
        rate: 0,
        depth: 0,
        shimmer: 0,
        shimmerRate: 0,
      });
      expect(
        flickerClamp({ rate: Infinity, depth: Infinity, shimmer: Infinity, shimmerRate: Infinity }),
      ).toEqual(WORST);
      // A NaN from a bad URL parameter must not survive into a light.
      expect(flickerClamp({ rate: NaN, depth: NaN, shimmer: NaN, shimmerRate: NaN })).toEqual({
        rate: 0,
        depth: 0,
        shimmer: 0,
        shimmerRate: 0,
      });
    });

    it('leaves safe settings alone, is idempotent, and never lets the output clip', () => {
      const inside = { rate: 2.5, depth: 0.42, shimmer: 0.021, shimmerRate: 9 };
      expect(flickerClamp(inside)).toEqual(inside);
      expect(flickerIsSafe(inside)).toBe(true);
      expect(flickerIsSafe(FLICKER_DEFAULT)).toBe(true);
      expect(flickerIsSafe(WILD)).toBe(false);
      expect(flickerIsSafe({ ...inside, rate: 4.01 })).toBe(false);
      expect(flickerIsSafe({ ...inside, shimmer: 0.05 })).toBe(false);
      expect(flickerClamp(WORST)).toEqual(WORST);
      const random = flickerRandom(11);
      for (let i = 0; i < 200; i++) {
        const s = flickerClamp({
          rate: random() * 20 - 5,
          depth: random() * 3 - 1,
          shimmer: random() * 0.2 - 0.05,
          shimmerRate: random() * 80 - 10,
        });
        expect(flickerClamp(s)).toEqual(s);
        expect(s.depth + s.shimmer).toBeLessThanOrEqual(1);
        expect(s.rate).toBeLessThanOrEqual(FLICKER_SAFE_MAX_RATE);
        expect(s.shimmer).toBeLessThanOrEqual(FLICKER_SAFE_MAX_SHIMMER);
      }
    });

    it('chooses caps that sit inside the WCAG 2.3.1 definition with room to spare', () => {
      expect(FLICKER_FLASH_DELTA).toBe(0.1);
      expect(FLICKER_FLASH_DARK).toBe(0.8);
      expect(FLICKER_FLASH_LIMIT).toBe(3);
      // The fastest full swing is rate / 2 Hz: two a second, under the limit of three.
      expect(FLICKER_SAFE_MAX_RATE / 2).toBeLessThan(FLICKER_FLASH_LIMIT);
      // The shimmer's whole range is under half of one qualifying change, so a display gain of
      // 2.5 still cannot turn it into one.
      expect(FLICKER_SAFE_MAX_SHIMMER * 2.5).toBeLessThanOrEqual(FLICKER_FLASH_DELTA);
      expect(flickerIsSafe(FLICKER_DEFAULT)).toBe(true);
    });

    it('has the same constants, defaults and clamp in WGSL', async () => {
      const constants = await scalars('#include "flicker.wgsl"', [
        'FLICKER_PERIOD',
        'FLICKER_SAFE_MAX_RATE',
        'FLICKER_SAFE_MAX_DEPTH',
        'FLICKER_SAFE_MAX_SHIMMER',
        'FLICKER_SAFE_MAX_SHIMMER_RATE',
        'FLICKER_RATE_LIMIT',
        'FLICKER_DRIFT_SHARE',
        'flicker_default().rate',
        'flicker_default().depth',
        'flicker_default().shimmer',
        'flicker_default().shimmer_rate',
      ]);
      const expected = [
        FLICKER_PERIOD,
        FLICKER_SAFE_MAX_RATE,
        FLICKER_SAFE_MAX_DEPTH,
        FLICKER_SAFE_MAX_SHIMMER,
        FLICKER_SAFE_MAX_SHIMMER_RATE,
        FLICKER_RATE_LIMIT,
        FLICKER_DRIFT_SHARE,
        FLICKER_DEFAULT.rate,
        FLICKER_DEFAULT.depth,
        FLICKER_DEFAULT.shimmer,
        FLICKER_DEFAULT.shimmerRate,
      ];
      constants.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));

      const random = flickerRandom(5);
      const tuples = Array.from({ length: 256 }, () => [
        random() * 20 - 5,
        random() * 3 - 1,
        random() * 0.2 - 0.05,
        random() * 80 - 10,
      ]);
      const rows = rowsOf(tuples);
      const out = await gpuF32(
        `#include "flicker.wgsl"
         fn f(x: vec4f) -> vec4f {
           let s = flicker_clamp(flicker_settings(x.x, x.y, x.z, x.w));
           return vec4f(s.rate, s.depth, s.shimmer, s.shimmer_rate);
         }`,
        rows,
      );
      let worst = 0;
      for (let i = 0; i < tuples.length; i++) {
        const s = flickerClamp({
          rate: rows[i * 4]!,
          depth: rows[i * 4 + 1]!,
          shimmer: rows[i * 4 + 2]!,
          shimmerRate: rows[i * 4 + 3]!,
        });
        worst = Math.max(
          worst,
          Math.abs(out[i * 4]! - s.rate),
          Math.abs(out[i * 4 + 1]! - s.depth),
          Math.abs(out[i * 4 + 2]! - s.shimmer),
          Math.abs(out[i * 4 + 3]! - s.shimmerRate),
        );
      }
      expect(worst).toBeLessThan(1e-6);
    });
  });

  describe('flash counter', () => {
    it('counts a square wave as its frequency in flashes per second', () => {
      // n Hz is 2n changes a second; a closed one-second window can hold one more.
      for (const hz of [1, 2, 3, 4, 10]) {
        const count = countFlashes(flickerSample(flickerSquare(hz, 0.2, 0.9), 20), SAMPLE_HZ);
        expect(count.maxTransitions, `${hz} Hz`).toBe(2 * hz + 1);
        expect(count.maxFlashes, `${hz} Hz`).toBe(hz);
      }
      // So 3 Hz is the last frequency that passes, as WCAG words it.
      const at = (hz: number) =>
        countFlashes(flickerSample(flickerSquare(hz, 0, 1), 20), SAMPLE_HZ).maxFlashes;
      expect(at(3)).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
      expect(at(3.5)).toBeGreaterThan(FLICKER_FLASH_LIMIT);
    });

    it('lists every change once, at the sample where it reaches 10%', () => {
      const count = countFlashes(flickerSample(flickerSquare(2, 0.2, 0.9), 2), SAMPLE_HZ);
      // Starts high: falls at 0.25 s, rises at 0.5 s, ... 7 changes in 2 s.
      expect(count.transitions).toEqual([60, 120, 180, 240, 300, 360, 420]);
    });

    it('applies both thresholds: 10% of full white, and a darker state below 0.80', () => {
      const flashes = (lo: number, hi: number) =>
        countFlashes(flickerSample(flickerSquare(5, lo, hi), 10), SAMPLE_HZ).maxFlashes;
      expect(flashes(0.5, 0.59)).toBe(0); // 9%: too small
      expect(flashes(0.5, 0.6)).toBe(5); // exactly 10% counts ("10% or more")
      expect(flashes(0.85, 1.0)).toBe(0); // 15%, but the darker state is not below 0.80
      expect(flashes(0.8, 1.0)).toBe(0); // "below 0.80" is strict
      expect(flashes(0.79, 0.9)).toBe(5);
      expect(flashes(0, 1)).toBe(5);
    });

    it('uses hysteresis: ripple under 10% neither counts nor splits a larger change', () => {
      const ripple = (t: number) => 0.02 * Math.sin(2 * Math.PI * 31 * t);
      const swing = (t: number) => 0.5 + 0.3 * Math.sin(2 * Math.PI * t);
      expect(
        countFlashes(
          flickerSample((t) => 0.5 + ripple(t), 10),
          SAMPLE_HZ,
        ).maxFlashes,
      ).toBe(0);
      const clean = countFlashes(flickerSample(swing, 30), SAMPLE_HZ);
      const noisy = countFlashes(
        flickerSample((t) => swing(t) + ripple(t), 30),
        SAMPLE_HZ,
      );
      expect(clean.maxFlashes).toBe(1);
      expect(noisy.maxFlashes).toBe(1);
      expect(noisy.transitions.length).toBe(clean.transitions.length);
    });

    it('needs a pair of opposing changes: a single ramp or step is not a flash', () => {
      expect(
        countFlashes(
          flickerSample((t) => Math.min(1, t / 5), 10),
          SAMPLE_HZ,
        ),
      ).toEqual({
        transitions: [Math.ceil((0.1 - 1e-9) * 5 * SAMPLE_HZ)],
        maxTransitions: 1,
        maxFlashes: 0,
      });
      expect(
        countFlashes(
          flickerSample((t) => (t < 1 ? 1 : 0), 4),
          SAMPLE_HZ,
        ).maxFlashes,
      ).toBe(0);
      expect(countFlashes([], SAMPLE_HZ).maxFlashes).toBe(0);
      expect(countFlashes([0.5], SAMPLE_HZ).maxFlashes).toBe(0);
    });

    it('counts a fall whose darker end only later drops below 0.80', () => {
      // Falls 0.95 -> 0.84 (10% reached, still bright), keeps falling to 0.5, then recovers.
      const signal = (t: number) => (t < 1 ? 0.95 : t < 2 ? 0.84 : t < 3 ? 0.5 : 0.95);
      const count = countFlashes(flickerSample(signal, 5), SAMPLE_HZ);
      expect(count.transitions).toEqual([1 * SAMPLE_HZ, 3 * SAMPLE_HZ]);
      // The same fall that stops at 0.84 never qualifies.
      const shallow = (t: number) => (t < 1 ? 0.95 : t < 3 ? 0.84 : 0.95);
      expect(countFlashes(flickerSample(shallow, 5), SAMPLE_HZ).transitions).toEqual([]);
    });
  });

  describe('the capped signal stays under the WCAG 2.3.1 flash threshold', () => {
    it(
      'at the worst-case safe settings: at most 3 flashes in any second (240 Hz, 8 seeds x 10 min)',
      () => {
        let worstTransitions = 0;
        let changes = 0;
        for (const settings of [WILD, DEEPEST]) {
          for (let seed = 0; seed < 8; seed++) {
            const samples = flickerSample((t) => flickerIntensity(t, seed, settings), 600);
            const count = countFlashes(samples, SAMPLE_HZ);
            worstTransitions = Math.max(worstTransitions, count.maxTransitions);
            changes += count.transitions.length;
            expect(count.maxFlashes, `seed ${seed}`).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
          }
        }
        // The signal is really swinging: about one qualifying change a second, not a flat line.
        expect(changes).toBeGreaterThan(16 * 600);
        // The argument in flicker.wgsl allows 7 changes in a second; the hashed knots reach 5,
        // which is 2 flashes.
        expect(worstTransitions).toBeLessThanOrEqual(7);
        expect(worstTransitions).toBe(5);
      },
      SLOW_TEST,
    );

    it(
      'over the whole period, sampled off the frame grid, and through a display gain of 2.4',
      () => {
        // A whole 1024 s period at 250 Hz (not a multiple of any knot rate), read as luminance
        // through a steep monotone display curve: the shimmer cap leaves room for a gain of 2.5.
        const hz = 250;
        const samples = flickerSample((t) => flickerIntensity(t, 21, WILD), FLICKER_PERIOD, hz);
        expect(countFlashes(samples, hz).maxFlashes).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
        const displayed = samples.map((v) => Math.min(1, Math.max(0, (v - 0.4) * 2.4)));
        expect(countFlashes(displayed, hz).maxFlashes).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
      },
      SLOW_TEST,
    );

    it(
      'still holds when lights that share a rate are mixed over one area',
      () => {
        // Knots fall at the same instants for every seed, so a weighted sum is again a spline of
        // the same rate. Four lights, weights summing to 1.
        const weights = [0.4, 0.3, 0.2, 0.1];
        const samples = flickerSample(
          (t) =>
            weights.reduce((sum, w, seed) => sum + w * flickerIntensity(t, seed + 40, WILD), 0),
          600,
        );
        expect(countFlashes(samples, SAMPLE_HZ).maxFlashes).toBeLessThanOrEqual(
          FLICKER_FLASH_LIMIT,
        );
        // The mix must not be a trivially flat signal.
        expect(flickerStats(samples).deviation).toBeGreaterThan(0.05);
      },
      SLOW_TEST,
    );

    it(
      'holds for adversarial control values, not only the hashed ones',
      () => {
        // The same spline with control values chosen to hurt: strict alternation, random bits,
        // mostly alternating, plus a square-wave "shimmer" at the amplitude cap and any rate.
        const hz = 960;
        const signal = (controls: number[], shimmer: (t: number) => number) =>
          flickerSample(
            (t) => {
              const p = t * FLICKER_SAFE_MAX_RATE;
              const cell = Math.floor(p);
              const [wa, wb, wc] = flickerBasis(p - cell);
              const slow =
                wa * controls[cell % controls.length]! +
                wb * controls[(cell + 1) % controls.length]! +
                wc * controls[(cell + 2) % controls.length]!;
              return WORST.depth * slow + WORST.shimmer * shimmer(t);
            },
            60,
            hz,
          );
        let worst = 0;
        for (let trial = 0; trial < 60; trial++) {
          const random = flickerRandom(trial + 1);
          const kind = trial % 3;
          const controls = Array.from({ length: 240 }, (_, i) =>
            kind === 0
              ? i % 2
              : kind === 1
                ? Math.round(random())
                : random() < 0.8
                  ? i % 2
                  : 1 - (i % 2),
          );
          const shimmerHz = 5 + random() * 115;
          const phase = random();
          const count = countFlashes(
            signal(controls, (t) => Math.floor(t * shimmerHz + phase) % 2),
            hz,
          );
          worst = Math.max(worst, count.maxTransitions);
        }
        expect(worst).toBeLessThanOrEqual(7);
        expect(Math.floor(worst / 2)).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
        // Strict alternation is the fastest the spline can swing: exactly rate / 2 = 2 Hz.
        const alternating = countFlashes(
          signal([0, 1], () => 0),
          hz,
        );
        expect(alternating.maxFlashes).toBe(2);
      },
      SLOW_TEST,
    );

    it(
      'reverses at most once per knot interval (the lemma the cap rests on)',
      () => {
        // 240 samples per knot interval at the capped rate, so knots fall on samples. Without
        // shimmer the signal is the slow spline: three reversals can never fit in one interval.
        const hz = SAMPLE_HZ * FLICKER_SAFE_MAX_RATE;
        let reversals = 0;
        let closest = Infinity;
        for (let seed = 0; seed < 4; seed++) {
          const samples = flickerSample((t) => flickerIntensity(t, seed, DEEPEST), 200, hz);
          const at: number[] = [];
          for (let i = 1; i + 1 < samples.length; i++) {
            const before = samples[i]! - samples[i - 1]!;
            const after = samples[i + 1]! - samples[i]!;
            if (before * after < 0) at.push(i);
          }
          reversals += at.length;
          for (let i = 2; i < at.length; i++) closest = Math.min(closest, at[i]! - at[i - 2]!);
        }
        // Plenty of reversals to judge by: more than one a second.
        expect(reversals).toBeGreaterThan(4 * 200);
        // Two reversals may sit either side of a knot; a third needs a whole interval more.
        expect(closest).toBeGreaterThan(SAMPLE_HZ - 2);
      },
      SLOW_TEST,
    );
  });

  describe('the uncapped path', () => {
    it(
      'does exceed 3 flashes a second at aggressive settings, which the capped path prevents',
      () => {
        const aggressive: FlickerSettings[] = [
          { rate: 16, depth: 1, shimmer: 0, shimmerRate: 0 },
          { rate: 3, depth: 0.5, shimmer: 0.5, shimmerRate: 30 },
          { rate: 12, depth: 0.7, shimmer: 0.3, shimmerRate: 40 },
        ];
        for (const settings of aggressive) {
          const unsafe = countFlashes(
            flickerSample((t) => flickerIntensityUnsafe(t, 1, settings), 120),
            SAMPLE_HZ,
          );
          const safe = countFlashes(
            flickerSample((t) => flickerIntensity(t, 1, settings), 120),
            SAMPLE_HZ,
          );
          expect(unsafe.maxFlashes).toBeGreaterThan(FLICKER_FLASH_LIMIT);
          expect(safe.maxFlashes).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
        }
        // Even a modest step past the rate cap is enough: twice the cap gives four flashes.
        const doubled = countFlashes(
          flickerSample(
            (t) => flickerIntensityUnsafe(t, 1, { rate: 8, depth: 1, shimmer: 0, shimmerRate: 0 }),
            600,
          ),
          SAMPLE_HZ,
        );
        expect(doubled.maxFlashes).toBeGreaterThan(FLICKER_FLASH_LIMIT);
      },
      SLOW_TEST,
    );

    it('equals the capped path whenever the settings are already safe', () => {
      for (let i = 0; i < 500; i++) {
        const t = i * 0.731;
        expect(flickerIntensityUnsafe(t, 7, FLICKER_DEFAULT)).toBe(
          flickerIntensity(t, 7, FLICKER_DEFAULT),
        );
        expect(flickerOffsetUnsafe(t, 7, WORST)).toEqual(flickerOffset(t, 7, WILD));
      }
      expect(flickerIntensity(12.5, 3)).toBe(flickerIntensity(12.5, 3, FLICKER_DEFAULT));
    });

    it('stays in [0, 1] and tolerates nonsense settings', () => {
      const nonsense: FlickerSettings[] = [
        { rate: 1e9, depth: 50, shimmer: 50, shimmerRate: 1e9 },
        { rate: -5, depth: -1, shimmer: -1, shimmerRate: -5 },
        { rate: FLICKER_RATE_LIMIT, depth: 3, shimmer: 0, shimmerRate: FLICKER_RATE_LIMIT },
      ];
      for (const settings of nonsense) {
        for (let i = 0; i < 2000; i++) {
          const v = flickerIntensityUnsafe(i * 0.0173, 2, settings);
          expect(v >= 0 && v <= 1).toBe(true);
        }
      }
      // Negative depth and shimmer count as zero: a constant full-brightness light.
      expect(flickerIntensityUnsafe(3.3, 2, nonsense[1]!)).toBe(1);
    });
  });

  describe('range, mean and band limit', () => {
    it(
      'stays inside [1 - depth - shimmer, 1] with mean 1 - (depth + shimmer) / 2',
      () => {
        const cases: FlickerSettings[] = [
          WORST,
          DEEPEST,
          FLICKER_DEFAULT,
          { rate: 1.3, depth: 0.5, shimmer: 0.01, shimmerRate: 7 },
        ];
        for (const settings of cases) {
          const floor = 1 - settings.depth - settings.shimmer;
          const all: number[] = [];
          for (let seed = 0; seed < 8; seed++) {
            const samples = flickerSample(
              (t) => flickerIntensity(t, seed, settings),
              FLICKER_PERIOD,
              30,
            );
            for (const v of samples) all.push(v);
          }
          const stats = flickerStats(all);
          expect(stats.min).toBeGreaterThanOrEqual(floor);
          expect(stats.max).toBeLessThanOrEqual(1);
          expect(Math.abs(stats.mean - (1 - (settings.depth + settings.shimmer) / 2))).toBeLessThan(
            0.012 * Math.max(settings.depth, 0.1),
          );
        }
      },
      SLOW_TEST,
    );

    it(
      'has the documented spread: deviation about 0.15 of depth, 90% within about a quarter of it',
      () => {
        const all: number[] = [];
        for (let seed = 0; seed < 8; seed++) {
          for (const v of flickerSample(
            (t) => flickerIntensity(t, seed, DEEPEST),
            FLICKER_PERIOD,
            30,
          ))
            all.push(v);
        }
        const stats = flickerStats(all);
        expect(stats.deviation).toBeGreaterThan(0.14);
        expect(stats.deviation).toBeLessThan(0.16);
        expect(stats.mean - stats.p05).toBeGreaterThan(0.22);
        expect(stats.mean - stats.p05).toBeLessThan(0.28);
        expect(stats.p95 - stats.mean).toBeGreaterThan(0.22);
        expect(stats.p95 - stats.mean).toBeLessThan(0.28);
        // It uses most of the range over time, but never reaches the ends.
        expect(stats.min).toBeLessThan(0.1);
        expect(stats.max).toBeGreaterThan(0.9);
      },
      SLOW_TEST,
    );

    it(
      'is band-limited: the change per 1/240 s never exceeds the documented slope bound',
      () => {
        const bound = (s: FlickerSettings) =>
          ((1 - 0.75 * FLICKER_DRIFT_SHARE) * s.depth * s.rate + s.shimmer * s.shimmerRate) /
          SAMPLE_HZ;
        // The header quotes these: 0.7 * depth * rate + shimmer * shimmer_rate, 3.65 /s at the caps.
        expect(1 - 0.75 * FLICKER_DRIFT_SHARE).toBeCloseTo(0.7, 12);
        expect(bound(WORST) * SAMPLE_HZ).toBeCloseTo(3.648, 3);
        for (const settings of [WORST, DEEPEST, FLICKER_DEFAULT]) {
          let step = 0;
          for (let seed = 0; seed < 4; seed++) {
            step = Math.max(
              step,
              flickerMaxStep(flickerSample((t) => flickerIntensity(t, seed, settings), 600)),
            );
          }
          // 1e-4 covers the f32 rounding of the phase.
          expect(step).toBeLessThanOrEqual(bound(settings) + 1e-4);
          // And the bound is not slack by an order of magnitude: the signal does move that fast.
          expect(step).toBeGreaterThan(0.5 * bound(settings));
        }
        // At the caps a 240 Hz sample moves less than 1.6% of full white.
        expect(bound(WORST)).toBeLessThan(0.016);
      },
      SLOW_TEST,
    );

    it('repeats exactly every FLICKER_PERIOD seconds, with no seam, for any rate', () => {
      const settings = [
        FLICKER_DEFAULT,
        { rate: 2.7183, depth: 0.5, shimmer: 0.03, shimmerRate: 11.17 },
        { rate: 37.3, depth: 0.9, shimmer: 0.4, shimmerRate: 91.7 },
      ];
      for (const s of settings) {
        for (let i = 0; i < 400; i++) {
          const t = i * 2.5625; // exactly representable, so t + 1024 is the same instant
          expect(flickerIntensityUnsafe(t + FLICKER_PERIOD, 9, s)).toBe(
            flickerIntensityUnsafe(t, 9, s),
          );
          expect(flickerIntensityUnsafe(t - 3 * FLICKER_PERIOD, 9, s)).toBe(
            flickerIntensityUnsafe(t, 9, s),
          );
          expect(flickerOffsetUnsafe(t + FLICKER_PERIOD, 9, s)).toEqual(
            flickerOffsetUnsafe(t, 9, s),
          );
        }
      }
      // Across the wrap the signal is as smooth as anywhere else.
      const around = flickerSample(
        (t) => flickerIntensity(FLICKER_PERIOD - 1 + t, 9, WORST),
        2,
        SAMPLE_HZ,
      );
      expect(flickerMaxStep(around)).toBeLessThan(0.016);
    });

    it('is constant when a rate is zero, and frozen parts keep their range', () => {
      const still = { rate: 0, depth: 0.6, shimmer: 0.04, shimmerRate: 0 };
      const first = flickerIntensity(0, 5, still);
      for (let i = 1; i < 200; i++) expect(flickerIntensity(i * 1.37, 5, still)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(1 - 0.64);
      expect(first).toBeLessThanOrEqual(1);
      expect(flickerOffset(77, 5, still)).toEqual(flickerOffset(0, 5, still));
      // Depth and shimmer of zero give a steady light at full brightness.
      expect(flickerIntensity(4.2, 5, { rate: 3, depth: 0, shimmer: 0, shimmerRate: 12 })).toBe(1);
    });

    it(
      'gives independent signals for different seeds, and for intensity and offset',
      () => {
        const signal = (seed: number) =>
          flickerSample((t) => flickerIntensity(t, seed, WORST), FLICKER_PERIOD, 30);
        const signals = [0, 1, 2, 3, 1000, 0xffffffff].map(signal);
        for (let a = 0; a < signals.length; a++) {
          for (let b = a + 1; b < signals.length; b++) {
            expect(Math.abs(flickerCorrelation(signals[a]!, signals[b]!))).toBeLessThan(0.15);
          }
        }
        const x = flickerSample((t) => flickerOffset(t, 1, WORST)[0], FLICKER_PERIOD, 30);
        const y = flickerSample((t) => flickerOffset(t, 1, WORST)[1], FLICKER_PERIOD, 30);
        expect(Math.abs(flickerCorrelation(x, y))).toBeLessThan(0.15);
        expect(Math.abs(flickerCorrelation(x, signals[1]!))).toBeLessThan(0.15);
        expect(Math.abs(flickerCorrelation(y, signals[1]!))).toBeLessThan(0.15);
      },
      SLOW_TEST,
    );

    it(
      'offset: inside [-1, 1] per axis, mean 0, rms about 0.31, slope bounded by the rate',
      () => {
        for (const axis of [0, 1] as const) {
          const all: number[] = [];
          let step = 0;
          for (let seed = 0; seed < 6; seed++) {
            const samples = flickerSample((t) => flickerOffset(t, seed, WILD)[axis], 600);
            step = Math.max(step, flickerMaxStep(samples));
            for (let i = 0; i < samples.length; i += 8) all.push(samples[i]!);
          }
          const stats = flickerStats(all);
          expect(stats.min).toBeGreaterThanOrEqual(-1);
          expect(stats.max).toBeLessThanOrEqual(1);
          expect(Math.abs(stats.mean)).toBeLessThan(0.03);
          expect(stats.deviation).toBeGreaterThan(0.28);
          expect(stats.deviation).toBeLessThan(0.34);
          // Twice the intensity's slow slope at depth 1, because the range is twice as wide.
          expect(step).toBeLessThanOrEqual((2 * 0.7 * FLICKER_SAFE_MAX_RATE) / SAMPLE_HZ + 1e-4);
        }
      },
      SLOW_TEST,
    );
  });

  describe('WGSL and TypeScript agree', () => {
    // Lane 0 safe intensity, lane 1 unsafe intensity, lanes 2-3 offset (safe for variant 0 and 1,
    // unsafe otherwise). The seed is scrambled in the shader so high bits are exercised too.
    const VARIANTS: FlickerSettings[] = [
      FLICKER_DEFAULT,
      WILD,
      { rate: 37.3, depth: 0.9, shimmer: 0.4, shimmerRate: 91.7 },
      { rate: 2.7183, depth: 0.55, shimmer: 0.025, shimmerRate: 11.17 },
      { rate: 0, depth: 0.5, shimmer: 0.04, shimmerRate: 0 },
    ];
    const wgslSettings = (s: FlickerSettings) =>
      `flicker_settings(${[s.rate, s.depth, s.shimmer, s.shimmerRate].map((v) => v.toExponential()).join(', ')})`;
    const AGREEMENT_WGSL = `#include "flicker.wgsl"
      fn f(x: vec4f) -> vec4f {
        let seed = u32(x.y) * 2654435761u + u32(x.w);
        var s = flicker_default();
        ${VARIANTS.map((s, i) => `if (i32(x.z) == ${i}) { s = ${wgslSettings(s)}; }`).join('\n        ')}
        var offset = flicker_offset(x.x, seed, s);
        if (i32(x.z) >= 2) { offset = flicker_offset_unsafe(x.x, seed, s); }
        return vec4f(flicker_intensity(x.x, seed, s), flicker_intensity_unsafe(x.x, seed, s), offset);
      }`;
    const scrambled = (seed: number, salt: number) => (Math.imul(seed, 2654435761) + salt) >>> 0;

    function reference(rows: Float32Array): Float64Array {
      const expected = new Float64Array(rows.length);
      for (let i = 0; i < rows.length; i += 4) {
        const t = rows[i]!;
        const seed = scrambled(rows[i + 1]!, rows[i + 3]!);
        const variant = rows[i + 2]!;
        const s = VARIANTS[variant]!;
        const offset = variant >= 2 ? flickerOffsetUnsafe(t, seed, s) : flickerOffset(t, seed, s);
        expected[i] = flickerIntensity(t, seed, s);
        expected[i + 1] = flickerIntensityUnsafe(t, seed, s);
        expected[i + 2] = offset[0];
        expected[i + 3] = offset[1];
      }
      return expected;
    }

    function worstDifference(actual: Float32Array, expected: Float64Array): number {
      let worst = 0;
      for (let i = 0; i < actual.length; i++)
        worst = Math.max(worst, Math.abs(actual[i]! - expected[i]!));
      return worst;
    }

    it(
      'to 2e-6 over 20000 random times, seeds and settings, inside and outside the period',
      async () => {
        const random = flickerRandom(2024);
        const tuples: number[][] = [];
        for (let i = 0; i < 20_000; i++) {
          // Mostly inside one period; one in four far outside it, negative included.
          const t = i % 4 === 0 ? random() * 40_000 - 10_000 : random() * FLICKER_PERIOD;
          tuples.push([t, Math.floor(random() * 4096), i % VARIANTS.length, i % 7]);
        }
        const rows = rowsOf(tuples);
        const out = await gpuF32(AGREEMENT_WGSL, rows);
        // Tolerance 2e-6. Measured 2.1e-7 on Dawn/Metal (Apple Silicon): a few f32 rounding steps
        // in the spline weights. The twin rounds time and phase to f32 exactly as the shader
        // does, so both sides read the same knots at the same fraction.
        expect(worstDifference(out, reference(rows))).toBeLessThan(2e-6);
        // The comparison is of a live signal, not of constants.
        expect(flickerStats(lane(out, 0)).deviation).toBeGreaterThan(0.05);
        expect(flickerStats(lane(out, 2)).deviation).toBeGreaterThan(0.05);
      },
      SLOW_TEST,
    );

    it(
      'along a dense time sweep, including the knots and the wrap of the period',
      async () => {
        // 4 s at 960 Hz ending on the period boundary and running past it: every knot of the
        // capped rate falls exactly on a sample, where the spline switches control values.
        const tuples: number[][] = [];
        for (let i = 0; i < 8 * 960; i++) tuples.push([FLICKER_PERIOD - 4 + i / 960, 3, 1, 0]);
        // And the first knots after zero, plus times at (or one rounding step from) the knots
        // of the default rate.
        for (let i = 0; i < 960; i++) tuples.push([i / 960, 3, 1, 0]);
        for (let i = 0; i < 600; i++) tuples.push([i / 3, 12, 0, 0]);
        const rows = rowsOf(tuples);
        const out = await gpuF32(AGREEMENT_WGSL, rows);
        expect(worstDifference(out, reference(rows))).toBeLessThan(2e-6);
        // The GPU signal is continuous across the wrap too: the slope bound of 3.648 /s over one
        // sample, plus one f32 step of the time (2^-13 s just above 1024 s).
        expect(flickerMaxStep(lane(out, 0).slice(0, 8 * 960))).toBeLessThan(
          3.648 * (1 / 960 + 1 / 8192) + 1e-4,
        );
      },
      SLOW_TEST,
    );

    it('on the GPU the signal repeats bit for bit after one period', async () => {
      const tuples: number[][] = [];
      for (let i = 0; i < 512; i++) {
        const t = i * 1.71875; // multiples of 2^-5: t + 1024 is exact in f32
        tuples.push([t, 5, 3, 0], [t + FLICKER_PERIOD, 5, 3, 0]);
      }
      const out = await gpuF32(AGREEMENT_WGSL, rowsOf(tuples));
      for (let i = 0; i < out.length; i += 8) {
        expect(Array.from(out.subarray(i + 4, i + 8))).toEqual(Array.from(out.subarray(i, i + 4)));
      }
    });
  });

  describe('the rendered test scene', () => {
    // End to end: the `flicker` effect rendered headlessly at 60 frames a second, the result read
    // back as the 8-bit sRGB a display would show, and WCAG relative luminance averaged over a
    // 12 x 9 grid of blocks. Every block is then a "large area" signal for the flash counter.
    const COLUMNS = 12;
    const ROWS = 9;
    const BLOCK = 8;
    const FPS = 60;

    async function flickerSceneFlashes(params: Record<string, unknown>, seconds: number) {
      const width = COLUMNS * BLOCK;
      const height = ROWS * BLOCK;
      const mounted = await mountHeadless('flicker', { width, height, params, fps: FPS });
      const toLinear = Float64Array.from({ length: 256 }, (_, byte) => {
        const c = byte / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      const frames = Math.round(seconds * FPS);
      const series = Array.from({ length: COLUMNS * ROWS }, () => new Float64Array(frames));
      for (let frame = 0; frame < frames; frame++) {
        mounted.step();
        const rgba = await mounted.read();
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const luminance =
              0.2126 * toLinear[rgba[i]!]! +
              0.7152 * toLinear[rgba[i + 1]!]! +
              0.0722 * toLinear[rgba[i + 2]!]!;
            const block = Math.floor(y / BLOCK) * COLUMNS + Math.floor(x / BLOCK);
            series[block]![frame]! += luminance / (BLOCK * BLOCK);
          }
        }
      }
      mounted.destroy();
      let maxFlashes = 0;
      let swing = 0;
      for (const block of series) {
        maxFlashes = Math.max(maxFlashes, countFlashes(block, FPS).maxFlashes);
        const stats = flickerStats(block);
        swing = Math.max(swing, stats.max - stats.min);
      }
      return { maxFlashes, swing };
    }

    /** The `clamped` preset's request: far outside every cap. */
    const OVERDRIVEN = { rate: 12, depth: 1, shimmer: 0.3, shimmerRate: 40 };

    it(
      'stays under the flash threshold on screen with the caps on, at any request',
      async () => {
        // Measured: 1 flash a second at the defaults, 2 with the request clamped to the caps.
        const calm = await flickerSceneFlashes({}, 30);
        expect(calm.maxFlashes).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
        const clamped = await flickerSceneFlashes(OVERDRIVEN, 30);
        expect(clamped.maxFlashes).toBeLessThanOrEqual(FLICKER_FLASH_LIMIT);
        // The picture really is flickering: some block's luminance swings by well over 10%.
        expect(clamped.swing).toBeGreaterThan(0.2);
      },
      SLOW_TEST,
    );

    it(
      'exceeds it with the caps off, which is why the switch is off by default',
      async () => {
        // Measured: 7 flashes a second.
        const uncapped = await flickerSceneFlashes({ ...OVERDRIVEN, uncapped: true }, 20);
        expect(uncapped.maxFlashes).toBeGreaterThan(FLICKER_FLASH_LIMIT);
      },
      SLOW_TEST,
    );
  });
});

// flame.wgsl: every number below was produced by the WebGPU implementation, and the references it
// is compared with are written independently in plain JS (nearest boundary feature, not the
// region tests the shader uses).
describe('flame shaping', () => {
  const FLAME = '#include "flame.wgsl"\n';
  const TOLERANCE = 2e-6;

  /** Runs a WGSL body that maps the row `x: vec4f` to a vec4f, with flame.wgsl included. */
  const flameEval = (body: string, rows: number[][]): Promise<Float32Array> =>
    gpuF32(`${FLAME} fn f(x: vec4f) -> vec4f { ${body} }`, rowsOf(rows));

  /** Deterministic uniform numbers in [0, 1) (mulberry32). */
  function flameRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** `count` points spread over a box that contains the flame with a wide margin. */
  function flamePoints(count: number, seed: number): [number, number][] {
    const random = flameRandom(seed);
    return Array.from({ length: count }, () => [
      Math.fround(-1.2 + 2.4 * random()),
      Math.fround(-0.6 + 2.2 * random()),
    ]);
  }

  type Point = readonly [number, number];

  function distanceToSegment(p: Point, a: Point, b: Point): number {
    const [px, py] = [p[0] - a[0], p[1] - a[1]];
    const [bx, by] = [b[0] - a[0], b[1] - a[1]];
    const lengthSquared = bx * bx + by * by;
    const h = lengthSquared > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / lengthSquared)) : 0;
    return Math.hypot(px - bx * h, py - by * h);
  }

  /** Teardrop: the nearest of {arc below the tangent points, tangent segment}, signed by containment. */
  function refTeardrop(x: number, y: number, halfWidth: number, height: number): number {
    const r = Math.min(halfWidth, height / 2);
    const sin = r / (height - r);
    const cos = Math.sqrt(Math.max(1 - sin * sin, 0));
    const tangent: Point = [r * cos, r + r * sin];
    const ax = Math.abs(x);
    const fromCentre = Math.hypot(ax, y - r);
    const onArc = y - r <= sin * fromCentre;
    const distance = Math.min(
      distanceToSegment([ax, y], tangent, [0, height]),
      onArc ? Math.abs(fromCentre - r) : Infinity,
    );
    const inCircle = fromCentre < r;
    const inCone =
      y >= tangent[1] && y < height && ax < (tangent[0] * (height - y)) / (height - tangent[1]);
    return inCircle || inCone ? -distance : distance;
  }

  /** Taper: the nearest of its base, side and top, signed by containment. */
  function refTaper(x: number, y: number, base: number, tip: number, height: number): number {
    const ax = Math.abs(x);
    const p: Point = [ax, y];
    const distance = Math.min(
      distanceToSegment(p, [0, 0], [base, 0]),
      distanceToSegment(p, [base, 0], [tip, height]),
      distanceToSegment(p, [0, height], [tip, height]),
    );
    const inside = y > 0 && y < height && ax < base + ((tip - base) * y) / height;
    return inside ? -distance : distance;
  }

  const TEARDROPS: [number, number][] = [
    [0.19, 1],
    [0.36, 1],
    [0.5, 1], // the limit: a circle
    [0.06, 0.4],
    [0.3, 2],
  ];
  const TAPERS: [number, number, number][] = [
    [0.26, 0.03, 1],
    [0.2, 0, 1], // a cone
    [0.2, 0.2, 1], // a column
    [0.1, 0.3, 1], // widening
    [0.4, 0.1, 0.5],
  ];

  describe('silhouettes', () => {
    it('teardrop: zero on the surface at the tip, base, sides and along the tangent line', async () => {
      const w = 0.19;
      const sin = w / (1 - w);
      const cos = Math.sqrt(1 - sin * sin);
      // Halfway between the tangent point and the tip.
      const mid = [(w * cos) / 2, (w + w * sin + 1) / 2] as const;
      const [tip, base, right, left, low, onLine, centre, above, below, beside] = await scalars(
        FLAME,
        [
          `flame_sd_teardrop(vec2f(0.0, 1.0), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(0.0, 0.0), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(${w}, ${w}), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(-${w}, ${w}), ${w}, 1.0)`,
          // 45 degrees below the centre, on the circle.
          `flame_sd_teardrop(vec2f(${w * Math.SQRT1_2}, ${w - w * Math.SQRT1_2}), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(${mid[0]}, ${mid[1]}), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(0.0, ${w}), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(0.0, 1.5), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(0.0, -0.3), ${w}, 1.0)`,
          `flame_sd_teardrop(vec2f(${w} + 0.4, ${w}), ${w}, 1.0)`,
        ],
      );
      for (const surface of [tip, base, right, left, low, onLine])
        expect(surface).toBeCloseTo(0, 5);
      // Negative inside, deepest at the circle's centre; positive outside by the true distance.
      expect(centre).toBeCloseTo(-w, 5);
      expect(above).toBeCloseTo(0.5, 5);
      expect(below).toBeCloseTo(0.3, 5);
      expect(beside).toBeCloseTo(0.4, 5);
    });

    it('taper: zero on the base, top and corners, exact distances off the faces', async () => {
      const [baseMid, topMid, corner, topCorner, coneTip, centre, below, beside, diagonal, above] =
        await scalars(FLAME, [
          'flame_sd_taper(vec2f(0.0, 0.0), 0.26, 0.03, 1.0)',
          'flame_sd_taper(vec2f(0.0, 1.0), 0.26, 0.03, 1.0)',
          'flame_sd_taper(vec2f(-0.26, 0.0), 0.26, 0.03, 1.0)',
          'flame_sd_taper(vec2f(0.03, 1.0), 0.26, 0.03, 1.0)',
          'flame_sd_taper(vec2f(0.0, 1.0), 0.2, 0.0, 1.0)',
          // A column 0.4 wide and 1 tall.
          'flame_sd_taper(vec2f(0.0, 0.5), 0.2, 0.2, 1.0)',
          'flame_sd_taper(vec2f(0.05, -0.25), 0.2, 0.2, 1.0)',
          'flame_sd_taper(vec2f(0.5, 0.5), 0.2, 0.2, 1.0)',
          'flame_sd_taper(vec2f(0.5, -0.4), 0.2, 0.2, 1.0)',
          'flame_sd_taper(vec2f(0.0, 1.75), 0.2, 0.2, 1.0)',
        ]);
      for (const surface of [baseMid, topMid, corner, topCorner, coneTip])
        expect(surface).toBeCloseTo(0, 5);
      expect(centre).toBeCloseTo(-0.2, 5);
      expect(below).toBeCloseTo(0.25, 5);
      expect(beside).toBeCloseTo(0.3, 5);
      expect(diagonal).toBeCloseTo(0.5, 5); // 3-4-5 from the corner (0.2, 0)
      expect(above).toBeCloseTo(0.75, 5);
    });

    it.each(TEARDROPS)(
      'teardrop(%f, %f) is the exact signed distance at 4000 random points',
      async (w, h) => {
        const points = flamePoints(4000, 11);
        const out = lane(
          await flameEval(
            `return vec4f(flame_sd_teardrop(x.xy, ${w}, ${h}), 0.0, 0.0, 0.0);`,
            points,
          ),
          0,
        );
        let worst = 0;
        let inside = 0;
        points.forEach(([x, y], i) => {
          const expected = refTeardrop(x, y, w, h);
          worst = Math.max(worst, Math.abs((out[i] ?? NaN) - expected));
          if (expected < 0) inside++;
        });
        expect(worst).toBeLessThan(TOLERANCE);
        expect(inside).toBeGreaterThan(10); // the sample really does cover the interior
      },
    );

    it.each(TAPERS)(
      'taper(%f, %f, %f) is the exact signed distance at 4000 random points',
      async (base, tip, h) => {
        const points = flamePoints(4000, 12);
        const out = lane(
          await flameEval(
            `return vec4f(flame_sd_taper(x.xy, ${base}, ${tip}, ${h}), 0.0, 0.0, 0.0);`,
            points,
          ),
          0,
        );
        let worst = 0;
        let inside = 0;
        points.forEach(([x, y], i) => {
          const expected = refTaper(x, y, base, tip, h);
          worst = Math.max(worst, Math.abs((out[i] ?? NaN) - expected));
          if (expected < 0) inside++;
        });
        expect(worst).toBeLessThan(TOLERANCE);
        expect(inside).toBeGreaterThan(10);
      },
    );

    /**
     * Largest |f(a) - f(b)| / |a - b| over random pairs 0.02 to 0.2 apart, half of them placed
     * inside or just around the flame so the interior is measured as well as the far field.
     */
    async function lipschitz(expression: (p: string) => string, seed: number): Promise<number> {
      const random = flameRandom(seed);
      const pairs: number[][] = [];
      for (let i = 0; i < 6000; i++) {
        const near = i % 2 === 0;
        const ax = near ? -0.45 + 0.9 * random() : -1.2 + 2.4 * random();
        const ay = near ? -0.1 + 1.2 * random() : -0.6 + 2.2 * random();
        const angle = 2 * Math.PI * random();
        const step = 0.02 + 0.18 * random();
        pairs.push(
          [ax, ay, ax + step * Math.cos(angle), ay + step * Math.sin(angle)].map(Math.fround),
        );
      }
      const out = await flameEval(
        `return vec4f(${expression('x.xy')}, ${expression('x.zw')}, 0.0, 0.0);`,
        pairs,
      );
      let worst = 0;
      pairs.forEach(([ax = 0, ay = 0, bx = 0, by = 0], i) => {
        const change = Math.abs((out[i * 4] ?? NaN) - (out[i * 4 + 1] ?? NaN));
        worst = Math.max(worst, change / Math.hypot(ax - bx, ay - by));
      });
      return worst;
    }

    it('both distances are Lipschitz-1: 6000 random pairs per shape, inside and outside', async () => {
      const measured: number[] = [];
      for (const [w, h] of TEARDROPS)
        measured.push(await lipschitz((p) => `flame_sd_teardrop(${p}, ${w}, ${h})`, 21));
      for (const [base, tip, h] of TAPERS)
        measured.push(await lipschitz((p) => `flame_sd_taper(${p}, ${base}, ${tip}, ${h})`, 22));
      for (const constant of measured) {
        // Never steeper than a distance (f32 round-off only), and as steep as one somewhere.
        expect(constant).toBeLessThanOrEqual(1 + 1e-5);
        expect(constant).toBeGreaterThan(0.999);
      }
    });

    it('a swayed distance is a bound with constant 1 + noise * amount * power / height', async () => {
      // Constant noise, so only the envelope bends space: amount 0.3, power 2, height 1.
      const bound = 1 + 0.3 * 2;
      const swayed = await lipschitz(
        (p) =>
          `flame_sd_teardrop(flame_turbulence(${p}, vec2f(1.0, 0.0), 0.3, 1.0, 2.0), 0.19, 1.0)`,
        23,
      );
      expect(swayed).toBeGreaterThan(1.05); // no longer a true distance...
      expect(swayed).toBeLessThanOrEqual(bound); // ...but within the stated bound
    });

    it('is mirror-symmetric in x, bit for bit', async () => {
      const points = flamePoints(2000, 31);
      const out = await flameEval(
        `let m = vec2f(-x.x, x.y);
         return vec4f(flame_sd_teardrop(x.xy, 0.19, 1.0), flame_sd_teardrop(m, 0.19, 1.0),
                      flame_sd_taper(x.xy, 0.26, 0.03, 1.0), flame_sd_taper(m, 0.26, 0.03, 1.0));`,
        points,
      );
      expect(lane(out, 0)).toEqual(lane(out, 1));
      expect(lane(out, 2)).toEqual(lane(out, 3));
    });
  });

  describe('height envelopes', () => {
    it('tip weight is exactly 0 at and below the base, 1 at and above the tip, t^power between', async () => {
      const [below, base, quarter, half, tip, above, sqrtHalf, tiny] = await scalars(FLAME, [
        'flame_tip_weight(-0.5, 2.0)',
        'flame_tip_weight(0.0, 0.5)',
        'flame_tip_weight(0.25, 2.0)',
        'flame_tip_weight(0.5, 1.0)',
        'flame_tip_weight(1.0, 1.7)',
        'flame_tip_weight(3.0, 1.7)',
        'flame_tip_weight(0.25, 0.5)',
        'flame_tip_weight(0.0, 0.0)', // power is clamped, so even this stays anchored
      ]);
      expect(below).toBe(0);
      expect(base).toBe(0);
      expect(tiny).toBe(0);
      expect(quarter).toBeCloseTo(0.0625, 6);
      expect(half).toBeCloseTo(0.5, 6);
      expect(sqrtHalf).toBeCloseTo(0.5, 6);
      expect(tip).toBeCloseTo(1, 6);
      expect(above).toBeCloseTo(1, 6);
    });

    it('height falloff holds 1 up to `start`, reaches 0 at the tip, and the power sets the curve', async () => {
      const [below, atStart, mid, tip, above, slow, fast] = await scalars(FLAME, [
        'flame_height_falloff(-1.0, 0.2, 1.0)',
        'flame_height_falloff(0.2, 0.2, 1.0)',
        'flame_height_falloff(0.6, 0.2, 1.0)',
        'flame_height_falloff(1.0, 0.2, 0.3)',
        'flame_height_falloff(2.0, 0.2, 0.3)',
        'flame_height_falloff(0.6, 0.2, 0.5)',
        'flame_height_falloff(0.6, 0.2, 2.0)',
      ]);
      expect(below).toBe(1);
      expect(atStart).toBe(1);
      expect(mid).toBeCloseTo(0.5, 6);
      expect(tip).toBe(0);
      expect(above).toBe(0);
      expect(slow).toBeCloseTo(Math.sqrt(0.5), 5);
      expect(fast).toBeCloseTo(0.25, 5);

      // Monotone: never rises with height, for a gentle and a steep curve.
      const heights = Array.from({ length: 141 }, (_, i) => [-0.2 + i * 0.01]);
      const out = await flameEval(
        'return vec4f(flame_height_falloff(x.x, 0.2, 0.45), flame_height_falloff(x.x, 0.0, 2.5), 0.0, 0.0);',
        heights,
      );
      for (const curve of [lane(out, 0), lane(out, 1)]) {
        for (let i = 1; i < curve.length; i++)
          expect(curve[i] ?? NaN).toBeLessThanOrEqual(curve[i - 1] ?? NaN);
        expect(Math.max(...curve)).toBe(1);
        expect(Math.min(...curve)).toBe(0);
      }
    });
  });

  describe('turbulence', () => {
    it('leaves the base exactly where it is and moves the tip by the full amount', async () => {
      // Rows: a point and a (large) noise pair. Everything at or below y = 0 must come back
      // bit-identical, whatever the noise.
      const random = flameRandom(41);
      const rows: number[][] = [];
      for (let i = 0; i < 400; i++)
        rows.push(
          [-1 + 2 * random(), -random(), -50 + 100 * random(), -50 + 100 * random()].map(
            Math.fround,
          ),
        );
      rows.push([0.3, 0, 7, -9], [-0.7, 0, 1, 1]);
      const out = await flameEval(
        'return vec4f(flame_turbulence(x.xy, x.zw, 0.4, 1.0, 1.6), 0.0, 0.0);',
        rows,
      );
      rows.forEach(([x = 0, y = 0], i) => {
        expect(out[i * 4]).toBe(Math.fround(x));
        expect(out[i * 4 + 1]).toBe(Math.fround(y));
      });

      const [tipX, tipY, aboveX, midX] = await scalars(FLAME, [
        'flame_turbulence(vec2f(0.1, 1.0), vec2f(1.0, -0.5), 0.4, 1.0, 1.6).x',
        'flame_turbulence(vec2f(0.1, 1.0), vec2f(1.0, -0.5), 0.4, 1.0, 1.6).y',
        'flame_turbulence(vec2f(0.1, 2.5), vec2f(-1.0, 0.0), 0.4, 1.0, 1.6).x',
        // Half-way up a flame 2 tall with power 2: a quarter of the amount.
        'flame_turbulence(vec2f(0.0, 1.0), vec2f(1.0, 0.0), 0.4, 2.0, 2.0).x',
      ]);
      expect(tipX).toBeCloseTo(0.5, 6);
      expect(tipY).toBeCloseTo(0.8, 6);
      expect(aboveX).toBeCloseTo(-0.3, 6);
      expect(midX).toBeCloseTo(0.1, 6);
    });

    it('displacement grows monotonically with height', async () => {
      const heights = Array.from({ length: 121 }, (_, i) => [0, (i - 10) / 100]);
      const out = await flameEval(
        `return vec4f(flame_turbulence(x.xy, vec2f(1.0, 0.0), 0.4, 1.0, 1.6).x,
                      flame_turbulence(x.xy, vec2f(1.0, 0.0), 0.4, 1.0, 0.5).x, 0.0, 0.0);`,
        heights,
      );
      for (const travel of [lane(out, 0), lane(out, 1)]) {
        for (let i = 1; i < travel.length; i++)
          expect(travel[i] ?? NaN).toBeGreaterThanOrEqual(travel[i - 1] ?? NaN);
        // Strictly growing between the base (index 10) and the tip (index 110).
        for (let i = 11; i <= 110; i++)
          expect(travel[i] ?? NaN).toBeGreaterThan(travel[i - 1] ?? NaN);
        expect(travel[10]).toBe(0);
        expect(travel[110]).toBeCloseTo(0.4, 6);
      }
    });
  });

  describe('erosion', () => {
    it('zero noise or zero amount returns the distance unchanged; the tip loses the most', async () => {
      const random = flameRandom(51);
      const rows: number[][] = [];
      for (let i = 0; i < 500; i++)
        rows.push([-1 + 2 * random(), 3 * random(), -0.5 + 2 * random(), 0].map(Math.fround));
      // Row: (d, amount, t).
      const out = await flameEval(
        `return vec4f(flame_erode(x.x, 0.0, x.y, x.z, 1.1), flame_erode(x.x, 0.83, 0.0, x.z, 1.1),
                      flame_erode(x.x, 0.83, x.y, 0.0, 1.1), 0.0);`,
        rows,
      );
      rows.forEach(([d = 0], i) => {
        expect(out[i * 4]).toBe(d); // no noise
        expect(out[i * 4 + 1]).toBe(d); // no amount
        expect(out[i * 4 + 2]).toBe(d); // at the base
      });

      const [tip, low, high, grown] = await scalars(FLAME, [
        'flame_erode(-0.1, 1.0, 0.25, 1.0, 1.1)',
        'flame_erode(-0.1, 1.0, 0.25, 0.1, 1.1)',
        'flame_erode(-0.1, 1.0, 0.25, 0.9, 1.1)',
        'flame_erode(-0.1, -1.0, 0.25, 1.0, 1.1)',
      ]);
      expect(tip).toBeCloseTo(0.15, 6); // the surface receded by the whole amount
      expect(low).toBeCloseTo(-0.1 + 0.25 * 0.1 ** 1.1, 5);
      expect(high).toBeGreaterThan(low ?? NaN);
      expect(grown).toBeCloseTo(-0.35, 6); // negative noise grows the shape instead
    });
  });

  describe('heat', () => {
    const DEFAULTS = 'let fp = flame_params_default();';

    it('the defaults constructor matches its documentation', async () => {
      const fields = [
        'half_width',
        'height',
        'turbulence',
        'turbulence_curve',
        'erosion',
        'erosion_curve',
        'core',
        'hot',
        'falloff',
        'base_soft',
      ];
      const values = await scalars(FLAME, [
        ...fields.map((field) => `flame_params_default().${field}`),
        'flame_params(0.3, 2.0).half_width',
        'flame_params(0.3, 2.0).height',
        'flame_params(0.3, 2.0).erosion',
      ]);
      const expected = [0.19, 1, 0.6, 1.6, 0.85, 1.1, 0.85, 0.2, 0.45, 0.8, 0.3, 2, 0.85];
      values.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 6));
    });

    it('stays in 0..1 for every position and noise, in and far out of the nominal ranges', async () => {
      const random = flameRandom(61);
      const rows: number[][] = [];
      for (let i = 0; i < 6000; i++) {
        const wild = i % 3 === 0; // a third of the rows use noise far outside its range
        rows.push(
          [
            -1.2 + 2.4 * random(),
            -0.6 + 2.2 * random(),
            wild ? -20 + 40 * random() : -1 + 2 * random(),
            wild ? -20 + 40 * random() : random(),
          ].map(Math.fround),
        );
      }
      const out = await flameEval(
        `${DEFAULTS}
         let d = flame_sd_teardrop(x.xy, fp.half_width, fp.height);
         return vec4f(flame_heat_teardrop(x.xy, x.zw, fp), flame_heat_taper(x.xy, x.zw, 0.03, fp),
                      flame_heat_from_sd(d, x.y / fp.height, x.w, fp), 0.0);`,
        rows,
      );
      for (const index of [0, 1, 2]) {
        const heat = lane(out, index);
        expect(heat.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(
          true,
        );
        expect(Math.max(...heat)).toBeGreaterThan(0.5); // and the sample does hit the flame
      }
    });

    it('is exactly zero outside the reach, whatever the noise, for both shapes', async () => {
      const random = flameRandom(62);
      const rows: number[][] = [];
      for (let i = 0; i < 8000; i++)
        rows.push(
          [-1.2 + 2.4 * random(), -0.6 + 2.2 * random(), -1 + 2 * random(), random()].map(
            Math.fround,
          ),
        );
      const out = await flameEval(
        `${DEFAULTS}
         return vec4f(flame_heat_teardrop(x.xy, x.zw, fp), flame_heat_taper(x.xy, x.zw, 0.03, fp),
                      f32(flame_reach(x.xy, fp)), flame_sd_teardrop(x.xy, fp.half_width, fp.height));`,
        rows,
      );
      let outside = 0;
      let lit = 0;
      for (let i = 0; i < rows.length; i++) {
        const [teardrop = NaN, taper = NaN, reach = NaN, distance = NaN] = out.subarray(
          i * 4,
          i * 4 + 4,
        );
        if (reach === 0) {
          outside++;
          expect(teardrop).toBe(0);
          expect(taper).toBe(0);
        }
        if (teardrop > 0 || taper > 0) lit++;
        // Well outside the bare shape (further than the tip can sway: 0.6 half-widths) is dark.
        if (distance > 0.6 * 0.19 + 1e-4) expect(teardrop).toBe(0);
      }
      // The early-out is worth having: most of this box is skipped, and it is not vacuous.
      expect(outside / rows.length).toBeGreaterThan(0.8);
      expect(lit).toBeGreaterThan(100);
    });

    it('zero noise leaves the silhouette unchanged: lit exactly where the bare distance is negative', async () => {
      const points = flamePoints(6000, 63).map(([x, y]) => [x * 0.4, y]);
      const out = await flameEval(
        `${DEFAULTS}
         let d = flame_sd_teardrop(x.xy, fp.half_width, fp.height);
         // Erosion on its own, at zero noise, with the amounts the heat function uses.
         let eroded = flame_erode(d, 0.0, fp.erosion * fp.half_width, x.y / fp.height, fp.erosion_curve);
         return vec4f(flame_heat_teardrop(x.xy, vec2f(0.0), fp), d, eroded,
                      flame_heat_teardrop(x.xy, vec2f(0.0, 0.7), fp));`,
        points,
      );
      let inside = 0;
      for (let i = 0; i < points.length; i++) {
        const [heat = NaN, distance = NaN, eroded = NaN, erodedHeat = NaN] = out.subarray(
          i * 4,
          i * 4 + 4,
        );
        expect(eroded).toBe(distance);
        if (Math.abs(distance) > 1e-4) expect(heat > 0).toBe(distance < 0);
        if (distance < -1e-4) inside++;
        // Positive erosion noise only ever removes heat.
        expect(erodedHeat).toBeLessThanOrEqual(heat);
      }
      expect(inside).toBeGreaterThan(300);
    });

    it('is hottest in the lower core and falls monotonically up the axis and out to the edge', async () => {
      // A 161 x 121 grid over the flame with zero noise.
      const grid: number[][] = [];
      for (let j = 0; j <= 120; j++)
        for (let i = 0; i <= 160; i++) grid.push([(i - 80) / 200, (j - 10) / 100]);
      const out = lane(
        await flameEval(
          `${DEFAULTS} return vec4f(flame_heat_teardrop(x.xy, vec2f(0.0), fp), 0.0, 0.0, 0.0);`,
          grid,
        ),
        0,
      );
      let peak = 0;
      let peakAt: number[] = [0, 0];
      out.forEach((heat, i) => {
        if (heat > peak) {
          peak = heat;
          peakAt = grid[i] ?? [0, 0];
        }
      });
      expect(peak).toBeCloseTo(1, 5);
      expect(Math.abs(peakAt[0] ?? NaN)).toBeLessThan(0.05); // on the axis...
      expect(peakAt[1]).toBeGreaterThan(0.1); // ...above the cool foot...
      expect(peakAt[1]).toBeLessThan(0.35); // ...in the lower third

      // Up the axis from the hot spot (t = hot = 0.2) to past the tip.
      const axis = Array.from({ length: 96 }, (_, i) => [0, (20 + i) / 100]);
      const up = lane(
        await flameEval(
          `${DEFAULTS} return vec4f(flame_heat_teardrop(x.xy, vec2f(0.0), fp), 0.0, 0.0, 0.0);`,
          axis,
        ),
        0,
      );
      expect(up[0]).toBeCloseTo(1, 5);
      for (let i = 1; i < up.length; i++)
        expect(up[i] ?? NaN).toBeLessThanOrEqual(up[i - 1] ?? NaN);
      expect(up[40]).toBeLessThan(0.75); // t = 0.6: orange, not white
      expect(up[40]).toBeGreaterThan(0.4);
      expect(up[80]).toBe(0); // t = 1, the tip
      expect(up[95]).toBe(0);

      // Outward from the hot spot to past the surface, on both sides.
      const across = Array.from({ length: 61 }, (_, i) => [i / 200, 0.2]);
      const sideways = await flameEval(
        `${DEFAULTS}
         return vec4f(flame_heat_teardrop(x.xy, vec2f(0.0), fp),
                      flame_heat_teardrop(vec2f(-x.x, x.y), vec2f(0.0), fp), 0.0, 0.0);`,
        across,
      );
      const right = lane(sideways, 0);
      expect(lane(sideways, 1)).toEqual(right);
      for (let i = 1; i < right.length; i++)
        expect(right[i] ?? NaN).toBeLessThanOrEqual(right[i - 1] ?? NaN);
      expect(right[38]).toBe(0); // x = 0.19, the surface
      expect(right[60]).toBe(0);

      // The foot is soft: at a tenth of the hot-spot height the axis is well below the peak.
      const [foot, base] = await scalars(FLAME, [
        'flame_heat_teardrop(vec2f(0.0, 0.02), vec2f(0.0), flame_params_default())',
        'flame_heat_teardrop(vec2f(0.0, 0.0), vec2f(0.0), flame_params_default())',
      ]);
      expect(foot).toBeLessThan(0.1);
      expect(base).toBe(0);
    });

    it('mirrors when the sway is mirrored', async () => {
      const random = flameRandom(64);
      const rows: number[][] = [];
      for (let i = 0; i < 3000; i++)
        rows.push(
          [-0.5 + random(), -0.1 + 1.2 * random(), -1 + 2 * random(), random()].map(Math.fround),
        );
      const out = await flameEval(
        `${DEFAULTS}
         let m = vec2f(-x.x, x.y);
         let n = vec2f(-x.z, x.w);
         return vec4f(flame_heat_teardrop(x.xy, x.zw, fp), flame_heat_teardrop(m, n, fp),
                      flame_heat_taper(x.xy, x.zw, 0.03, fp), flame_heat_taper(m, n, 0.03, fp));`,
        rows,
      );
      expect(lane(out, 0)).toEqual(lane(out, 1));
      expect(lane(out, 2)).toEqual(lane(out, 3));
    });

    it('sway moves the tip and not the foot; erosion removes more near the tip', async () => {
      // Heat-weighted mean x of a row of samples across the flame: where the flame is at height y.
      const centre = async (y: number, sway: number): Promise<number> => {
        const row = Array.from({ length: 161 }, (_, i) => [-0.4 + i * 0.005, y, sway]);
        const heat = lane(
          await flameEval(
            `${DEFAULTS} return vec4f(flame_heat_teardrop(x.xy, vec2f(x.z, 0.0), fp), 0.0, 0.0, 0.0);`,
            row,
          ),
          0,
        );
        let sum = 0;
        let weight = 0;
        heat.forEach((value, i) => {
          sum += value * (row[i]?.[0] ?? 0);
          weight += value;
        });
        return sum / weight;
      };
      // Positive sway noise shifts the SAMPLE right, so the flame appears shifted left.
      const low = await centre(0.05, 1);
      const middle = await centre(0.4, 1);
      const high = await centre(0.8, 1);
      expect(Math.abs(low)).toBeLessThan(0.002);
      expect(Math.abs(middle + 0.6 * 0.19 * 0.4 ** 1.6)).toBeLessThan(0.002);
      expect(Math.abs(high + 0.6 * 0.19 * 0.8 ** 1.6)).toBeLessThan(0.002);
      expect(Math.abs(high)).toBeGreaterThan(Math.abs(middle));

      // Lit width of the same rows with full erosion noise against none.
      const width = async (y: number, erosion: number): Promise<number> => {
        const row = Array.from({ length: 321 }, (_, i) => [-0.4 + i * 0.0025, y, erosion]);
        const heat = lane(
          await flameEval(
            `${DEFAULTS} return vec4f(flame_heat_teardrop(x.xy, vec2f(0.0, x.z), fp), 0.0, 0.0, 0.0);`,
            row,
          ),
          0,
        );
        return heat.filter((value) => value > 0).length * 0.0025;
      };
      const lostLow = (await width(0.1, 0)) - (await width(0.1, 1));
      const lostHigh = (await width(0.5, 0)) - (await width(0.5, 1));
      expect(lostLow).toBeGreaterThan(0);
      expect(lostHigh).toBeGreaterThan(2 * lostLow);
      // And full erosion noise empties the upper flame altogether: that is what detaches licks.
      expect(await width(0.8, 1)).toBe(0);
      expect(await width(0.8, 0)).toBeGreaterThan(0.05);
    });

    it('taper heat has an open base: full heat on the burner line, nothing below it', async () => {
      const jet = `var fp = flame_params(0.26, 1.0); fp.base_soft = 0.0; fp.hot = 0.0;`;
      const axis = Array.from({ length: 121 }, (_, i) => [0, (i - 10) / 100]);
      const out = lane(
        await flameEval(
          `${jet} return vec4f(flame_heat_taper(x.xy, vec2f(0.0), 0.03, fp), 0.0, 0.0, 0.0);`,
          axis,
        ),
        0,
      );
      // Index 10 is y = 0 (cut), index 11 the first sample above the burner.
      for (let i = 0; i <= 10; i++) expect(out[i]).toBe(0);
      expect(out[11]).toBeGreaterThan(0.97);
      for (let i = 12; i < out.length; i++)
        expect(out[i] ?? NaN).toBeLessThanOrEqual(out[i - 1] ?? NaN);
      expect(out[110]).toBe(0); // the tip
      // The closed trapezoid, by contrast, is cold on its base: the base is a surface of the SDF.
      const [closed] = await scalars(FLAME, [
        'flame_heat_from_sd(flame_sd_taper(vec2f(0.0, 0.01), 0.26, 0.03, 1.0), 0.01, 0.0, FlameParams(0.26, 1.0, 0.0, 1.0, 0.0, 1.0, 0.85, 0.0, 0.45, 0.0))',
      ]);
      expect(closed).toBeLessThan(0.2);
    });
  });
});

describe('advected noise', () => {
  // The comparison samples whole fields at several lags for seven variants.
  vi.setConfig({ testTimeout: 120_000 });

  const ADVECT = '#include "advect.wgsl"';
  const OCTAVES = 4;

  // The operating point of the advected-noise effect's defaults, so the numbers below are the
  // numbers of the picture: scale 4 cells per strip height, rise speed 0.4 heights per second.
  const SPEED = 1.6; // lattice units per second, upward
  const AMOUNT = { warp: 0.4, spin: 2.7, advection: 0.12, curl: 0.4, flow: 0.5, cycle: 2 };

  /** Small deterministic PRNG (mulberry32) so failures reproduce. */
  function advectRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function stats(values: number[]) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of values) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    const mean = sum / values.length;
    let squares = 0;
    for (const v of values) squares += (v - mean) ** 2;
    const variance = squares / values.length;
    return { min, max, mean, variance, std: Math.sqrt(variance) };
  }

  function corr(a: number[], b: number[]): number {
    const sa = stats(a);
    const sb = stats(b);
    let covariance = 0;
    for (let i = 0; i < a.length; i++)
      covariance += ((a[i] ?? 0) - sa.mean) * ((b[i] ?? 0) - sb.mean);
    return covariance / a.length / Math.sqrt(sa.variance * sb.variance);
  }

  const maxAbs = (values: number[]) => values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const rms = (values: number[]) =>
    Math.sqrt(values.reduce((s, v) => s + v * v, 0) / Math.max(values.length, 1));
  const fixed = (v: number, digits = 3) => v.toFixed(digits);

  /**
   * Rows of (p.x, p.y, drift.y, t): random positions in a 120-cell square, with the drift and the
   * clock either random or given.
   */
  function samples(count: number, seed: number, drift?: number, t?: number): Float32Array {
    const random = advectRandom(seed);
    const rows = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      rows[i * 4] = -60 + 120 * random();
      rows[i * 4 + 1] = -60 + 120 * random();
      rows[i * 4 + 2] = drift ?? 50 * random();
      rows[i * 4 + 3] = t ?? 40 * random();
    }
    return rows;
  }

  /** Lane 0 of a WGSL f32 expression over `p`, `drift` and `t`, one value per row. */
  async function evaluate(expression: string, rows: Float32Array): Promise<number[]> {
    const out = await gpuF32(
      `${ADVECT}
       fn f(x: vec4f) -> vec4f {
         let p = x.xy;
         let drift = vec2f(0.0, x.z);
         let t = x.w;
         return vec4f(${expression}, 0.0, 0.0, 0.0);
       }`,
      rows,
    );
    return lane(out, 0);
  }

  /** All four lanes of a WGSL vec4f expression over `p`, `drift` and `t`. */
  async function evaluate4(expression: string, rows: Float32Array): Promise<number[][]> {
    const out = await gpuF32(
      `${ADVECT}
       fn f(x: vec4f) -> vec4f {
         let p = x.xy;
         let drift = vec2f(0.0, x.z);
         let t = x.w;
         return ${expression};
       }`,
      rows,
    );
    return [lane(out, 0), lane(out, 1), lane(out, 2), lane(out, 3)];
  }

  /**
   * The variants as the advected-noise effect calls them at its defaults. `evals` and `corners` are
   * the noise evaluations and lattice-corner hashes of one call at four octaves, counted from the
   * source (a 2D evaluation reads 4 corners, a 3D one 8).
   */
  const VARIANTS = [
    {
      name: 'scroll',
      call: `advect_scroll(p, drift, 0.0, ${OCTAVES})`,
      evals: 4,
      corners: 32,
    },
    {
      name: 'scroll + evolution',
      call: `advect_scroll(p, drift, t, ${OCTAVES})`,
      evals: 4,
      corners: 32,
    },
    {
      name: 'warp',
      call: `advect_warp(p, drift, t, ${AMOUNT.warp}, ${OCTAVES})`,
      evals: 6,
      corners: 32,
    },
    {
      name: 'flow noise',
      call: `advect_flownoise(p, drift, t * ${AMOUNT.spin}, ${AMOUNT.advection}, ${OCTAVES})`,
      evals: 4,
      corners: 16,
    },
    {
      name: 'curl',
      call: `advect_curl(p, drift, t, ${AMOUNT.curl}, ${OCTAVES})`,
      evals: 5,
      corners: 24,
    },
    {
      name: 'curl of flow noise',
      call: `advect_flownoise(advect_curl_pos(p, drift, t, ${AMOUNT.curl}), vec2f(0.0), t * ${AMOUNT.spin / 2}, ${AMOUNT.advection}, ${OCTAVES})`,
      evals: 5,
      corners: 24,
    },
    {
      name: 'two-phase',
      call: `advect_twophase(p, drift, t, ${AMOUNT.flow}, ${AMOUNT.cycle.toFixed(1)}, ${OCTAVES})`,
      evals: 10,
      corners: 44,
    },
  ] as const;

  /** `rows` a moment later: the gas has risen for `lag` seconds; `follow` moves the samples with it. */
  function later(rows: Float32Array, lag: number, follow: boolean): Float32Array {
    const next = rows.slice();
    for (let i = 0; i < next.length; i += 4) {
      if (follow) next[i + 1] = (next[i + 1] ?? 0) + SPEED * lag;
      next[i + 2] = (next[i + 2] ?? 0) + SPEED * lag;
      next[i + 3] = (next[i + 3] ?? 0) + lag;
    }
    return next;
  }

  /**
   * Block matching between two fields sampled on the same square grid, `size` samples a side:
   * for each 12 x 12 block of the first field, the offset within +-4 samples at which the second
   * field matches it best (normalised cross-correlation).
   *   still    mean correlation of the blocks left where they are
   *   tracked  mean correlation at each block's best offset
   * `tracked - still` is what following the features recovers: almost nothing when features only
   * change where they are, more when they have moved relative to their neighbours.
   */
  function trackBlocks(a: number[], b: number[], size: number) {
    const block = 12;
    const reach = 4;
    const at = (field: number[], x: number, y: number) => field[y * size + x] ?? 0;
    const ncc = (x0: number, y0: number, dx: number, dy: number) => {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < block; y++)
        for (let x = 0; x < block; x++) {
          const va = at(a, x0 + x, y0 + y);
          const vb = at(b, x0 + x + dx, y0 + y + dy);
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      const n = block * block;
      const variance = (saa - (sa * sa) / n) * (sbb - (sb * sb) / n);
      return variance > 0 ? (sab - (sa * sb) / n) / Math.sqrt(variance) : 0;
    };
    let still = 0;
    let tracked = 0;
    let count = 0;
    for (let y0 = reach; y0 + block + reach <= size; y0 += block)
      for (let x0 = reach; x0 + block + reach <= size; x0 += block) {
        let best = -2;
        for (let dy = -reach; dy <= reach; dy++)
          for (let dx = -reach; dx <= reach; dx++) best = Math.max(best, ncc(x0, y0, dx, dy));
        still += ncc(x0, y0, 0, 0);
        tracked += best;
        count++;
      }
    return { still: still / count, tracked: tracked / count };
  }

  /** `rows` with the clock of every row set to `t`. */
  function atClock(rows: Float32Array, t: number): Float32Array {
    const next = rows.slice();
    for (let i = 3; i < next.length; i += 4) next[i] = t;
    return next;
  }

  // --- Ranges and statistics ----------------------------------------------------------------------

  it('every variant stays in [-1, 1], has zero mean and the same spread', async () => {
    const rows = samples(40_000, 11);
    const reference = stats(await evaluate(`fbm_2d(p - drift, ${OCTAVES}, 2.0, 0.5)`, rows));
    const report: string[] = [];
    for (const variant of VARIANTS) {
      const s = stats(await evaluate(variant.call, rows));
      report.push(
        `${variant.name.padEnd(19)} min ${fixed(s.min)}  max ${fixed(s.max)}  mean ${fixed(s.mean, 4)}  std ${fixed(s.std)}`,
      );
      expect(s.min, variant.name).toBeGreaterThanOrEqual(-1);
      expect(s.max, variant.name).toBeLessThanOrEqual(1);
      // Not a constant, and not a clamp doing the work.
      expect(s.max - s.min, variant.name).toBeGreaterThan(1);
      expect(Math.max(s.max, -s.min), variant.name).toBeLessThan(0.9);
      expect(Math.abs(s.mean), variant.name).toBeLessThan(0.01);
      // Swapping variants must not change how much flame there is.
      expect(s.std / reference.std, variant.name).toBeGreaterThan(0.9);
      expect(s.std / reference.std, variant.name).toBeLessThan(1.1);
    }
    console.log(
      `advected noise, 40 000 samples (fbm_2d std ${fixed(reference.std)})\n${report.join('\n')}`,
    );
  });

  it('the range holds at one octave and at large amounts too', async () => {
    const rows = samples(40_000, 12);
    const extremes = await evaluate4(
      `vec4f(
         advect_scroll(p, drift, t, 1),
         advect_flownoise(p, drift, t, 0.5, 6),
         advect_twophase(p, drift, t, 1.5, 0.7, 1),
         advect_curl(p, drift, t, 1.5, 1))`,
      rows,
    );
    for (const values of extremes) {
      expect(values.every(Number.isFinite)).toBe(true);
      expect(maxAbs(values)).toBeLessThanOrEqual(1);
      expect(maxAbs(values)).toBeGreaterThan(0.5);
    }
  });

  // --- Scroll -------------------------------------------------------------------------------------

  it('scroll with the clock held is exactly a translation', async () => {
    // f(p, t) == f(p - v dt, t - dt) with drift = v t. Everything is a multiple of 1/64, so both
    // sides reach the noise with the same bits and must return the same bits.
    const random = advectRandom(21);
    const dyadic = (lo: number, hi: number) => Math.round((lo + (hi - lo) * random()) * 64) / 64;
    const count = 4096;
    const now = new Float32Array(count * 4);
    const before = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const [x, y, v, t, dt] = [
        dyadic(-32, 32),
        dyadic(-32, 32),
        dyadic(0, 4),
        dyadic(0, 8),
        dyadic(0, 4),
      ];
      now.set([x, y, v * t, 0], i * 4);
      before.set([x, y - v * dt, v * (t - dt), 0], i * 4);
    }
    const call = `advect_scroll(p, drift, 0.0, ${OCTAVES})`;
    const a = await evaluate(call, now);
    const b = await evaluate(call, before);
    expect(a.filter((v, i) => v !== b[i]).length).toBe(0);
    expect(stats(a).std).toBeGreaterThan(0.1);

    // With arbitrary numbers the two sides differ only by float rounding of p - drift.
    const rows = samples(8192, 22, undefined, 0);
    const moved = later(rows, 0.37, true);
    for (let i = 3; i < moved.length; i += 4) moved[i] = 0;
    const c = await evaluate(call, rows);
    const d = await evaluate(call, moved);
    expect(maxAbs(c.map((v, i) => v - (d[i] ?? 0)))).toBeLessThan(2e-4);
  });

  it('the scroll keeps its spread to within a few percent as the clock runs', async () => {
    // Slices of 3D gradient noise are flattest on lattice planes; t = 0 sits a quarter cell off one.
    const rows = samples(40_000, 24, 3.5, 0);
    const reference = stats(await evaluate(`fbm_2d(p - drift, ${OCTAVES}, 2.0, 0.5)`, rows)).std;
    const clocks = [0, 0.25, 0.5, 0.75, 1, 1.3, 2.6];
    const spreads: number[] = [];
    for (const t of clocks)
      spreads.push(
        stats(await evaluate(`advect_scroll(p, drift, t, ${OCTAVES})`, atClock(rows, t))).std,
      );
    console.log(
      `scroll std at t = ${clocks.join(', ')}: ${spreads.map((v) => fixed(v)).join(', ')} (fbm_2d ${fixed(reference)})`,
    );
    // The rigid scroll (t = 0) has the spread of the 2D variants...
    expect(Math.abs((spreads[0] ?? 0) / reference - 1)).toBeLessThan(0.03);
    // ...and the clock moves it by less than a tenth.
    const s = stats(spreads);
    expect((s.max - s.min) / s.mean).toBeLessThan(0.1);
  });

  it('the scroll clock changes the pattern in place', async () => {
    const rows = samples(20_000, 23, 3.5, 0);
    const call = `advect_scroll(p, drift, t, ${OCTAVES})`;
    const start = await evaluate(call, rows);
    const at = async (t: number) => {
      const next = rows.slice();
      for (let i = 3; i < next.length; i += 4) next[i] = t;
      return corr(start, await evaluate(call, next));
    };
    const [soon, mid, late] = [await at(0.05), await at(0.25), await at(1.5)];
    expect(soon).toBeGreaterThan(0.95);
    expect(mid).toBeLessThan(soon);
    expect(mid).toBeGreaterThan(0.4);
    expect(Math.abs(late)).toBeLessThan(0.1);
  });

  // --- Warp and curl ------------------------------------------------------------------------------

  it('warp and curl with no strength are a rigid scroll of fbm_2d', async () => {
    const rows = samples(8192, 31);
    const [warp, curl, plain] = await evaluate4(
      `vec4f(
         advect_warp(p, drift, t, 0.0, ${OCTAVES}),
         advect_curl(p, drift, t, 0.0, ${OCTAVES}),
         fbm_2d(p - drift, ${OCTAVES}, 2.0, 0.5),
         0.0)`,
      rows,
    );
    expect(maxAbs((warp ?? []).map((v, i) => v - (plain?.[i] ?? 0)))).toBeLessThan(1e-6);
    expect(maxAbs((curl ?? []).map((v, i) => v - (plain?.[i] ?? 0)))).toBeLessThan(1e-6);
  });

  it('strength is the RMS displacement, in lattice units, for both', async () => {
    const rows = samples(60_000, 32);
    for (const strength of [1, 0.4]) {
      const [wx, wy, cx, cy] = await evaluate4(
        `vec4f(
           advect_warp_pos(p, drift, t, ${strength.toFixed(2)}) - (p - drift),
           advect_curl_pos(p, drift, t, ${strength.toFixed(2)}) - (p - drift))`,
        rows,
      );
      const warp = Math.hypot(rms(wx ?? []), rms(wy ?? []));
      const curl = Math.hypot(rms(cx ?? []), rms(cy ?? []));
      expect(warp / strength).toBeGreaterThan(0.97);
      expect(warp / strength).toBeLessThan(1.03);
      expect(curl / strength).toBeGreaterThan(0.97);
      expect(curl / strength).toBeLessThan(1.03);
    }
  });

  it('the curl displacement has no divergence, so it does not swell or shrink features', async () => {
    // Jacobian of the displacement by central differences, at the default strength of both.
    const jacobian = (fn: string, strength: number) =>
      `vec4f(
         (${fn}(p + vec2f(H, 0.0), drift, t, ${strength}) - ${fn}(p - vec2f(H, 0.0), drift, t, ${strength})) / (2.0 * H)
           - vec2f(1.0, 0.0),
         (${fn}(p + vec2f(0.0, H), drift, t, ${strength}) - ${fn}(p - vec2f(0.0, H), drift, t, ${strength})) / (2.0 * H)
           - vec2f(0.0, 1.0))`;
    const measure = async (fn: string, strength: number) => {
      // Small coordinates: the differences are taken in f32.
      const rows = samples(20_000, 33, 2.5);
      for (let i = 0; i < rows.length; i += 4) {
        rows[i] = (rows[i] ?? 0) / 8;
        rows[i + 1] = (rows[i + 1] ?? 0) / 8;
      }
      const out = await gpuF32(
        `${ADVECT}
         const H: f32 = 0.015625;
         fn f(x: vec4f) -> vec4f {
           let p = x.xy;
           let drift = vec2f(0.0, x.z);
           let t = x.w;
           return ${jacobian(fn, strength)};
         }`,
        rows,
      );
      const [xx, yx, xy, yy] = [lane(out, 0), lane(out, 1), lane(out, 2), lane(out, 3)];
      const divergence = xx.map((v, i) => v + (yy[i] ?? 0));
      // Area of a small patch after the map, relative to before: det(I + J).
      const area = xx.map((v, i) => (1 + v) * (1 + (yy[i] ?? 0)) - (xy[i] ?? 0) * (yx[i] ?? 0) - 1);
      const strain = Math.hypot(rms(xx), rms(yx), rms(xy), rms(yy));
      return { divergence: rms(divergence), area: rms(area), strain };
    };
    const warp = await measure('advect_warp_pos', AMOUNT.warp);
    const curl = await measure('advect_curl_pos', AMOUNT.curl);
    const warpHalf = await measure('advect_warp_pos', AMOUNT.warp / 2);
    const curlHalf = await measure('advect_curl_pos', AMOUNT.curl / 2);
    const line = (name: string, m: typeof warp) =>
      `${name} divergence ${fixed(m.divergence, 4)}, area change ${fixed(m.area)}, strain ${fixed(m.strain)}`;
    console.log(
      `displacement maps, RMS over 20 000 points\n` +
        `  strength ${AMOUNT.warp}: ${line('warp', warp)}; ${line('curl', curl)}\n` +
        `  strength ${AMOUNT.warp / 2}: ${line('warp', warpHalf)}; ${line('curl', curlHalf)}`,
    );
    expect(curl.divergence).toBeLessThan(0.01);
    expect(warp.divergence).toBeGreaterThan(0.2);
    // Area change is first order in the strength for the warp (it is the divergence) and second
    // order for curl, so curl wins by more the gentler the displacement.
    expect(curl.area).toBeLessThan(0.8 * warp.area);
    expect(curlHalf.area).toBeLessThan(0.4 * warpHalf.area);
    expect(curlHalf.area / curl.area).toBeLessThan(0.3);
    expect(warpHalf.area / warp.area).toBeGreaterThan(0.4);
  });

  // --- Rotating-gradient noise and flow noise -------------------------------------------------------

  it('rotating-gradient noise is gradient noise at every angle', async () => {
    const rows = samples(60_000, 41);
    const [still, turned, far, plain] = await evaluate4(
      `vec4f(
         advect_rotnoise_2d(p, 0.0),
         advect_rotnoise_2d(p, 2.0),
         advect_rotnoise_2d(p, t * 20.0),
         gnoise_2d(p))`,
      rows,
    );
    const reference = stats(plain ?? []);
    for (const values of [still, turned, far]) {
      const s = stats(values ?? []);
      expect(maxAbs(values ?? [])).toBeLessThanOrEqual(1);
      expect(maxAbs(values ?? [])).toBeGreaterThan(0.85);
      expect(Math.abs(s.mean)).toBeLessThan(0.01);
      expect(s.variance / reference.variance).toBeGreaterThan(0.96);
      expect(s.variance / reference.variance).toBeLessThan(1.04);
    }
    // It is its own lattice of gradients, not gnoise_2d's.
    expect(Math.abs(corr(still ?? [], plain ?? []))).toBeLessThan(0.05);
  });

  it('rotating-gradient noise is zero on lattice points at every angle', async () => {
    const random = advectRandom(42);
    const rows = new Float32Array(4096 * 4);
    for (let i = 0; i < rows.length; i += 4)
      rows.set(
        [Math.round(-40 + 80 * random()), Math.round(-40 + 80 * random()), 0, 60 * random()],
        i,
      );
    expect(maxAbs(await evaluate('advect_rotnoise_2d(p, t)', rows))).toBeLessThan(1e-6);
  });

  it('rotating-gradient noise is continuous in the angle and never comes back', async () => {
    const rows = samples(30_000, 43);
    const [now, next, soon, turn] = await evaluate4(
      `vec4f(
         advect_rotnoise_2d(p, t),
         advect_rotnoise_2d(p, t + 0.001),
         advect_rotnoise_2d(p, t + 0.1),
         advect_rotnoise_2d(p, t + TAU))`,
      rows,
    );
    // Each gradient turns by at most 2.45 times the angle and reaches a corner at most sqrt(2) away.
    expect(maxAbs((now ?? []).map((v, i) => v - (next?.[i] ?? 0)))).toBeLessThan(0.005);
    expect(corr(now ?? [], soon ?? [])).toBeGreaterThan(0.99);
    // With one shared rate a full turn would reproduce the field exactly (correlation 1).
    expect(Math.abs(corr(now ?? [], turn ?? []))).toBeLessThan(0.1);
  });

  it('the correlation of rotating-gradient noise with itself falls as sinc squared', async () => {
    // Rates are triangular over +-sqrt(6), whose characteristic function is sinc^2: it reaches
    // zero at 2.57 radians and never goes negative, so a feature fades without inverting.
    const rows = samples(40_000, 47);
    const turns = [0.5, 1, 1.5, 2, 2.565, 3.2, 4.5];
    const start = await evaluate('advect_rotnoise_2d(p, t)', rows);
    const report: string[] = [];
    for (const turn of turns) {
      const measured = corr(start, await evaluate(`advect_rotnoise_2d(p, t + ${turn})`, rows));
      const x = (Math.sqrt(6) / 2) * turn;
      const expected = (Math.sin(x) / x) ** 2;
      report.push(`${turn}: ${fixed(measured)} (${fixed(expected)})`);
      expect(Math.abs(measured - expected)).toBeLessThan(0.03);
      expect(measured).toBeGreaterThan(-0.03);
    }
    console.log(
      `rotating-gradient noise, correlation after turning (sinc^2): ${report.join('  ')}`,
    );
  });

  it('the analytic derivative of rotating-gradient noise matches finite differences', async () => {
    const rows = samples(20_000, 44);
    for (let i = 0; i < rows.length; i += 4) {
      rows[i] = (rows[i] ?? 0) / 8;
      rows[i + 1] = (rows[i + 1] ?? 0) / 8;
    }
    const out = await gpuF32(
      `${ADVECT}
       const H: f32 = 0.00390625;
       fn f(x: vec4f) -> vec4f {
         let d = advect_rotnoise_2d_d(x.xy, x.w);
         let dx = advect_rotnoise_2d(x.xy + vec2f(H, 0.0), x.w) - advect_rotnoise_2d(x.xy - vec2f(H, 0.0), x.w);
         let dy = advect_rotnoise_2d(x.xy + vec2f(0.0, H), x.w) - advect_rotnoise_2d(x.xy - vec2f(0.0, H), x.w);
         return vec4f(d.yz - vec2f(dx, dy) / (2.0 * H), d.x - advect_rotnoise_2d(x.xy, x.w), length(d.yz));
       }`,
      rows,
    );
    expect(maxAbs(lane(out, 0))).toBeLessThan(0.01);
    expect(maxAbs(lane(out, 1))).toBeLessThan(0.01);
    expect(maxAbs(lane(out, 2))).toBe(0);
    // The gradients being compared are not small.
    expect(rms(lane(out, 3))).toBeGreaterThan(1);
  });

  it('flow noise is a fractal sum of rotating-gradient noise, moved by the drift', async () => {
    const rows = samples(8192, 45);
    const [one, base, moved, here] = await evaluate4(
      `vec4f(
         advect_flownoise(p, drift, t, 0.0, 1),
         advect_rotnoise_2d(p - drift, t),
         advect_flownoise(p + vec2f(0.5, 0.25), drift + vec2f(0.5, 0.25), t, 0.2, ${OCTAVES}),
         advect_flownoise(p, drift, t, 0.2, ${OCTAVES}))`,
      rows,
    );
    expect(maxAbs((one ?? []).map((v, i) => v - (base?.[i] ?? 0)))).toBeLessThan(1e-6);
    expect(maxAbs((moved ?? []).map((v, i) => v - (here?.[i] ?? 0)))).toBeLessThan(2e-3);
  });

  it('pseudo-advection changes where the fine octaves are, not how strong they are', async () => {
    const rows = samples(40_000, 46);
    const [off, on] = await evaluate4(
      `vec4f(
         advect_flownoise(p, drift, t, 0.0, ${OCTAVES}),
         advect_flownoise(p, drift, t, ${AMOUNT.advection}, ${OCTAVES}),
         0.0, 0.0)`,
      rows,
    );
    const ratio = stats(on ?? []).std / stats(off ?? []).std;
    expect(ratio).toBeGreaterThan(0.97);
    expect(ratio).toBeLessThan(1.03);
    // Octave 0 is never displaced, so the two stay strongly related.
    const related = corr(off ?? [], on ?? []);
    expect(related).toBeGreaterThan(0.8);
    expect(related).toBeLessThan(0.99);
  });

  // --- Two-phase blend ----------------------------------------------------------------------------

  /** fbm at the two phase positions, blended; `how` is 'renormalised' or a plain mix. */
  const phaseBlend = (how: 'renormalised' | 'plain', jitter: number, cycle: number) =>
    `${ADVECT}
     fn f(x: vec4f) -> vec4f {
       let ph = advect_phases(x.xy, vec2f(0.0, x.z), x.w, vec2f(0.3, -0.2), ${cycle.toFixed(3)}, ${jitter.toFixed(3)});
       let a = fbm_2d(ph.pos_a, ${OCTAVES}, 2.0, 0.5);
       let b = fbm_2d(ph.pos_b, ${OCTAVES}, 2.0, 0.5);
       let blended = ${how === 'plain' ? 'mix(a, b, ph.mix_b)' : 'advect_phase_mix(a, b, ph)'};
       return vec4f(blended, a, b, ph.mix_b);
     }`;

  it('the two phases are half a cycle apart with triangle weights', async () => {
    const cycle = 2;
    const rows = samples(64, 51, 1.5);
    const weightAt = async (t: number) =>
      stats(lane(await gpuF32(phaseBlend('plain', 0, cycle), atClock(rows, t)), 3));
    // Without jitter every pixel has the same weight; b is all there is when a resets (t = k cycle).
    for (const [t, expected] of [
      [6, 1],
      [6.5, 0.5],
      [7, 0],
      [7.5, 0.5],
      [7.75, 0.75],
    ] as const) {
      const w = await weightAt(t);
      expect(w.max - w.min).toBeLessThan(1e-6);
      expect(w.mean).toBeCloseTo(expected, 5);
    }
  });

  it('a phase reset does not pop: the layer that jumps has no weight at that moment', async () => {
    const cycle = 2;
    const eps = 1 / 1024;
    const rows = samples(20_000, 52, 1.5);
    const positions = (layer: 'a' | 'b') =>
      `${ADVECT}
       fn f(x: vec4f) -> vec4f {
         let ph = advect_phases(x.xy, vec2f(0.0, x.z), x.w, vec2f(0.3, -0.2), ${cycle.toFixed(1)}, 0.0);
         return vec4f(ph.pos_${layer}, ph.mix_b, 0.0);
       }`;
    // Layer a resets at t = 6 (a whole number of cycles), layer b half a cycle later.
    for (const [layer, reset] of [
      ['a', 6],
      ['b', 7],
    ] as const) {
      const before = atClock(rows, reset - eps);
      const after = atClock(rows, reset + eps);
      const p0 = await gpuF32(positions(layer), before);
      const p1 = await gpuF32(positions(layer), after);
      const jump = lane(p0, 0).map((x, i) =>
        Math.hypot(x - (lane(p1, 0)[i] ?? 0), (p0[i * 4 + 1] ?? 0) - (p1[i * 4 + 1] ?? 0)),
      );
      // The lookup really does jump to somewhere else...
      expect(stats(jump).mean).toBeGreaterThan(5);
      // ...and the other layer does not move.
      const other = layer === 'a' ? 'b' : 'a';
      const q0 = await gpuF32(positions(other), before);
      const q1 = await gpuF32(positions(other), after);
      expect(maxAbs(lane(q0, 0).map((x, i) => x - (lane(q1, 0)[i] ?? 0)))).toBeLessThan(0.01);
      // ...while the blend changes by no more than it does in any other two milliseconds.
      const v0 = lane(await gpuF32(phaseBlend('renormalised', 0, cycle), before), 0);
      const v1 = lane(await gpuF32(phaseBlend('renormalised', 0, cycle), after), 0);
      expect(maxAbs(v0.map((v, i) => v - (v1[i] ?? 0)))).toBeLessThan(0.01);
      expect(stats(v0).std).toBeGreaterThan(0.1);
    }
  });

  it('the two-phase variants are continuous in time everywhere, jitter included', async () => {
    // With the per-pixel phase offset the resets happen at a different moment in every pixel, so
    // random samples straddle many of them. A pop would be a step of the order of the noise (0.2).
    const eps = 1 / 1024;
    const rows = samples(60_000, 53);
    const stepped = rows.slice();
    for (let i = 3; i < stepped.length; i += 4) stepped[i] = (stepped[i] ?? 0) + eps;
    for (const call of [
      `advect_twophase(p, drift, t, ${AMOUNT.flow}, ${AMOUNT.cycle.toFixed(1)}, ${OCTAVES})`,
      `advect_flowmap(p, drift, t, vec2f(0.6, -0.4), 0.8, ${OCTAVES})`,
    ]) {
      const a = await evaluate(call, rows);
      const b = await evaluate(call, stepped);
      expect(maxAbs(a.map((v, i) => v - (b[i] ?? 0)))).toBeLessThan(0.015);
    }
  });

  it('the renormalised blend keeps its variance through the cycle; a plain mix loses half', async () => {
    const cycle = 2;
    const rows = samples(40_000, 54, 1.5);
    const fractions = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
    const plain: number[] = [];
    const kept: number[] = [];
    let layers = 0;
    for (const fraction of fractions) {
      const at = atClock(rows, (3 + fraction) * cycle);
      const naive = await gpuF32(phaseBlend('plain', 0, cycle), at);
      plain.push(stats(lane(naive, 0)).variance);
      kept.push(stats(lane(await gpuF32(phaseBlend('renormalised', 0, cycle), at), 0)).variance);
      // The renormalisation assumes the two layers are unrelated.
      layers = Math.max(layers, Math.abs(corr(lane(naive, 1), lane(naive, 2))));
    }
    const single = stats(await evaluate(`fbm_2d(p, ${OCTAVES}, 2.0, 0.5)`, rows)).variance;
    const relative = (v: number[]) => v.map((x) => x / single);
    console.log(
      `two-phase variance through one cycle, relative to one layer (phase ${fractions.join(', ')})\n` +
        `  plain mix     ${relative(plain)
          .map((v) => fixed(v, 2))
          .join('  ')}\n` +
        `  renormalised  ${relative(kept)
          .map((v) => fixed(v, 2))
          .join('  ')}`,
    );
    expect(layers).toBeLessThan(0.03);
    expect(Math.min(...relative(plain))).toBeLessThan(0.55);
    expect(Math.min(...relative(kept))).toBeGreaterThan(0.94);
    expect(Math.max(...relative(kept))).toBeLessThan(1.06);
  });

  it('the two-phase picture does not pulse: frame statistics are steady over two cycles', async () => {
    const rows = samples(40_000, 55, 1.5);
    const call = `advect_twophase(p, drift, t, ${AMOUNT.flow}, ${AMOUNT.cycle.toFixed(1)}, ${OCTAVES})`;
    const means: number[] = [];
    const spreads: number[] = [];
    for (let step = 0; step <= 16; step++) {
      const s = stats(await evaluate(call, atClock(rows, 5 + (step * AMOUNT.cycle) / 8)));
      means.push(s.mean);
      spreads.push(s.std);
    }
    const spread = stats(spreads);
    console.log(
      `two-phase frame std over two cycles: ${fixed(spread.min)} to ${fixed(spread.max)}; mean within ${fixed(maxAbs(means), 4)}`,
    );
    expect(maxAbs(means)).toBeLessThan(0.01);
    expect((spread.max - spread.min) / spread.mean).toBeLessThan(0.04);
  });

  it('a constant flow moves the two-phase pattern at the flow velocity', async () => {
    // Follow the pattern at different candidate velocities for a short time (well inside one
    // cycle): it matches best when followed at the flow velocity. Without jitter the match is
    // limited only by the cross-fade having moved on by 1/16.
    const cycle = 4;
    const lag = 0.125;
    const rows = samples(30_000, 56, 0);
    const follow = async (direction: number) => {
      const next = atClock(rows, 8.3 + lag);
      for (let i = 0; i < next.length; i += 4) {
        next[i] = (next[i] ?? 0) + direction * 0.3 * lag;
        next[i + 1] = (next[i + 1] ?? 0) - direction * 0.2 * lag;
      }
      return lane(await gpuF32(phaseBlend('renormalised', 0, cycle), next), 0);
    };
    const start = lane(await gpuF32(phaseBlend('renormalised', 0, cycle), atClock(rows, 8.3)), 0);
    const followed = corr(start, await follow(1));
    const still = corr(start, await follow(0));
    const wrongWay = corr(start, await follow(-1));
    expect(followed).toBeGreaterThan(0.99);
    expect(followed).toBeGreaterThan(still + 0.005);
    expect(still).toBeGreaterThan(wrongWay + 0.005);
  });

  it('the per-pixel phase offset changes the apparent speed only a little at the defaults', async () => {
    // The pattern coordinate is p - flow * cycle * (t / cycle + jitter(p)), so a pixel sees the
    // flow speed divided by 1 - cycle * dot(flow, grad jitter). Measure that factor's spread.
    const rows = samples(30_000, 57, 0);
    const out = await gpuF32(
      `${ADVECT}
       const H: f32 = 0.015625;
       fn jitter(p: vec2f) -> f32 {
         // advect_phases with no flow and one cycle per unit: the layer offset is all that depends
         // on the phase, so read the jitter back from the weight instead.
         return advect_phases(p, vec2f(0.0), 0.25, vec2f(0.0), 1.0, ADVECT_PHASE_JITTER).mix_b;
       }
       fn f(x: vec4f) -> vec4f {
         let p = x.xy / 8.0;
         let gx = (jitter(p + vec2f(H, 0.0)) - jitter(p - vec2f(H, 0.0))) / (2.0 * H);
         let gy = (jitter(p + vec2f(0.0, H)) - jitter(p - vec2f(0.0, H))) / (2.0 * H);
         // mix_b = |2 fract(0.25 + j) - 1| has slope 2 in j away from its corners.
         return vec4f(0.5 * length(vec2f(gx, gy)), jitter(p), 0.0, 0.0);
       }`,
      rows,
    );
    const gradient = rms(lane(out, 0));
    console.log(
      `two-phase: RMS gradient of the phase offset ${fixed(gradient)} cycles per cell; apparent speed varies by about ` +
        `+-${fixed(100 * gradient * AMOUNT.flow * AMOUNT.cycle, 0)}% at flow ${AMOUNT.flow}, cycle ${AMOUNT.cycle}`,
    );
    expect(gradient * AMOUNT.flow * AMOUNT.cycle).toBeLessThan(0.2);
    // The offsets still spread the resets over half a cycle or more.
    const weights = stats(lane(out, 1));
    expect(weights.max - weights.min).toBeGreaterThan(0.8);
  });

  // --- The comparison -----------------------------------------------------------------------------

  it('measured: how well each variant hides the scrolling texture', async () => {
    // Co-moving correlation: the correlation, over many points, between the noise now and the noise
    // `lag` seconds later at the point the gas has carried it to. Exactly 1 for a rigid sliding
    // texture; lower means features were born, deformed or died on the way. "Fixed" is the same
    // without following the gas, so co-moving > fixed says the pattern still travels upward.
    const lags = [0.1, 0.25, 0.5, 1];
    const points = samples(30_000, 61, 7.3, 3.1);
    // A 24.5-cell square sampled 8 times per cell, for the block matching.
    const size = 196;
    const step = 0.125;
    const grid = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        grid.set([x * step - 9.1, y * step + 4.3, 7.3, 3.1], (y * size + x) * 4);

    type Row = { comoving: number[]; fixedPoint: number[]; recovered: number };
    const table = new Map<string, Row>();
    const lines: string[] = [];
    for (const variant of VARIANTS) {
      const reference = await evaluate(variant.call, points);
      const comoving: number[] = [];
      const fixedPoint: number[] = [];
      for (const lag of lags) {
        comoving.push(corr(reference, await evaluate(variant.call, later(points, lag, true))));
        fixedPoint.push(corr(reference, await evaluate(variant.call, later(points, lag, false))));
      }
      const blocks = trackBlocks(
        await evaluate(variant.call, grid),
        await evaluate(variant.call, later(grid, 0.25, true)),
        size,
      );
      const recovered = blocks.tracked - blocks.still;
      table.set(variant.name, { comoving, fixedPoint, recovered });
      lines.push(
        [
          variant.name.padEnd(19),
          String(variant.evals).padStart(5),
          String(variant.corners).padStart(7),
          ' ',
          ...comoving.map((v) => fixed(v, 2).padStart(5)),
          fixed(fixedPoint[0] ?? 0, 2).padStart(8),
          fixed(recovered, 2).padStart(9),
        ].join(' '),
      );
    }
    console.log(
      `advected noise at the effect defaults (rise ${SPEED} cells/s, clock 1/s, ${OCTAVES} octaves)\n` +
        `variant             evals corners   co-moving correlation    fixed  tracking\n` +
        `                                  ${lags.map((l) => `${l}s`.padStart(5)).join(' ')}     0.1s  recovers\n` +
        lines.join('\n'),
    );
    const row = (name: string) => {
      const r = table.get(name);
      if (!r) throw new Error(`no variant ${name}`);
      return r;
    };
    const others = VARIANTS.slice(1);

    // A pure scroll is a rigid texture at every lag.
    for (const c of row('scroll').comoving) expect(c).toBeGreaterThan(0.9999);
    expect(row('scroll').recovered).toBeLessThan(1e-4);

    for (const variant of others) {
      const r = row(variant.name);
      // Everything else breaks the rigid texture, more with time...
      expect(r.comoving[1], variant.name).toBeLessThan(0.85);
      expect(r.comoving[2], variant.name).toBeLessThan(0.55);
      expect(r.comoving[0], variant.name).toBeGreaterThan(r.comoving[1] ?? 1);
      expect(r.comoving[1], variant.name).toBeGreaterThan(r.comoving[2] ?? 1);
      // ...without turning into flicker: a tenth of a second later most of it is still there...
      expect(r.comoving[0], variant.name).toBeGreaterThan(0.85);
      // ...and the pattern still travels upward: it matches better followed than left in place.
      expect(r.comoving[0], variant.name).toBeGreaterThan((r.fixedPoint[0] ?? 1) + 0.1);
      expect(r.comoving[1], variant.name).toBeGreaterThan((r.fixedPoint[1] ?? 1) + 0.25);
    }

    // The defaults are tuned so the single-sample variants lose about the same share of the
    // texture in a quarter of a second (the time a feature takes to cross a tenth of the frame);
    // the two-phase blend, which changes mostly by cross-fading, keeps a little more.
    const quarter = (name: string) => row(name).comoving[1] ?? 1;
    for (const name of ['scroll + evolution', 'warp', 'flow noise', 'curl', 'curl of flow noise']) {
      expect(quarter(name), name).toBeGreaterThan(0.6);
      expect(quarter(name), name).toBeLessThan(0.74);
    }
    expect(quarter('two-phase')).toBeGreaterThan(quarter('curl'));

    // How they do it differs. Evolution and rotating gradients change features where they are;
    // warp and curl move them relative to their neighbours, which block matching can follow. (The
    // 0.04-0.06 of the in-place variants is the bias of picking the best of 81 offsets.)
    expect(row('scroll + evolution').recovered).toBeLessThan(0.08);
    expect(row('flow noise').recovered).toBeLessThan(0.08);
    expect(row('two-phase').recovered).toBeLessThan(0.08);
    expect(row('warp').recovered).toBeGreaterThan(0.14);
    expect(row('curl').recovered).toBeGreaterThan(0.09);
    expect(row('curl of flow noise').recovered).toBeGreaterThan(0.09);

    // A bounded displacement cannot remove a feature larger than itself: after a second warp and
    // curl still show the coarse octaves of the texture they started from. Variants whose pattern
    // changes in place do not, including flow noise looked up through the curl displacement.
    expect(row('warp').comoving[3]).toBeGreaterThan(0.2);
    expect(row('curl').comoving[3]).toBeGreaterThan(0.2);
    for (const name of ['scroll + evolution', 'flow noise', 'curl of flow noise'])
      expect(Math.abs(row(name).comoving[3] ?? 1), name).toBeLessThan(0.1);

    // Decorrelation bought per lattice-corner hash at 0.25 s: flow noise (2D only) is the
    // cheapest, then the two curl variants, then warp and plain evolution; the blend costs most.
    const perCost = (name: string) =>
      (1 - quarter(name)) / (VARIANTS.find((v) => v.name === name)?.corners ?? 1);
    expect(perCost('flow noise')).toBeGreaterThan(perCost('curl of flow noise'));
    expect(perCost('curl of flow noise')).toBeGreaterThan(perCost('curl'));
    expect(perCost('curl')).toBeGreaterThan(perCost('warp'));
    expect(perCost('curl')).toBeGreaterThan(perCost('scroll + evolution'));
    expect(perCost('warp')).toBeGreaterThan(perCost('two-phase'));
    expect(perCost('scroll + evolution')).toBeGreaterThan(perCost('two-phase'));
  });

  it('measured: the correlation is a dial, so the defaults are a choice', async () => {
    // Every mechanism can be turned up until the texture is gone; these are the co-moving
    // correlations at 0.25 s as each variant's own amount changes.
    const points = samples(30_000, 62, 7.3, 3.1);
    const sweep = async (label: string, calls: [string, string][]) => {
      const values: number[] = [];
      for (const [, call] of calls) {
        const reference = await evaluate(call, points);
        values.push(corr(reference, await evaluate(call, later(points, 0.25, true))));
      }
      console.log(
        `${label.padEnd(28)} ${calls.map(([name], i) => `${name}: ${fixed(values[i] ?? 0, 2)}`).join('   ')}`,
      );
      return values;
    };
    const amounts = (values: number[], call: (v: string) => string): [string, string][] =>
      values.map((v) => [String(v), call(v.toFixed(2))]);
    const evolution = await sweep(
      'scroll, clock rate',
      amounts([0.5, 1, 2], (v) => `advect_scroll(p, drift, t * ${v}, ${OCTAVES})`),
    );
    const warp = await sweep(
      'warp, strength',
      amounts([0.2, 0.4, 0.8], (v) => `advect_warp(p, drift, t, ${v}, ${OCTAVES})`),
    );
    const spin = await sweep(
      'flow noise, rotation rate',
      amounts(
        [1.35, 2.7, 5.4],
        (v) => `advect_flownoise(p, drift, t * ${v}, ${AMOUNT.advection}, ${OCTAVES})`,
      ),
    );
    const curl = await sweep(
      'curl, strength',
      amounts([0.2, 0.4, 0.8], (v) => `advect_curl(p, drift, t, ${v}, ${OCTAVES})`),
    );
    const flow = await sweep(
      'two-phase, flow speed',
      amounts(
        [0.5, 1, 1.5],
        (v) => `advect_twophase(p, drift, t, ${v}, ${AMOUNT.cycle.toFixed(1)}, ${OCTAVES})`,
      ),
    );
    await sweep(
      'two-phase, cycle',
      amounts([1, 2, 4], (v) => `advect_twophase(p, drift, t, ${AMOUNT.flow}, ${v}, ${OCTAVES})`),
    );
    for (const values of [evolution, warp, spin, curl, flow]) {
      expect(values[0]).toBeGreaterThan(values[1] ?? 1);
      expect(values[1]).toBeGreaterThan(values[2] ?? 1);
    }
  });
  // --- The effect ---------------------------------------------------------------------------------

  it('the advected-noise effect keeps whole-frame brightness slow and small', async () => {
    // Mean encoded brightness of the frame, sampled 30 times a second for four seconds (two
    // cycles of the two-phase blend). A flash in the WCAG sense is a swing of 10% of full white.
    const report: string[] = [];
    for (const mode of ['compare', 'two-phase', 'curl + flow']) {
      const mounted = await mountHeadless('advected-noise', {
        width: 160,
        height: 90,
        params: { mode, labels: false },
      });
      const levels: number[] = [];
      for (let frame = 0; frame < 120; frame++) {
        mounted.step(2);
        const rgba = await mounted.read();
        let sum = 0;
        for (let i = 0; i < rgba.length; i += 4)
          sum +=
            0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
        levels.push(sum / (rgba.length / 4) / 255);
      }
      mounted.destroy();
      const s = stats(levels);
      const step = maxAbs(levels.slice(1).map((v, i) => v - (levels[i] ?? 0)));
      report.push(
        `${mode.padEnd(12)} mean ${fixed(s.mean)}  range ${fixed(s.min)}-${fixed(s.max)}  largest change in 1/30 s ${fixed(step, 4)}`,
      );
      expect(s.mean, mode).toBeGreaterThan(0.05);
      expect(s.max - s.min, mode).toBeLessThan(0.08);
      expect(step, mode).toBeLessThan(0.01);
    }
    console.log(`advected-noise frame brightness (0..1 of full white), 4 s\n${report.join('\n')}`);
  });
});
