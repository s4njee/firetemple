import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'advected-noise',
  title: 'Advected noise',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'noise', 'motion'],
  summary:
    'Ways to make noise look carried by rising gas instead of sliding past as one texture, side by side on the same heat field: scroll, domain warp, flow noise, curl displacement, a two-phase flow blend, and the combination that measures best.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A looping video or animated WebP of the chosen variant; a still frame loses the whole point.',
    useCases: [
      'Choosing how a procedural flame, smoke or ember bed is animated: every variant is one call in advect.wgsl',
      'Seeing what a moving-noise trick costs in noise evaluations before spending it per pixel',
      'A warm abstract fire wall (the backdrop preset) where no flame shape is needed',
    ],
  },
};
