import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'bloom-tuning',
  title: 'Bloom tuned for fire',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'post', 'bloom'],
  summary:
    'A chart of hot shapes at known radiance, to find how little bloom still reads as heat: threshold, knee, radius, levels, and half against full resolution.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'no',
    features: { required: [] },
    fallback: 'A still image of the chart; it is a tuning tool, not decoration.',
    useCases: [
      'Choosing bloom settings for an effect before spending GPU time on them',
      'Checking that paper white does not glow and that thin, hot detail does',
      'The scene the bloom cost study sweeps `levels` and resolution over',
    ],
  },
};
