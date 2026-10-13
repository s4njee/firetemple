import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'hello',
  title: 'Hello, fire',
  epic: '1',
  tier: 'C',
  tags: ['foundation'],
  summary:
    'Rising warped noise through the HDR tail. Exists to exercise the foundation end to end.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback: 'A static image in the same palette, or a dark CSS gradient.',
    useCases: [
      'Smoke test for the shader pipeline, HDR tail, shell and shared WGSL library',
      'A warm abstract backdrop; it glows, but nothing about it has the shape of a flame yet',
    ],
  },
};
