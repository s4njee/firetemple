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
};
