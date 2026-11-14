/**
 * The asset of a self-contained Python trigger (stdlib + the runtime's boto3, no layer): `lambda/` staged
 * and bundled down to exactly the listed files, laid out for a path-style handler (`auth/<module>.<fn>`).
 *
 * The board triggers (core-board-auth.ts BOARD_TRIGGER_FILES) and the app pool's message trigger
 * (core-auth.ts USER_MESSAGES_FILES) use it, each pinned by a bundle test in lambda/auth/test/ that imports
 * the module with ONLY those files on sys.path.
 */
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from './lambda-asset-excludes';
import { pythonLambdaAsset } from './python-lambda-asset';

/** The top-level directories of `files` (e.g. `auth`, `shared`). */
function topLevelDirs(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.split('/')[0] ?? ''))];
}

/**
 * Staging rules past the shared lists (they shape the asset hash): everything under `lambda/` is
 * excluded except `files` — exclude all, re-include each file's directory, exclude its other entries,
 * re-include the file — so an edit elsewhere never redeploys the trigger.
 */
export function onlyTheseFiles(files: readonly string[]): string[] {
  return [
    '*',
    ...topLevelDirs(files).flatMap((dir) => [`!/${dir}/`, `/${dir}/*`]),
    ...files.map((file) => `!/${file}`),
  ];
}

/** The bundling copy steps (what ships): one `mkdir` per directory, one `cp` per file. */
export function copyStepsFor(files: readonly string[]): string[] {
  return [
    ...topLevelDirs(files).map((dir) => `mkdir -p /asset-output/${dir}`),
    ...files.map((file) => `cp /asset-input/${file} /asset-output/${file}`),
  ];
}

/** The trigger asset holding exactly `files`. */
export function selfContainedTriggerCode(files: readonly string[]): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, ...onlyTheseFiles(files)],
    copy: copyStepsFor(files),
  });
}
