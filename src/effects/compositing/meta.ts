import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'compositing',
  title: 'Compositing over the page',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'overlay', 'compositing'],
  summary:
    'One flame, smoke and logs written to a see-through canvas five ways: what an overlay effect has to put in alpha to read on a dark page and a light one.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A transparent PNG or WebP of the flame with the same alpha, or nothing: it is decoration.',
    useCases: [
      'Reference for every overlay effect: copy the alpha mode and underlay that suit the page',
      'Checking a theme: switch presets over the dark and the light page to see what survives',
      'A small campfire or hearth decoration that sits on the page instead of in a box',
    ],
  },
};
