// Scheduling of scripts/validate.sh (5.55.01): --pytest-first runs the pytest step to the end before any other
// lane starts, and a pytest failure there stops the run unless --keep-going. Uses --dry-run, so every step's
// command is a no-op (VALIDATE_DRY_RUN_FAIL names the one that fails): this tests the runner, not the gates.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = new URL('./validate.sh', import.meta.url).pathname;
const logRoot = mkdtempSync(join(tmpdir(), 'validate-test-'));
after(() => rmSync(logRoot, { recursive: true, force: true }));

let runs = 0;
/** Progress lines and exit status of a dry run with `args`; `fail` names the step that exits 1. */
function dryRun(args, fail = '') {
  runs += 1;
  const env = { ...process.env, VALIDATE_LOG_DIR: join(logRoot, String(runs)), VALIDATE_DRY_RUN_FAIL: fail };
  const result = spawnSync('/bin/bash', [SCRIPT, '--dry-run', ...args], { encoding: 'utf8', env });
  return { status: result.status, lines: `${result.stdout}${result.stderr}`.split('\n') };
}

/** Index of the first progress line `<event> <step>` (any lane), -1 when absent. */
const indexOf = (lines, event, step) => lines.findIndex((l) => new RegExp(`\\] ${event} +${step}( \\(|$)`).test(l));
/** Index of the first `start` of any step other than pytest. */
const firstOtherStart = (lines) => lines.findIndex((l) => /\] start +/.test(l) && !/\] start +pytest$/.test(l));
/** The final report's status for `step`. */
const reported = (lines, step) => lines.find((l) => new RegExp(`^\\S+ +\\S+ +\\S+ +${step}$`).test(l))?.split(/ +/)[0];

describe('validate.sh --pytest-first', () => {
  it('finishes pytest before any other step starts, and runs every step', () => {
    const { status, lines } = dryRun(['--pytest-first']);
    assert.equal(status, 0, lines.join('\n'));
    const pytestOk = indexOf(lines, 'ok', 'pytest');
    assert.ok(pytestOk >= 0, 'pytest ran');
    assert.ok(pytestOk < firstOtherStart(lines), 'no other step started before pytest finished');
    assert.match(lines.join('\n'), /validate: every gate passed/);
  });

  it('starts no other lane when pytest fails, and reports them not-run', () => {
    const { status, lines } = dryRun(['--pytest-first'], 'pytest');
    assert.equal(status, 1);
    assert.equal(firstOtherStart(lines), -1);
    assert.equal(reported(lines, 'pytest'), 'FAIL');
    assert.equal(reported(lines, 'ruff'), 'not-run');
  });

  it('still runs the other lanes after a pytest failure with --keep-going', () => {
    const { status, lines } = dryRun(['--pytest-first', '--keep-going'], 'pytest');
    assert.equal(status, 1);
    assert.equal(reported(lines, 'pytest'), 'FAIL');
    assert.equal(reported(lines, 'ruff'), 'ok');
  });

  it('runs a selection that is only pytest', () => {
    const { status, lines } = dryRun(['--pytest-first', '--only', 'python-tests']);
    assert.equal(status, 0, lines.join('\n'));
    assert.equal(reported(lines, 'pytest'), 'ok');
  });

  it('is a no-op when the selection has no pytest step', () => {
    const { status, lines } = dryRun(['--pytest-first', '--only', 'repo']);
    assert.equal(status, 0, lines.join('\n'));
    assert.equal(indexOf(lines, 'start', 'pytest'), -1);
    assert.doesNotMatch(lines[0] ?? '', /after pytest alone/);
  });
});

describe('validate.sh without --pytest-first', () => {
  it('runs pytest in the py lane beside the others', () => {
    const { status, lines } = dryRun([]);
    assert.equal(status, 0, lines.join('\n'));
    assert.ok(lines.some((l) => /\[py +\] ok +pytest/.test(l)));
  });
});
