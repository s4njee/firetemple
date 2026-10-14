import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'sparkler',
  title: 'Sparkler',
  epic: '7',
  tier: 'B',
  tags: ['overlay', 'sparks', 'particles', 'compute', 'interactive', 'simulation'],
  summary:
    'A hand-held sparkler as GPU particles: a white-hot core throws thousands of tiny sparks a second that live a fraction of a second and fork mid-flight into two or three, the branching look. The pointer is the hand; left alone, the tip traces a slow figure of eight and leaves an afterimage.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'A small looping video or a still image of a sparkler, or nothing: it is decoration and the page loses no meaning without it.',
    useCases: [
      'A celebration moment on a dark page: a launch, a birthday, a new year',
      'A cursor that writes in light: the sparkler follows the pointer and leaves an afterimage',
      'A dark hero or card that is never still: left alone, the tip traces a slow figure of eight',
      'Scroll or music driven: the drive adds sparks as a share of the calm rate, never speed',
      'Dark pages only: on a light page the sparks are thin pale lines',
    ],
  },
};
