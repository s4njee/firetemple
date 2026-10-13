import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fireplace',
  title: 'Fireplace',
  epic: '4',
  tier: 'A',
  tags: ['scene', 'hero', 'flame', 'logs', 'embers', 'stateless'],
  summary:
    'A whole hearth in one fragment pass: three layers of flame behind charred logs with glowing undersides, firelight on the wall and floor, and embers rising, with no simulation state.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The poster, or a short looping video of the same scene; a still fireplace still reads as one.',
    useCases: [
      'A hero or a card that should feel like sitting by a fire',
      'A cosy background for a landing page, a menu or a holiday banner',
      'A "low evening fire" or "dying embers" idle state: the presets go down to a glow',
      'It is an opaque scene with its own dark room, so a light page shows it as a picture in a box',
    ],
  },
};
