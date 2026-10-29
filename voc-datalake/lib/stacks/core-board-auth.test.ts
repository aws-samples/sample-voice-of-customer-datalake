/**
 * The board triggers' code asset ships exactly the trigger module and the two shared modules it
 * imports (BOARD_TRIGGER_FILES), laid out for the path-style handler `auth/board_triggers.<fn>`
 * so `shared.participants_settings` and `shared.review_share_audience` resolve at runtime.
 *
 * Two halves, as for every Python asset (lib/utils/python-lambda-asset.ts): the STAGED source
 * (it shapes the hash; copied with CDK's own `FileSystem.copyDirectory` in GIT ignore mode, then
 * walked) and the bundling copy steps (what ships). scripts/audit/py_reachability.py replays the
 * same steps over the tree and fails when a module the trigger imports is missing from the bundle.
 */
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as cdk from 'aws-cdk-lib';
import { afterAll, describe, expect, it } from 'vitest';

import { BOARD_TRIGGER_FILES, boardTriggerCopySteps, onlyTheTriggerFiles } from './core-board-auth';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { byCodeUnit } from '../utils/compare';

const EXPECTED_FILES = [
  'auth/board_triggers.py', 'shared/__init__.py', 'shared/participants_settings.py', 'shared/review_share_audience.py',
];

/** Every FILE under `dir`, relative to it. */
function walkFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkFiles(join(dir, entry.name), relative) : [relative];
  });
}

describe('board trigger asset', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'voc-board-trigger-'));
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  it('names exactly the trigger and the two shared modules it imports', () => {
    expect([...BOARD_TRIGGER_FILES].sort(byCodeUnit)).toStrictEqual(EXPECTED_FILES);
  });

  it('stages only those files (an edit elsewhere under lambda/ never changes the hash)', () => {
    // The very copy CDK's asset staging runs (IgnoreMode.GIT), with the call site's exclude list.
    const staged = join(outdir, 'staged');
    cdk.FileSystem.copyDirectory(join(__dirname, '..', '..', 'lambda'), staged, {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, ...onlyTheTriggerFiles()],
      ignoreMode: cdk.IgnoreMode.GIT,
    });
    expect(walkFiles(staged).sort(byCodeUnit)).toStrictEqual(EXPECTED_FILES);
  });

  it('bundles each file to the same relative path, nothing else', () => {
    expect(boardTriggerCopySteps()).toStrictEqual([
      'mkdir -p /asset-output/auth',
      'mkdir -p /asset-output/shared',
      ...EXPECTED_FILES.map((file) => `cp /asset-input/${file} /asset-output/${file}`),
    ]);
  });
});
