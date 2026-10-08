// Shared Stryker settings of the three TypeScript packages (frontend, lambda/stream, the CDK app).
// Each package's stryker.config.mjs calls strykerConfig() with its own file globs.
//
// Two ways it is run:
//   - per file, by voc-datalake/scripts/mutate-ts.sh (the mutation programme): STRYKER_PER_FILE=1 makes
//     any surviving or uncovered mutant fail the run (break: 100) and writes the JSON report the wrapper
//     prints the survivors from;
//   - as a report, by scripts/mutation-report.sh: break stays off.
//
// Environment:
//   STRYKER_CONCURRENCY  test-runner processes (default 2: a round runs several agents at once)
//   STRYKER_INCREMENTAL  0 turns the incremental cache off (default on, under the gitignored .cache/)
//   STRYKER_TIMEOUT_MS   per-mutant timeout floor (default 20000)
//   STRYKER_DRY_RUN_TIMEOUT_MINUTES  the initial test run's timeout (default 30)
//   STRYKER_INCREMENTAL_FILE / STRYKER_JSON_REPORT  set by mutate-ts.sh: one cache and report per target set
//   STRYKER_VITEST_CONFIG  set by mutate-ts.sh --exclude-spec: the package's vitest config minus some specs
//   STRYKER_TYPECHECK_OFF  set by mutate-ts.sh: a glob of the mutated files (disableTypeChecks)
//
// `inPlace: true`: Stryker instruments the mutated files where they are instead of copying the package
// into a sandbox. The specs read files across packages (the frontend's lockstep specs read the stream
// Lambda's contract, the CDK suite reads lambda/ and frontend/dist) by paths relative to their own
// directory, which a sandbox copy breaks; and every agent owns its own worktree, so nothing else reads
// the instrumented file meanwhile. mutate-ts.sh restores the file if a run is killed half-way.
const env = process.env;
const perFile = env.STRYKER_PER_FILE === '1';

/**
 * The Stryker options of one package (a PartialStrykerOptions object).
 * @param {{ mutate: string[], vitestConfig: string, ignorePatterns?: string[] }} pkg
 */
export function strykerConfig({ mutate, vitestConfig, ignorePatterns = [] }) {
  return {
    testRunner: 'vitest',
    vitest: { configFile: env.STRYKER_VITEST_CONFIG ?? vitestConfig },
    mutate,
    inPlace: true,
    // `// @ts-nocheck` on the instrumented files only: the CDK suite synthesizes the app out of process
    // through ts-node, which type-checks and rejects an instrumented file without it. The default glob
    // would rewrite (and, on restore, re-create without the exec bit) every .js/.ts/.mjs file of the
    // package in place; mutate-ts.sh passes the exact files it mutates.
    disableTypeChecks: env.STRYKER_TYPECHECK_OFF ?? false,
    coverageAnalysis: 'perTest',
    concurrency: Number(env.STRYKER_CONCURRENCY ?? 2),
    incremental: env.STRYKER_INCREMENTAL !== '0',
    incrementalFile: env.STRYKER_INCREMENTAL_FILE ?? '.cache/stryker/incremental.json',
    reporters: perFile ? ['json', 'progress'] : ['clear-text', 'progress'],
    jsonReporter: { fileName: env.STRYKER_JSON_REPORT ?? '.cache/stryker/report.json' },
    clearTextReporter: { allowColor: false, reportTests: false },
    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always',
    ignorePatterns: ['.cache', 'coverage', 'dist', 'cdk.out', '.venv', ...ignorePatterns],
    timeoutMS: Number(env.STRYKER_TIMEOUT_MS ?? 20000),
    timeoutFactor: 2,
    // The initial (unmutated) run with per-test coverage. Stryker's 5-minute default is shorter than a
    // whole-package frontend sweep's dry run on a loaded machine (it timed out at 5 min, 2026-10-08).
    dryRunTimeoutMinutes: Number(env.STRYKER_DRY_RUN_TIMEOUT_MINUTES ?? 30),
    // A per-file run is a gate: anything below 100 (a survivor, or a mutant no test covers) fails it.
    // An equivalent mutant marked `// Stryker disable next-line <mutator>: <reason>` is ignored, not counted.
    thresholds: { high: 100, low: 0, break: perFile ? 100 : null },
  };
}
