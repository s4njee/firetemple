import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'fire-haze',
  title: 'Fire as page distortion',
  epic: '6',
  tier: 'B',
  tags: [
    'simulation',
    'fluid',
    'compute',
    'refraction',
    'distortion',
    'haze',
    'image',
    'video',
    'interactive',
  ],
  summary:
    'A hidden heat source below the frame sends a plume of hot gas up through a fluid simulation, and the gas bends the picture behind it: the shimmer rises, curls and fades with the gas instead of scrolling on its own. The pointer is a torch. Drop a photo or a video file on it to try your own.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'none',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The picture itself, undistorted, or the noise-driven heat-haze overlay (no compute) for a shimmer that does not follow a flow.',
    useCases: [
      'A hero image above a grill, a radiator or an exhaust whose shimmer should rise and swirl like real hot air',
      'A pointer that warms the page it passes over: text and images waver behind it and settle',
      'Not over live page content: a canvas can only bend an image, a video or what it draws itself',
    ],
  },
};
