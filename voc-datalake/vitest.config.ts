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
    // Which is only sound if the 5s budget measures the TEST rather than machine
    // load, hence this: one file at a time. Two suites here shell out to a
    // whole-app `cdk synth`, so file parallelism oversubscribes the CPU with more
    // processes than vitest sizes for. On a cold run that took
    // api-stack.test.ts's heaviest case from 1.3s to 6.8s and failed it on the
    // 5s default — a flake in a file nothing in that change touched.
    //
    // Four suites sit in the exposed band, not one: under parallel execution
    // api-stack (0.9s), cdn-signing-keys (0.8s), core-stack (0.6s) and
    // synth-app (0.4s) all synthesize CloudFormation in-process, and the cold
    // multiplier measured ~5x. So a per-file timeout would mean editing four
    // unrelated suites, and raising the global timeout is what the 5s default is
    // here to avoid. Vitest has no per-FILE parallelism opt-out (`sequential`
    // works within a file; `maxWorkers` still leaves the contention, just less
    // of it), so the choice is this one line or a second vitest project purely
    // to isolate two files.
    //
    // Measured cost, after removing the redundant third whole-app synth: ~19s
    // serial against ~11s parallel. Worth 8s for a gate whose timings otherwise
    // depend on what else the machine is doing.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
