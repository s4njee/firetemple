import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fireworks',
  title: 'Fireworks',
  epic: '7',
  tier: 'B',
  tags: ['overlay', 'particles', 'compute', 'interactive', 'simulation'],
  summary:
    'Aerial shells as multi-stage emitters, entirely on the GPU: a shell rises with a spark tail and breaks at its apogee into a peony, chrysanthemum, willow, ring, palm, crossette, crackle or glitter burst, in the colours of real emitter salts. Click or tap to send one up to the pointer.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'A still poster of a burst, or nothing: fireworks are celebration, not content. There is no fragment-only version; a few shells as CPU sprites (`soft-sprites`) would be the cheapest stand-in.',
    useCases: [
      'A celebration over a dark hero, a launch page or a "thank you" screen, with shells going up on their own',
      'A click or tap that answers with a shell bursting where the pointer is',
      'Scroll or music driven: the drive adds shells to the schedule, never speed',
      'Over a page as an overlay: on a dark page the bursts are light; on a light page they are confetti',
    ],
  },
};
