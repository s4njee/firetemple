import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'spark-shower',
  title: 'Spark shower',
  epic: '7',
  tier: 'B',
  tags: ['overlay', 'sparks', 'particles', 'compute', 'interactive', 'simulation', 'collisions'],
  summary:
    'A grinder, welding or forge shower of sparks as GPU particles: white-hot streaks arc under gravity and drag, cool along the blackbody curve, bounce off the floor, an anvil and the page’s own cards, and split on impact into smaller, cooler sparks. Move the pointer to aim the grinder; press to bite harder.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'The stateless `sparks` effect (a fragment shader, no compute) in its grinder preset kept small, or nothing: a spark shower is decoration and the page loses no meaning without it.',
    useCases: [
      'A grinder or welding spray from a point on a dark page: a hero, a product shot, a cursor',
      'Sparks that land on the page’s own cards and buttons, skid off their edges and split',
      'A forge with an anvil and hammer strikes, as a section header or a loading moment',
      'Scroll or music driven: the drive adds sparks as a share of the calm rate, never speed',
      'Dark pages only: on a light page a spark is a thin pale streak',
    ],
  },
};
