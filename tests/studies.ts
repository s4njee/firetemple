// Extra configurations for the cost studies, beyond "every effect at its defaults and at each
// preset", which `tests/study.test.ts` runs anyway. Keyed by epic. Use these for sweeps that
// answer a research question (how cost grows with a parameter).

export interface StudyConfig {
  effect: string;
  /** Shown in the report, e.g. "levels=3". */
  name: string;
  preset?: string;
  params?: Readonly<Record<string, unknown>>;
}

const sweep = (
  effect: string,
  key: string,
  values: readonly (string | number)[],
  fixed: Readonly<Record<string, unknown>> = {},
): StudyConfig[] =>
  values.map((value) => ({
    effect,
    name: [...Object.entries(fixed), [key, value]].map(([k, v]) => `${k}=${String(v)}`).join(' '),
    params: { ...fixed, [key]: value },
  }));

export const STUDY_SWEEPS: Readonly<Record<string, readonly StudyConfig[]>> = {
  '3': [
    // 3.4: what each bloom level costs, and what bloom costs at all.
    ...sweep('bloom-tuning', 'levels', [1, 2, 3, 4, 5, 6]),
    { effect: 'bloom-tuning', name: 'bloom=0', params: { bloom: 0 } },
    // 3.8: one advection variant at a time.
    ...sweep('advected-noise', 'mode', [
      'scroll',
      'warp',
      'flow noise',
      'curl',
      'two-phase',
      'curl + flow',
    ]),
    // 3.10: self-shadowing options, and the step count.
    ...sweep('smoke-shading', 'shadowing', ['none', 'gradient', 'march']),
    ...sweep('smoke-shading', 'steps', [16, 32, 64]),
    // 3.11: shadow methods.
    ...sweep('fire-light', 'shadows', ['none', 'hard', 'soft', 'traced', 'traced-classic']),
    // 3.12: march resolution and step count.
    ...sweep('volume-march', 'resolution', ['1', '1/2', '1/4']),
    ...sweep('volume-march', 'steps', [32, 64, 128], { resolution: '1/2' }),
    ...sweep('volume-march', 'upsample', ['bilinear', 'depth-aware'], { resolution: '1/2' }),
  ],
  '4': [
    // 4.8: does a grid of small flames cost more as it fills up?
    ...sweep('torch', 'count', [1, 4, 12, 24, 48]),
    // 4.9: sparks should not cost more as they get denser.
    ...sweep('sparks', 'layers', [1, 2, 3, 4]),
  ],
  '5': [
    // 5.9: grid resolution against frame time, and render pass against compute.
    ...sweep('doom-fire', 'resolution', [48, 96, 192, 256], { backend: 'render' }),
    ...sweep('doom-fire', 'resolution', [48, 96, 192, 256], { backend: 'compute' }),
    ...sweep('burn-front', 'resolution', [64, 128, 256, 512]),
    ...sweep('forest-fire', 'resolution', [48, 90, 180, 360]),
    ...sweep('combustion-front', 'grid', [192, 256, 384, 512]),
  ],
  '6': [
    // 6.10: velocity grid against frame time, and what the pressure solve costs.
    ...sweep('stable-fluids', 'resolution', ['64', '96', '128', '192', '256']),
    ...sweep('stable-fluids', 'pressureSolver', ['jacobi', 'sor', 'multigrid'], {
      resolution: '192',
    }),
    ...sweep('fire-fluid', 'resolution', ['96', '128', '160', '192']),
    ...sweep('fire-3d', 'grid', ['32', '48', '64']),
  ],
  '7': [
    // 7.10: particle count against frame time. `count` is the pool; `fill` keeps it that full.
    ...sweep('particle-system', 'count', [16384, 65536, 262144, 1048576], { fill: 0.95 }),
    ...sweep('particle-system', 'count', [65536, 262144, 1048576], { space: '3d', fill: 0.95 }),
    ...sweep('embers', 'count', [2500, 10000, 40000, 200000]),
    // 7.4: the particle flame against its count (the 4.1 noise flame is in the defaults).
    ...sweep('particle-flame', 'count', [500, 2500, 10000]),
    // 7.7: ribbons against accumulation as the particle count grows.
    ...sweep('particle-trails', 'count', [1000, 10000, 100000], { method: 'ribbons' }),
    ...sweep('particle-trails', 'count', [1000, 10000, 100000], { method: 'accumulation' }),
    // 7.9: the four blending modes, and the sort methods, at the default and a dense count.
    ...sweep('particle-blending', 'mode', ['additive', 'unsorted', 'sorted', 'oit'], {
      count: 2048,
    }),
    ...sweep('particle-blending', 'mode', ['additive', 'unsorted', 'sorted', 'oit'], {
      count: 32768,
    }),
    ...sweep('particle-blending', 'sort', ['radix', 'radix16', 'bitonic', 'temporal'], {
      count: 32768,
    }),
  ],
};
