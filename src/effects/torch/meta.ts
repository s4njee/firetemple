import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'torch',
  title: 'Torch and brazier',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'overlay', 'icons', 'loop', '2d', 'shader-only'],
  summary:
    'Up to 48 small flames in one canvas, each on a torch or in a brazier and each with its own seed, in a loop that closes exactly. Built to find out what many small flames cost.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A sprite sheet or animated WebP baked from one loop of the effect (it repeats exactly), or the poster as a still.',
    useCases: [
      'List markers, bullets and status icons: many small flames drawn by one canvas laid over the list',
      'A row of wall torches or braziers along a header, a sidebar or a section edge',
      'A seamless loop to bake into a sprite sheet for places WebGPU does not reach',
    ],
  },
};
