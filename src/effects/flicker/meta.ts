import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'flicker',
  title: 'Flicker signals',
  epic: '3',
  tier: 'A',
  tags: ['building-block', 'flicker', 'accessibility'],
  summary:
    'The shared flicker signal driving three candles, with a scrolling trace of each against the 10% band that defines a flash. Capped by default; the uncapped path is an explicit switch.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    // At the defaults, and at any setting while "uncapped" is off: the signal is capped by
    // construction and measured at 2 flashes a second in the worst case (WCAG 2.3.1 allows 3).
    // The "uncapped" switch is off by default; turned on with high settings it exceeds the limit.
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The same signal from src/gpu/emission/flicker.ts driving a CSS opacity or filter on a still image; it is plain TypeScript and needs no GPU.',
    useCases: [
      'Intensity and position flicker for any flame, torch, ember bed or firelight on the site, safe by default',
      'One signal shared by a WebGPU flame and the CSS glow around it, so the two stay in step',
      'Checking a flicker setting against the flash threshold before it ships: the trace shows what the cap does to it',
    ],
  },
};
