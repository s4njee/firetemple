import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'haze-overlay',
  title: 'Heat-haze overlay',
  epic: '4',
  tier: 'A',
  tags: ['refraction', 'distortion', 'image', 'video', 'haze'],
  summary:
    'Hot air on its own: an image or a video shimmering in a band, a plume or all over, with no flame in sight. Drop a photo or a video file on it to try your own.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The image or the video itself, undistorted. The shimmer is decoration: nothing is lost without it.',
    useCases: [
      'A hero photograph of a road, a desert, a runway or a grill that should feel hot',
      'The air above an exhaust, a chimney or an engine in a product shot or a video loop',
      'Not over live page content: a canvas can only distort an image, a video or what it draws itself',
    ],
  },
};
