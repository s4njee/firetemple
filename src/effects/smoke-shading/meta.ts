import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'smoke-shading',
  title: 'Smoke shading',
  epic: '3',
  tier: 'C',
  tags: ['building-block', 'smoke', 'volumetric', 'overlay'],
  summary:
    'A ray-marched smoke plume lit from below by its fire and from above by a dim sky, comparing three ways to self-shadow it.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A still frame of the plume as a transparent PNG; smoke moves slowly enough that a still reads as smoke.',
    useCases: [
      'Reference for shading smoke in the volumetric fire effects: soot colour, self-shadowing, underlight',
      'A smoke column over a hero or a card, on a dark or a light page (it has real coverage)',
      'Choosing a self-shadowing method by eye: switch `shadowing` between none, gradient and march',
    ],
  },
};
