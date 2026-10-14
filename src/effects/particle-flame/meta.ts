import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'particle-flame',
  title: 'Particle flame',
  epic: '7',
  tier: 'B',
  tags: ['flame', 'overlay', 'particles', 'compute', 'interactive', 'simulation'],
  summary:
    'The original particle-system fire: large soft sprites born hot at a base, lifted by their own heat, pulled into a taper, licked about by curl noise, cooling and shrinking until they overlap into a flame body, with embers thrown off the tips. Press to light a fire where you press.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The `noise-flame` wall (one fragment pass, no compute) or the `candle` and `torch` shader flames; a still poster under reduced motion.',
    useCases: [
      'A campfire, torch or candle that responds to wind and to the pointer, over a dark hero or a card',
      'A fire lit where the visitor presses and dying down when they let go',
      'Several small flames in one canvas: the cost follows the sprites drawn, not the canvas area',
      'The building block for a scene that also wants embers and sparks from the same particle pool',
    ],
  },
};
