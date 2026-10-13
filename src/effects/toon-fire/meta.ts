import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'toon-fire',
  title: 'Toon fire',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'stylised', 'overlay', 'ui', 'sdf'],
  summary:
    'Cartoon fire: three or four flat bands of colour with hard edges and an ink outline, redrawn ten times a second like a hand-animated cel. Opaque paint, so it sits on a light page.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'An SVG or a short sprite-sheet loop of the same flame: flat shapes are exactly what those formats are good at.',
    useCases: [
      'A campfire, torch or hazard marker in a game UI or an illustrated page',
      'A flame icon or a streak badge that needs to read at 48 pixels and on a white background',
      'Coloured "magic" fire (the spirit and toxic palettes) where realism would look out of place',
    ],
  },
};
