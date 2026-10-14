import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-3d',
  title: '3D combustion',
  epic: '6',
  tier: 'C',
  tags: ['simulation', 'compute', 'fluid', 'volumetric', '3d', 'scene', 'smoke', 'interactive'],
  summary:
    'Fuel, heat and smoke carried by a 3D stable-fluids solver, burning above an ignition temperature, and ray-marched as blackbody flame and fire-lit smoke over a small scene.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'A looped video or flipbook of the same shot (story 8.6), or the 2D grid fire of Epic 6 for a flat view.',
    useCases: [
      'A hero scene with a fire the camera can go round: campfire, brazier, gas burner',
      'Fire that reacts to the scene: wind, a burst of fuel, a burner turned up',
      'The upper bound of what a browser can simulate in 3D within a frame budget',
    ],
  },
};
