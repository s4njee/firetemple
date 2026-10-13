import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'candle',
  title: 'Candle flame',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'overlay', 'pointer', '2d', 'shader-only'],
  summary:
    'One candle on the page: a teardrop flame with a blue foot, a dark wick and a soft halo over a wax body. It sways on its own and leans away from the pointer.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The poster as a transparent image, or an inline SVG candle with a CSS animation on the flame path; with reduced motion the still frame is the whole effect.',
    useCases: [
      'A memorial, vigil or "lit" state: one calm flame beside a name, a date or a heading',
      'A cursor toy on a landing page: the flame bends as the pointer passes and springs back',
      'A row of tea lights as a quiet footer or loading state, one small canvas each',
    ],
  },
};
