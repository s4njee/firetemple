import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'embers',
  title: 'Embers',
  epic: '7',
  tier: 'A',
  tags: ['overlay', 'embers', 'particles', 'compute', 'interactive', 'simulation'],
  summary:
    'Flying embers as real particles: they rise off a hidden fire line, drift in curl-noise air, cool along the blackbody curve from yellow-orange to deep red and out, and twinkle each at its own pace. Press and drag to wave a torch through them.',
  scorecard: {
    compute: true,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'The stateless `sparks` effect (a fragment shader, no compute) in its campfire preset, or nothing: embers are decoration and the page loses no meaning without them.',
    useCases: [
      'Embers drifting up over a dark hero, a footer or the whole page, behind or in front of the content',
      'Over a fire drawn by another effect: the particles carry the heat above the flames',
      'A torch that follows a press and drag, leaving a trail of embers that drift off on the air',
      'Scroll or music driven: the drive adds embers as a share of the calm rate, never speed',
      'Dark pages only: on a light page an ember is a few pale orange pixels',
    ],
  },
};
