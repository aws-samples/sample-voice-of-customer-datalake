import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // The deployment-prefix guards synthesize the whole app out of process
    // (lib/test-support/synth-app.ts) because stack ids and export names only
    // exist in bin/voc-datalake.ts. That is ~10s per synth, well past the 5s
    // default.
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
