/**
 * The ONE way this app builds a Python function's code asset (dupes.md cluster 9).
 *
 * Every Python Lambda used to repeat the same `Code.fromAsset(root, { exclude,
 * ignoreMode: GIT, bundling: { image, command: ['bash', '-c', …], platform } })`
 * skeleton, about a dozen copies. They now differ only in what they stage and
 * what they copy, which is all a caller passes here.
 *
 * WHY the prune exists: the staging `exclude` list shapes the asset HASH only.
 * CDK's Docker bundling mounts the UNFILTERED source directory as
 * `/asset-input`, so `cp -r /asset-input/shared` copied `shared/test/**`,
 * `__pycache__/` and every `test_*.py` into the deployed zip (about 11 MB of
 * MetricsApi's 15 MB on a developer checkout). {@link PYTHON_BUNDLE_PRUNE} runs
 * last in every bundling command and removes them from `/asset-output`, which is
 * what actually deploys.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/** Directory names that never ship, at any depth of the bundle. */
const PRUNED_DIRECTORIES = ['test', 'tests', '__pycache__', '.pytest_cache'];

/** File names that never ship, at any depth: tests, the source tree's own bytecode (recompiled below), dev secrets. */
const PRUNED_FILES = ['test_*.py', '*_test.py', 'conftest.py', '*.pyc', '.env*'];

function findNames(names: readonly string[]): string {
  return names.map((name) => `-name '${name}'`).join(' -o ');
}

/**
 * The shell step every Python bundling command ends with. Directories are
 * pruned first (so `find` does not descend into what it deletes), then files.
 */
export const PYTHON_BUNDLE_PRUNE =
  `find /asset-output -type d \\( ${findNames(PRUNED_DIRECTORIES)} \\) -prune -exec rm -rf {} + && ` +
  `find /asset-output -type f \\( ${findNames(PRUNED_FILES)} \\) -delete`;

/**
 * The step after the prune: compile every shipped `.py` to bytecode, in the bundling image (the same Python 3.14 the
 * runtime runs, so the `cpython-314` tag and magic number match).
 *
 * WHY: `/var/task` is read-only, so a bundle without `__pycache__` makes Python compile every module it imports on
 * every cold start and throw the result away. That was 35,180 lines (122 modules) for the Projects API alone, about
 * 240 ms of CPU on a developer Mac and two to three times that on Graviton (docs/lambda-sizing.md → Cold starts).
 *
 * `unchecked-hash` bytecode (PEP 552): the import system loads it without reading or hashing the source, and the
 * file carries no timestamp, so the same source gives the same bytes. Safe because a deployed bundle never changes
 * after it is built. If the runtime's Python ever differs, it ignores the files and compiles from source as before.
 * A syntax error fails the build (`-q` hides the file list, not errors); a shipped `.py` that must not be compiled
 * would need an `-x <regex>` exclusion here. The prune runs first, so a stale `.pyc` from the source tree never ships.
 * scripts/audit/py_assembly.py names this exact command as a step that ships no module (cross-checked by the test).
 */
export const PYTHON_BUNDLE_COMPILE = 'python -m compileall -q -j 0 --invalidation-mode unchecked-hash /asset-output';

/** The full `bash -c` script: the caller's copy steps, then the prune, then the bytecode compile. */
export function pythonBundleScript(copySteps: readonly string[]): string {
  return [...copySteps, PYTHON_BUNDLE_PRUNE, PYTHON_BUNDLE_COMPILE].join(' && ');
}

export interface PythonLambdaAssetOptions {
  /**
   * Staging excludes (gitignore syntax, see lambda-asset-excludes.ts). They
   * decide the asset hash; the prune decides what ships.
   */
  exclude: string[];
  /** Shell steps that copy the payload from `/asset-input` into `/asset-output`. */
  copy: readonly string[];
}

/**
 * A Python 3.14 / arm64 code asset staged from `root` (`'lambda'`, or `'.'` for
 * bundles that span `plugins/` and `lambda/shared`), always in
 * `IgnoreMode.GIT`, always ending with {@link PYTHON_BUNDLE_PRUNE} and then {@link PYTHON_BUNDLE_COMPILE}.
 */
export function pythonLambdaAsset(root: 'lambda' | '.', options: PythonLambdaAssetOptions): lambda.Code {
  return lambda.Code.fromAsset(root, {
    exclude: options.exclude,
    ignoreMode: cdk.IgnoreMode.GIT,
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      command: ['bash', '-c', pythonBundleScript(options.copy)],
      platform: 'linux/arm64',
    },
  });
}
