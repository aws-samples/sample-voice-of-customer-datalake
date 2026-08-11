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
    //
    // Which is only sound if the 5s budget is about the TEST rather than about
    // machine load, hence this: one file at a time. Several suites here
    // synthesize CloudFormation, which is CPU-bound, and two of them shell out
    // to a whole-app `cdk synth` — so running files in parallel oversubscribes
    // the CPU by more processes than vitest is sizing for. Measured on a cold
    // run, that took api-stack.test.ts's heaviest case from 1.3s to 6.8s and
    // failed it on the 5s default: a flake in a suite the change never touched.
    // The cost is real (~54s serial vs ~38s parallel on a warm cache) and worth
    // it for a gate whose timings are otherwise load-dependent.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
