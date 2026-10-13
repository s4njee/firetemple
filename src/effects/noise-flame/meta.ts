import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'noise-flame',
  title: 'Scrolling-noise flame',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'overlay', 'noise', 'hero'],
  summary:
    'The classic: noise scrolled upward, shaped by a height gradient, through a fire ramp. A wall of flame along the bottom edge, with five noise sources to compare.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A looping video or animated WebP of the flame wall with the same alpha; a still poster under reduced motion.',
    useCases: [
      'A wall of fire along the bottom of a hero or a full-bleed section, over the page',
      'A background for a dark landing page, with the flames kept below the headline',
      'Starting point for any 2D flame: the gradient-minus-noise recipe in its smallest form',
    ],
  },
};
