import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'forest-fire',
  title: 'Forest-fire automaton',
  epic: '5',
  tier: 'A',
  tags: ['simulation', 'cellular', 'background', 'interactive', 'wind', 'top-down'],
  summary:
    'A landscape that burns, regrows and burns again: the Drossel–Schwabl forest-fire automaton on a small grid, with wind, lightning and smoke. Tap or drag to start a fire.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The poster: a still of the map with a fire on it. The rule is a few lines and runs on a 2D canvas at this grid size, so a CPU port is a realistic second step; a looped video cannot be touched.',
    useCases: [
      'A slow, living background for a hero or a section that rewards being left alone for a minute',
      'An interactive piece: visitors start fires with a tap or a drag and watch where the wind takes them',
      'Explaining self-organised criticality, fire regimes or wind-driven spread with something that runs',
      'It is an opaque map, so it works on a light page as an image does, in its own box',
    ],
  },
};
