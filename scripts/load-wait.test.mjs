// scripts/lib/load-wait.sh (7.105.00): validate.sh's CodeQL step waits while the 5-minute load average is at or over
// its limit (VOC_CODEQL_MAX_LOAD, else 0.85 x the CPUs it may use), at most VOC_CODEQL_MAX_WAIT minutes. Runs the
// real script on a fake /proc/loadavg (VALIDATE_LOADAVG_FILE) and a fake CPU count (VALIDATE_CPUS).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRIPT = new URL('./lib/load-wait.sh', import.meta.url).pathname;
let dir;
let loadavg;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'load-wait-'));
  loadavg = join(dir, 'loadavg');
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** Writes the fake load file atomically, so the script never reads it half-written. */
function setLoad(one, five, fifteen) {
  writeFileSync(`${loadavg}.new`, `${one} ${five} ${fifteen} 3/1000 42\n`);
  renameSync(`${loadavg}.new`, loadavg);
}

/** The script's env: the fake file and CPU count, no CI, a short interval; then `extra`. */
function envWith(extra = {}) {
  const env = { ...process.env, VALIDATE_LOADAVG_FILE: loadavg, VALIDATE_LOAD_WAIT_SECONDS: '0.05', VALIDATE_CPUS: '100' };
  delete env.GITHUB_ACTIONS;
  return { ...env, ...extra };
}

function runNow(args, extra) {
  const result = spawnSync('/bin/bash', [SCRIPT, 'codeql', ...args], { encoding: 'utf8', env: envWith(extra), timeout: 10000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('load-wait.sh', () => {
  it('starts at once, saying nothing, when the 5-minute load is under the limit', () => {
    setLoad('250.00', '159.99', '300.00');
    assert.deepEqual(runNow(['160', '60']), { status: 0, out: '' });
  });

  it('reads the second field: a high 1- and 15-minute load does not hold it', () => {
    setLoad('400.00', '10.00', '400.00');
    assert.deepEqual(runNow(['160', '60']), { status: 0, out: '' });
  });

  it('takes 0.85 x the CPUs as its limit when none is given', () => {
    setLoad('1.00', '84.99', '1.00');
    assert.deepEqual(runNow(['', '60']), { status: 0, out: '' });
    setLoad('1.00', '85.00', '1.00');
    const { status, out } = runNow(['', '0.001']);
    assert.equal(status, 0);
    assert.match(out.split('\n')[0], /^load-wait: codeql waits: the 5-minute load average is 85\.00, at or over 85\.00 \(0\.85 x 100 CPUs\); checking every 0\.05s, at most 0\.001 min$/);
  });

  it('starts anyway, with a warning, once it has waited its longest', () => {
    setLoad('1.00', '222.00', '1.00');
    const { status, out } = runNow(['160', '0.001']);
    assert.equal(status, 0);
    assert.deepEqual(out.trimEnd().split('\n'), [
      'load-wait: codeql waits: the 5-minute load average is 222.00, at or over 160; checking every 0.05s, at most 0.001 min',
      'load-wait: WARNING: codeql starts anyway after 0.001 min: the 5-minute load average is still 222.00 (limit 160)',
    ]);
  });

  it('runs the command after -- once it may start, with its exit code, also after the longest wait', () => {
    setLoad('1.00', '10.00', '1.00');
    assert.deepEqual(runNow(['160', '60', '--', 'bash', '-c', 'echo ran; exit 5']), { status: 5, out: 'ran\n' });
    setLoad('1.00', '222.00', '1.00');
    const { status, out } = runNow(['160', '0.001', '--', 'bash', '-c', 'echo ran']);
    assert.equal(status, 0);
    assert.match(out, /starts anyway after 0\.001 min[^\n]*\nran\n$/);
    assert.equal(runNow(['160', '60', 'bash']).status, 2);
  });

  it('does not wait without a load file (macOS), in CI, or when the file holds no number', () => {
    setLoad('222.00', '222.00', '222.00');
    assert.deepEqual(runNow(['160', '60'], { GITHUB_ACTIONS: 'true' }), { status: 0, out: '' });
    assert.deepEqual(runNow(['160', '60'], { VALIDATE_LOADAVG_FILE: join(dir, 'none') }), { status: 0, out: '' });
    writeFileSync(loadavg, 'garbage\n');
    assert.deepEqual(runNow(['160', '60']), { status: 0, out: '' });
  });

  for (const [args, extra, message] of [
    [['lots', '60'], {}, /the load limit must be a number \(got lots\)/],
    [['160', 'x'], {}, /the longest wait must be a number of minutes \(got x\)/],
    [['160', '60'], { VALIDATE_LOAD_WAIT_SECONDS: '0' }, /the interval must be a number of seconds over 0 \(got 0\)/],
    [['160', '60'], { VALIDATE_LOAD_WAIT_SECONDS: '-1' }, /the interval must be a number of seconds over 0 \(got -1\)/],
    [['', '60'], { VALIDATE_CPUS: 'many' }, /the CPU count must be a whole number \(got many\)/],
  ]) {
    it(`refuses ${JSON.stringify([...args, extra])}`, () => {
      const { status, out } = runNow(args, extra);
      assert.equal(status, 2);
      assert.match(out, message);
    });
  }

  it('waits at the limit, says why once, and starts when the load falls under it', { timeout: 20000 }, async () => {
    setLoad('230.00', '160.00', '225.00');
    const child = spawn('/bin/bash', [SCRIPT, 'codeql', '160', '60'], { env: envWith() });
    let out = '';
    const waiting = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve();
      });
    });
    const exited = new Promise((resolve) => child.on('close', resolve));
    await waiting;
    assert.equal(child.exitCode, null);
    setLoad('120.00', '150.00', '130.00');
    assert.equal(await exited, 0);
    assert.deepEqual(out.trimEnd().split('\n'), [
      'load-wait: codeql waits: the 5-minute load average is 160.00, at or over 160; checking every 0.05s, at most 60 min',
    ]);
  });
});
