import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'stable-fluids',
  title: 'Stable fluids',
  epic: '6',
  tier: 'B',
  tags: ['simulation', 'smoke', 'interactive', 'overlay', 'compute', 'fluid'],
  summary:
    'The validation scene of the grid-fluid solver ported from Water Temple: smoke and ember glow rising from a smouldering bed, carried by an incompressible velocity field on a staggered grid. Drag to stir it; the controls switch the advection scheme, the pressure solver, vorticity confinement and the grid size.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'There is no render-pass version of the solver, so no WebGL2 path: the still poster, or a looping video of the plume. Under reduced motion the first frame is already a plume.',
    useCases: [
      'Checking the solver every Epic 6 effect builds on: schemes, solvers and confinement side by side',
      'Smoke that a visitor can stir, over a dark or a light page',
      'The starting point for combustion: temperature, fuel and smoke in the dye, buoyancy and expansion built in',
    ],
  },
};
