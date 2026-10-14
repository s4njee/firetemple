import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'combustion-front',
  title: 'Reaction–diffusion combustion',
  epic: '5',
  tier: 'B',
  tags: ['simulation', 'overlay', 'interactive', 'front', 'blackbody'],
  summary:
    'Fire as a travelling front in two continuous fields, temperature and fuel. Heat diffuses into unburnt fuel, the fuel ignites and releases heat; the speed and thickness of the front follow from the physical constants. Tap or drag to light it.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A looping video of the fronts crossing with the same alpha, or the still poster; under reduced motion one frame is a complete picture of fronts and char.',
    useCases: [
      'A page or hero that burns: fronts creep over the content, leave char and the ground grows back',
      'Touch-to-ignite surfaces where the fire has to spread at a believable, tunable speed',
      'The reference model to compare a rule-based burn front against: speed, width and extinction come from constants',
    ],
  },
};
