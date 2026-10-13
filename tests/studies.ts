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

export const STUDY_SWEEPS: Readonly<Record<string, readonly StudyConfig[]>> = {};
