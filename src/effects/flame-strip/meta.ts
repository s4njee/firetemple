import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'flame-strip',
  title: 'Flame strip',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'overlay', 'divider', 'footer', 'tileable'],
  summary:
    'A band of flame tongues along the bottom edge of a wide, short canvas. It repeats exactly once per canvas width, so it tiles at any width, and is see-through above the flames.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A horizontally repeating animated WebP or a short looping video of one period, anchored to the bottom edge; a still of it under reduced motion.',
    useCases: [
      'A section break: a short full-width band of flame between two blocks of content',
      'The top edge of a footer, or the bottom edge of a hero, with the page showing above it',
      'A low ember line under a heading or along the bottom of a card',
    ],
  },
};
