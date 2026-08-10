import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // The default timeout stays put deliberately. Only the two out-of-process
    // synth suites need longer, and they set it per-`describe` — raising it
    // globally would make an unrelated hung test in any of the other suites take
    // two minutes to report instead of five seconds.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
