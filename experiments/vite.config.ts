import { defineConfig } from 'vitest/config';
import { wgsl } from '../vite-plugin-wgsl.ts';

export default defineConfig({
  plugins: [wgsl()],
  test: {
    environment: 'node',
    include: ['experiments/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    maxWorkers: 1,
  },
});
