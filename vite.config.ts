import { defineConfig } from 'vitest/config';
import { wgsl } from './vite-plugin-wgsl.ts';

export default defineConfig({
  // Static hosts that serve from a sub-path (e.g. GitHub Pages) set BASE_PATH at build time.
  base: process.env.BASE_PATH ?? '/',
  build: {
    // scripts/check-bundle.mjs reads the manifest to see what the first page load pulls in.
    manifest: true,
    target: 'es2022',
    // Never inline an asset as a data URL: the only assets are fallback posters, which the
    // registry lists eagerly, and a small one would otherwise be pasted into the first load.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // Every effect's meta.ts is needed at once, by the gallery. Left alone, each becomes its
        // own tiny chunk (the effect's lazy chunk imports it too), which is one request per effect
        // on the first load.
        codeSplitting: {
          groups: [{ name: 'effect-meta', test: /src\/effects\/[^/]+\/meta\.ts$/ }],
        },
      },
    },
  },
  plugins: [wgsl()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Most tests compile shaders and read pixels back. That is milliseconds on a GPU and can be
    // seconds on CI's software rasteriser, where the default 5 s made unrelated tests time out.
    testTimeout: 30_000,
  },
});
