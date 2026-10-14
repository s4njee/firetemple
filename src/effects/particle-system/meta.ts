import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'particle-system',
  title: 'GPU particle system',
  epic: '7',
  tier: 'B',
  tags: ['particles', 'compute', 'simulation', 'validation', 'overlay', '3d'],
  summary:
    'The Epic 7 particle framework laid bare: a pool of up to a million particles born, moved, collided and recycled entirely on the GPU, with every emitter shape, force and collider switchable and the live count in the HUD.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'None needed: it is a test scene for the framework, not page decoration. The effects built on the framework name their own fallbacks.',
    useCases: [
      'Checking what the framework does before building on it: shapes, rates, bursts, forces, colliders, GPU spawning, the external velocity field',
      'The scene the particle scale study (7.10) sweeps: `count` sets the pool from 1 024 to 1 048 576 and the emission keeps it about `fill` full',
      'A reference for the 2D overlay space (canvas heights) and the 3D scene space side by side',
    ],
  },
};
