import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'flame-ramps',
  title: 'Flame colour ramps',
  epic: '3',
  tier: 'B',
  tags: ['building-block', 'colour'],
  summary:
    'One flame through eight colour ramps: blackbody, an authored fire gradient, a banded toon ramp, a blue gas flame and four chemical tints, each as a formula and as a baked texture.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A static image; the same ramps are available to CSS gradients from the TypeScript twins.',
    useCases: [
      'Picking the heat-to-colour mapping for any procedural or simulated flame',
      'Themed fire: copper green, sodium yellow, potassium lilac, lithium crimson, blue gas',
      'Art-directed or banded gradients baked from colour stops into one small texture',
    ],
  },
};
