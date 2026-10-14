import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-jet',
  title: 'Directed jet',
  epic: '7',
  tier: 'B',
  tags: ['overlay', 'particles', 'fluid', 'compute', 'interactive', 'simulation', 'smoke'],
  summary:
    'A flamethrower or dragon breath: a nozzle drives fuel, heat and momentum into the 2D fire fluid, and burning droplets, flame sprites and embers ride its velocity field, spreading, curling into eddies and rising as the jet slows, under the smoke the fluid makes. The nozzle aims at the pointer.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The `gas-jet` shader (a directional flame with no simulation) for the burning cone, or a looping video; a still poster under reduced motion.',
    useCases: [
      'A showpiece hero: a flamethrower that follows the pointer, or a dragon breathing across a section',
      'A jet splashing against a page element (the wall preset): flame rolling along a surface',
      'Any particles that should be carried by a simulated flow rather than by noise',
    ],
  },
};
