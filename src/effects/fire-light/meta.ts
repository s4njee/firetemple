import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-light',
  title: 'Fire as a light source',
  epic: '3',
  tier: 'B',
  tags: ['building-block', 'lighting', 'shadows', 'sdf', 'normal-map', '2d'],
  summary:
    'Wandering flames light a stone page and the cards on it: windowed inverse-square falloff, normal-mapped relief and analytic soft shadows from rounded rectangles.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A static dark image with a warm radial-gradient glow and CSS drop shadows on the cards, offset away from the glow.',
    useCases: [
      'Fire, embers or a cursor torch that lights the DOM cards around it and throws their shadows across the page',
      'Top-down 2D scenes: torches and camp fires lighting a normal-mapped floor',
      'The lighting half of any flame effect: the falloff, shadow and tint functions are a shared chunk',
    ],
  },
};
