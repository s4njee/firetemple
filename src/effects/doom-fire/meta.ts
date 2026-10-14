import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'doom-fire',
  title: 'Doom fire',
  epic: '5',
  tier: 'A',
  tags: ['flame', 'overlay', 'simulation', 'cellular', 'interactive', 'retro'],
  summary:
    'The PSX Doom heat automaton on a small grid of its own: a bottom row held hot, heat climbing one cell a step. Draw fire with a pointer, let it die and relight it, drive it from scroll or sound.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'A looping video or animated WebP of the wall of fire with the same alpha (the pointer drawing is lost); a still poster under reduced motion. The render-pass solver is plain enough to port to WebGL2.',
    useCases: [
      'A wall of fire along the bottom of a hero, a footer or a 404 page that visitors can draw into',
      'Retro and pixel-art pages: the original palette and blocky cells are one preset away',
      'A fire that answers the page: taller while the visitor scrolls, or in time with music',
    ],
  },
};
