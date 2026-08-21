/**
 * Behaviour of `scripts/run-legs.sh`, the runner behind the root `lint`,
 * `typecheck:all` and `check` aggregates.
 *
 * WHY IT LIVES UNDER `lib/`: `vitest.config.ts` includes exactly
 * `lib/**\/*.test.ts`, so this is the only path `npm run test:cdk` collects.
 * The subject is a shell script rather than a construct, hence its own folder.
 *
 * WHY IT EXISTS: the aggregates used to be `&&` chains, which stopped at the
 * first failure and hid every later leg. The two properties that replaced that
 * are invisible to a reader of package.json — every leg runs, and the aggregate
 * still fails — so they are pinned here.
 *
 * REVERT STORY (each assertion names the mutation that breaks it):
 *  - drop the `for` loop's continuation (restore `&&` semantics, i.e. stop at the
 *    first failure) -> "runs every leg even after one fails" fails;
 *  - hardcode `exit 1` instead of tracking the first failing status ->
 *    "exits with the first failing leg's own status" fails;
 *  - `exit 0` unconditionally -> "exits non-zero when any leg fails" fails;
 *  - remove the `VOC_LEGS_NESTED` guard -> "a nested run prints no summary" fails;
 *  - drop the empty-argument guard -> "refuses a run with no legs" fails.
 *
 * The legs are synthetic npm scripts in a throwaway package.json, so the test
 * exercises the runner and never the real suites: a test that shelled out to the
 * actual `check` would take minutes and would fail for reasons that are not the
 * runner's.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT_SOURCE = resolve(__dirname, '../../scripts/run-legs.sh');

/** A sandbox whose package.json defines legs that pass, fail, or fail loudly. */
let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'run-legs-'));
  mkdirSync(join(sandbox, 'voc-datalake', 'scripts'), { recursive: true });
  // Copied to the SAME relative path the real aggregates use, so the invocation
  // under test is byte-identical to the one in package.json.
  copyFileSync(SCRIPT_SOURCE, join(sandbox, 'voc-datalake', 'scripts', 'run-legs.sh'));
  writeFileSync(
    join(sandbox, 'package.json'),
    JSON.stringify({
      name: 'run-legs-sandbox',
      private: true,
      scripts: {
        ok: 'true',
        'ok:two': 'true',
        bad: 'exit 1',
        'bad:ruff': 'exit 2', // a real tool's non-1 status, e.g. ruff
      },
    }),
  );
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function runLegs(...legs: string[]) {
  const result = spawnSync('sh', ['voc-datalake/scripts/run-legs.sh', ...legs], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, VOC_LEGS_NESTED: '' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('run-legs.sh', () => {
  it('exits zero and names every leg when all of them pass', () => {
    const { status, stdout } = runLegs('ok', 'ok:two');

    expect(status).toBe(0);
    expect(stdout).toContain('ok: PASS');
    expect(stdout).toContain('ok:two: PASS');
    expect(stdout).toContain('All legs passed');
  });

  it('runs every leg even after one fails', () => {
    // THE defect this change exists to remove: under `&&` the second leg never
    // ran. Asserted on the later leg's own output, so a runner that stopped at
    // the failure cannot pass.
    const { stdout } = runLegs('bad', 'ok');

    expect(stdout).toContain('bad: FAIL');
    expect(stdout).toContain('ok: PASS');
  });

  it('exits non-zero when any leg fails, even if later legs pass', () => {
    const { status } = runLegs('bad', 'ok');

    expect(status).not.toBe(0);
  });

  it("exits with the first failing leg's own status, not a flattened 1", () => {
    // `&&` propagated the status of the leg that stopped the chain, so a caller
    // distinguishing ruff's 2 from a 1 keeps reading the same number. The second
    // failing leg must not overwrite it.
    const { status } = runLegs('bad:ruff', 'bad');

    expect(status).toBe(2);
  });

  it('reports the failing legs together on stderr', () => {
    const { stderr } = runLegs('bad', 'ok', 'bad:ruff');

    expect(stderr).toContain('Failed legs:');
    expect(stderr).toContain('bad');
    expect(stderr).toContain('bad:ruff');
    // Anti-vacuity: a passing leg is not listed as failed.
    expect(stderr).not.toContain(' ok\n');
  });

  it('prints no summary when nested, so the outer run owns it', () => {
    // `check` runs `lint` and `typecheck:all`, which are themselves leg runs;
    // without this, three summaries compete to be authoritative.
    const nested = spawnSync('sh', ['voc-datalake/scripts/run-legs.sh', 'ok'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, VOC_LEGS_NESTED: '1' },
    });

    expect(nested.status).toBe(0);
    expect(nested.stdout).toContain('ok: PASS');
    expect(nested.stdout).not.toContain('All legs passed');
    // Positive control: the same run WITHOUT the flag does print it, so this is
    // not passing because the string never appears.
    expect(runLegs('ok').stdout).toContain('All legs passed');
  });

  it('refuses a run with no legs instead of reporting success', () => {
    const { status, stderr } = runLegs();

    expect(status).toBe(2);
    expect(stderr).toContain('no legs given');
  });
});
