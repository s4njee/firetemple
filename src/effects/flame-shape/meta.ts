import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'flame-shape',
  title: 'Flame shaping',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'flame', 'sdf'],
  summary:
    'One flame at three stages: a teardrop or taper distance field, the heat left after turbulence and erosion, and that heat through the fire ramp.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A static image or a short looping video of the flame; the diagram panels can be a PNG.',
    useCases: [
      'Reference for the shared flame.wgsl chunk: every 2D flame effect starts from these functions',
      'Tuning a silhouette (width, turbulence, erosion, falloff) before building a candle, torch or jet',
      'A single stylised flame for a hero or a card, using the full-frame "flame" view',
    ],
  },
};
