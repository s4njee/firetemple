import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'particle-trails',
  title: 'Particle trails',
  epic: '7',
  tier: 'B',
  tags: ['overlay', 'particles', 'compute', 'interactive', 'study'],
  summary:
    'Two ways to give a particle a trail, side by side on the same particles: ribbons built from each particle’s own history of positions, and an HDR buffer that fades a little every frame. Comets, a sparkler and embers in a vortex; press to throw sparks.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'Velocity-stretched sprites (the sprite renderer’s `stretch` and `trail`) give a short comet tail with no history at all; without WebGPU, the stateless `sparks` effect.',
    useCases: [
      'Comets, meteors and thrown sparks whose path should stay visible behind them',
      'A sparkler or a pointer trail: short bright streaks that follow the motion',
      'Embers caught in a vortex, where the trail shows the flow',
      'Choosing between ribbons and an accumulation buffer for a particle effect of your own',
    ],
  },
};
