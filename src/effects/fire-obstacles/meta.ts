import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-obstacles',
  title: 'Fire round obstacles',
  epic: '6',
  tier: 'B',
  tags: ['simulation', 'fluid', 'compute', 'overlay', 'dom', 'interactive', 'smoke'],
  summary:
    'Hot gas from a burner under the page rises through a fluid simulation and meets the page as solid walls: the marked cards, headings and buttons. The plume splits round them, curls over their top edges and leaves smoke pooled under overhangs. Press to add heat.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'Nothing: it is decoration round real content, which is still there without it. The still poster, or a CSS glow under the cards, is the nearest stand-in.',
    useCases: [
      'A landing page or a 404 whose cards and headings sit in a rising fire and shape it',
      'Showing that a simulation knows where the page is: flow that parts round elements and pools under them',
      'Judging the solver against solids: the SDF test shapes (card row, circle, slanted plate) without a page',
    ],
  },
};
