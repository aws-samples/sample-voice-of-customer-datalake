import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The per-file coverage gate (docs/coverage-gate.md) reads this through scripts/validate.sh, which adds
    // `--coverage.enabled --coverage.reporter=json-summary` on the command line.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
      // Spec files and test-only data (`*-fixtures.ts`, `__fixtures__/`) are not production code.
      exclude: ['src/**/*.test.ts', 'src/**/*-fixtures.ts', 'src/**/__fixtures__/**'],
    },
  },
});
