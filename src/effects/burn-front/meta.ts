import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'burn-front',
  title: 'Burn front on a fuel map',
  epic: '5',
  tier: 'A',
  tags: ['simulation', 'overlay', 'paper', 'interactive', 'transition'],
  summary:
    'Burning paper: a sheet over the page that a tap or a stray ember lights. A thin glowing front crosses it, char follows and crumbles, the page shows through the hole, and the sheet grows back.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A looping video with alpha of one burn, or a still of the half-burnt sheet; under reduced motion any frame is a complete picture.',
    useCases: [
      'A cover that burns away to reveal what is under it: a hero image, a spoiler, the next section',
      'A page or route transition, lit from where the visitor clicked',
      'A card or panel that burns when dismissed and leaves the page showing through',
    ],
  },
};
