import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'heat-haze',
  title: 'Heat haze',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'refraction', 'distortion'],
  summary:
    'Rising hot air bends what is behind it: a noise-driven refraction of a backdrop texture, masked by heat, with a faint colour fringe and softening where it is hottest.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The backdrop itself, undistorted, with a still glow at its base. The haze is decoration: nothing is lost without it.',
    useCases: [
      'The air above any flame, ember bed, exhaust or hot surface in a scene the canvas draws itself',
      'Shimmer over a hero image or a video frame uploaded as a texture',
      'Not over live page content: a canvas cannot read the pixels of the DOM behind it',
    ],
  },
};
