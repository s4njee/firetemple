import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'sparks',
  title: 'Stateless sparks',
  epic: '4',
  tier: 'A',
  tags: ['overlay', 'sparks', 'embers', 'stateless', 'hash-grid'],
  summary:
    'Sparks that rise, wobble, cool and die with no buffers and no particle state: each pixel finds its spark from two hashes, in a few depth layers.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    flashPresets: ['welding spray', 'grinder'],
    lightPage: 'no',
    features: { required: [] },
    fallback:
      'Nothing, or a still transparent image of a few sparks: it is decoration and the page loses no meaning without it.',
    useCases: [
      'Embers drifting up behind a dark hero or over a fire drawn by another effect',
      'A welding or grinding spray from a point: a button, a logo, a cursor',
      'Dark pages only. Over a light page a spark is a few pale orange pixels and does not read',
      'Any place a particle system would be overkill: it costs the same with ten sparks or a thousand',
      'The welding spray and grinder presets are over the flash threshold when they fill a large view: keep them small',
    ],
  },
};
