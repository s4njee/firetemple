import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-fluid',
  title: 'Fluid fire',
  epic: '6',
  tier: 'B',
  tags: ['simulation', 'fire', 'smoke', 'interactive', 'overlay', 'compute', 'fluid'],
  summary:
    'Fire as a fluid: fuel, temperature and soot carried by an incompressible flow, burning above an ignition temperature, lifting by buoyancy and expanding where it burns. Burners, a torch you draw with (press and drag), wood, gas and chemical colours, and the three ways to keep a coarse grid lively side by side.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'There is no render-pass version of the solver, so no WebGL2 path: an Epic 4 shader fire (noise-flame, fireplace, gas-jet) or a looping video. Under reduced motion the first frame is already a burning fire.',
    useCases: [
      'A hero or backdrop fire that reacts to a visitor: drag to spray burning fuel, flames that bend round each other',
      'Burners as page furniture: a strip along the footer, a ring round an avatar, a gas jet',
      'The combustion layer later effects reuse (obstacles, heat haze over the page) and the reference for the cheaper fires',
    ],
  },
};
