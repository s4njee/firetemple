import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'volume-march',
  title: 'Volume ray-march kernel',
  epic: '3',
  tier: 'C',
  tags: ['building-block', 'volumetric', '3d', 'smoke'],
  summary:
    'An emissive flame and absorbing smoke integrated in one ray march, at reduced resolution, upsampled under the depth buffer so edges against geometry stay sharp.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'A looped video or flipbook of the same shot; the march has no cheaper live equivalent.',
    useCases: [
      'The integration kernel under every volumetric fire and smoke effect on the site',
      'A 3D fire that geometry can stand in front of, inside and behind',
      'Choosing step count, march resolution, jitter and upsample filter for a volumetric effect',
    ],
  },
};
