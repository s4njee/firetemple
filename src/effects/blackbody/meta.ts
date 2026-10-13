import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'blackbody',
  title: 'Blackbody colour',
  epic: '3',
  tier: 'B',
  tags: ['building-block', 'colour'],
  summary:
    'Temperature to colour three ways (Planck integral, polynomial fit, lookup texture) with their error, and a brightness mapping tamed enough to use.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A static image of the chart; the colours themselves are available to CSS from the TypeScript twin.',
    useCases: [
      'Colouring a simulated temperature field: blackbody_radiance(t, t_ref, gamma) per pixel',
      'Tinting lights, embers and sparks by temperature without a texture binding (blackbody_tint)',
      'Choosing between the fit and the lookup texture: this scene shows the error of each',
    ],
  },
};
