import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'dom-fuel',
  title: 'DOM as fuel',
  epic: '5',
  tier: 'A',
  tags: ['simulation', 'overlay', 'dom', 'interactive'],
  summary:
    'The page is the fuel: the rounded rectangles of marked elements are drawn into a fuel map, so fire climbs cards and headings, stops at the gaps between them, leaves a scorch that fades, and the fuel returns.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'Nothing: it is decoration on top of real content, which is still there without it. A CSS box-shadow glow on hover is the nearest static stand-in.',
    useCases: [
      'A page that catches fire where it is clicked: a 404, a launch page, a game menu',
      'Cards or headings that burn on a destructive action (delete, dismiss) and come back',
      'Ambient embers smouldering on a dark landing page without hiding its content',
    ],
  },
};
