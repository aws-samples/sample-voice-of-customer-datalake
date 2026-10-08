import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Each test file synthesizes into its own temp dir, removed when the file ends (a bare
    // `new cdk.App()` otherwise leaves a ~340 MB cdk.out* in $TMPDIR per synth).
    setupFiles: ['lib/test-support/cdk-tmpdir.setup.ts'],
    // Files run in parallel, on a bounded pool. This used to be `fileParallelism:
    // false`: two suites shell out to a whole-app `cdk synth`, and on a cold run
    // parallel files once pushed api-stack.test.ts's heaviest case past the 5s
    // default. Measured again (2026-10-07, 41 files / 795 tests, 12-core Mac):
    // serial 89s, 4 workers 30s, 8 workers 20s; the slowest IN-PROCESS case at
    // 4 workers was 2.8s (the cdk-nag pass in api-stack-jobs.test.ts), the
    // out-of-process synth cases (SYNTH_TIMEOUT_MS) 7–11s. Four workers keep
    // most of the gain and leave headroom under the 5s default; the default
    // timeout itself stays put deliberately — raising it globally would make a
    // hung test take minutes to report. scripts/validate.sh, which runs this
    // suite beside three other lanes, passes its own --testTimeout for load.
    //
    // Sharing synthesized templates across files (one synth per worker) was
    // measured too and NOT done: the whole run makes 122 in-process synths
    // totalling ~13s of CPU, against ~55s of module import and ~100s of tests,
    // so it would buy little and cost per-file module isolation (two suites
    // vi.mock the plugin loader).
    fileParallelism: true,
    pool: 'forks',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.test.ts'],
    },
  },
});
