import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-ring',
  title: 'Fire ring',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'polar', 'overlay', 'loader', 'ui'],
  summary:
    'A flame bent round a circle: tongues lick outward or inward from a ring, seamless all the way round, with a progress value that lights only part of it. Transparent in the middle.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A still image of the ring, or a CSS conic-gradient ring with a blur; for the loader, the CSS ring with its own rotation.',
    useCases: [
      'A portal or a summoning circle with page content showing through the middle',
      'A burning frame round an avatar or a badge',
      'A loader or a progress ring: `progress` lights the arc from twelve o’clock clockwise',
    ],
  },
};
