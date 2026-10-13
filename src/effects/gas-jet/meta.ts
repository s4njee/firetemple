import type { EffectMeta } from '../types.ts';

export const meta: EffectMeta = {
  id: 'gas-jet',
  title: 'Gas jet',
  epic: '4',
  tier: 'A',
  tags: ['flame', 'overlay', 'gas', 'jet', '2d', 'shader-only'],
  summary:
    'A blue directional flame: a tight cone with a pale inner cone, alone, in a row or as a stove burner seen from above, and with shock diamonds along it for an exhaust.',
  scorecard: {
    compute: false,
    mobile: 'untested',
    flash: 'low',
    lightPage: 'yes',
    features: { required: [] },
    fallback:
      'The poster as a transparent image, or a CSS gradient cone (blue to transparent) with a blurred pale core; the jet barely moves, so a still loses little.',
    useCases: [
      'A burner or pilot light as a state: on, heating, cooking, boosting',
      'Rocket, thruster and afterburner exhausts behind a logo, a ship or a launch button',
      'A blowtorch or welding flame as a cursor trail tip or a progress indicator head',
    ],
  },
};
