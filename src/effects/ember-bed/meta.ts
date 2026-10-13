import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'ember-bed',
  title: 'Ember bed',
  epic: '4',
  tier: 'A',
  tags: ['background', 'embers', 'voronoi', 'blackbody', 'calm'],
  summary:
    'A bed of glowing coals: dark crusts, cracks that breathe, and heat drifting slowly across it. The coal layout is baked once, so a frame is three texture fetches.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The poster: a still of the bed reads the same, since nothing in it moves fast. A CSS radial gradient from dark red to black is the cheapest stand-in.',
    useCases: [
      'A calm, warm background for a hero, a footer or a card, safe to leave running',
      'The base of a fire: put a flame effect above it, or sparks over it',
      'A loading or idle state that should feel warm without drawing the eye',
      'It is an opaque dark picture, so it works on a light page as an image does, in its own box',
    ],
  },
};
