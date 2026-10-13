import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'soft-sprites',
  title: 'Soft additive sprites',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'sprites', 'particles', 'depth'],
  summary:
    'Embers, sparks and glow puffs as instanced additive quads: procedural shapes, velocity stretch, and the soft-particle depth fade that hides where a sprite cuts through geometry.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A still frame of the scene; sprites alone can also be a CSS radial-gradient per ember on a dark backdrop.',
    useCases: [
      'Embers and sparks rising off any fire, drawn over a 3D scene or over a 2D flame',
      'Glow halos and firelight in haze that must not show a seam where they meet walls and floors',
      'The draw stage of a GPU particle system: the chunk and the renderer take any instance buffer',
      'As drawn here it is an opaque dark scene; additive sprites on their own add nothing to a white page and need a dark region behind them',
    ],
  },
};
