import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'particle-blending',
  title: 'Sorting and blending',
  epic: '7',
  tier: 'C',
  tags: ['study', 'particles', 'compute', 'smoke', 'sorting', 'oit', 'overlay'],
  summary:
    'Fire and smoke puffs drawn four ways: all additive, alpha in buffer order, alpha after a GPU depth sort, and weighted blended order-independent transparency, side by side.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A still frame as a transparent PNG; smoke and a small fire read as a still. A study scene, not something to ship.',
    useCases: [
      'Choosing how to blend smoke particles: the sort and OIT modules plug into any particle buffer',
      'Seeing where each method fails: glowing smoke, wrong occlusion, popping, OIT colour bias',
      'A fire with a smoke column over a dark or a light page: the smoke has real coverage',
    ],
  },
};
