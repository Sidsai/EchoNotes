import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'extension/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/diff/**', 'packages/core/align/**'],
      thresholds: {
        'packages/core/diff/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/core/align/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(import.meta.dirname, 'packages/core'),
      '@shared': path.resolve(import.meta.dirname, 'extension/shared'),
    },
  },
});
