import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'firelight-background',
  title: 'Firelight background',
  epic: '4',
  tier: 'A',
  tags: ['background', 'glow', 'ambient', 'firelight'],
  summary:
    'The warm, slowly shifting light of a fire that is just out of frame. No flames: an opaque, calm backdrop for a dark page, steady enough to sit behind text.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'A CSS radial gradient in the same colours, which is most of the picture; or a still of the canvas.',
    useCases: [
      'An ambient backdrop behind an article or a hero on a dark page, under a veil and text',
      'A warm fill behind a fire effect that is drawn on top of it',
      'A login or landing screen that should feel lit by a hearth without showing one',
    ],
  },
};
