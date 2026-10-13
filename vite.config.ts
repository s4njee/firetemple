import { defineConfig } from 'vitest/config';
import { wgsl } from './vite-plugin-wgsl.ts';

export default defineConfig({
  // Static hosts that serve from a sub-path (e.g. GitHub Pages) set BASE_PATH at build time.
  base: process.env.BASE_PATH ?? '/',
  build: {
    // scripts/check-bundle.mjs reads the manifest to see what the first page load pulls in.
    manifest: true,
    target: 'es2022',
  },
  plugins: [wgsl()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
