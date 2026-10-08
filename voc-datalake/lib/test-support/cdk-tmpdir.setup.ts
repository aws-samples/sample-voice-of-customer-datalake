/**
 * Every CDK test file synthesizes into its OWN temporary directory, removed when the file ends.
 *
 * `new cdk.App()` without an `outdir` writes its cloud assembly to
 * `mkdtemp(realpath(os.tmpdir())/cdk.out…)` (@aws-cdk/cloud-assembly-api) and never removes it. Each
 * assembly stages `frontend/dist` and the Lambda bundles (about 340 MB), so the suite left one per synth
 * in the system temp dir: 21,579 of them (the disk filled up) after a Stryker sweep, which re-runs the
 * synth tests once per mutant.
 *
 * aws-cdk-lib calls `tmpdir` on the shared `os` module object, so this file points that function at a
 * per-file directory while the file runs. It is done at module scope, not in `beforeAll`: setup files run
 * before the test file is imported, so synths made while the file is collected land there too. The
 * out-of-process `cdk synth` cases manage their own directories (synth-app.ts `createAssemblyDir`).
 *
 * A worker that is killed (a Stryker timeout, Ctrl-C) never reaches `afterAll`; the next file sweeps the
 * directories whose worker process no longer exists.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const systemTmpdir = os.tmpdir;
const BASE = join(systemTmpdir(), 'voc-cdk-tests');

/** True while process `pid` exists (EPERM: it exists but belongs to another user). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Remove `<BASE>/<pid>-XXXXXX` directories left by worker processes that are gone. */
function sweepOrphans(): void {
  for (const name of readdirSync(BASE)) {
    const pid = Number.parseInt(name.split('-')[0] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid)) {
      rmSync(join(BASE, name), { recursive: true, force: true });
    }
  }
}

mkdirSync(BASE, { recursive: true });
sweepOrphans();
const fileTmpDir = mkdtempSync(join(BASE, `${process.pid}-`));
os.tmpdir = () => fileTmpDir;

// Deleting a file's assemblies (hundreds of MB) can outlast vitest's 10 s hook default on a loaded machine.
const CLEANUP_TIMEOUT_MS = 120_000;

afterAll(() => {
  os.tmpdir = systemTmpdir;
  rmSync(fileTmpDir, { recursive: true, force: true });
}, CLEANUP_TIMEOUT_MS);
