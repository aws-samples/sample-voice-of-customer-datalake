// Scheduling of scripts/validate.sh (5.55.01): --pytest-first runs the pytest step to the end before any other
// lane starts, and a pytest failure there stops the run unless --keep-going. Uses --dry-run, so every step's
// command is a no-op (VALIDATE_DRY_RUN_FAIL names the one that fails): this tests the runner, not the gates.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = new URL('./validate.sh', import.meta.url).pathname;
const logRoot = mkdtempSync(join(tmpdir(), 'validate-test-'));
after(() => rmSync(logRoot, { recursive: true, force: true }));

// The lanes unless a test asks for the pool: a machine whose profile sets VOC_VALIDATE_JOBS runs this file too.
// The values a pool exports to its steps are cleared too: this file runs as one of them on such a machine.
const LANES = {
  VOC_VALIDATE_JOBS: '', VOC_VALIDATE_RAM: 'off', CODEQL_PARALLEL: '', CODEQL_THREADS: '', VALIDATE_PYTEST_WORKERS: '',
  VALIDATE_CDK_VITEST_WORKERS: '', VALIDATE_AUDIT_TEST_WORKERS: '',
};
let runs = 0;
/** Progress lines and exit status of a dry run with `args`; `fail` names the step that exits 1. */
function dryRun(args, fail = '', extraEnv = {}) {
  runs += 1;
  const env = { ...process.env, ...LANES, VALIDATE_LOG_DIR: join(logRoot, String(runs)), VALIDATE_DRY_RUN_FAIL: fail, ...extraEnv };
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

/** The steps a dry run started, by name. */
const startedSteps = (lines) => lines.flatMap((l) => /\] start +(.+)$/.exec(l)?.[1] ?? []);

describe('validate.sh --lane (CI runs one lane per job)', () => {
  it('runs only the steps defined in the named lane', () => {
    const { status, lines } = dryRun(['--lane', 'web']);
    assert.equal(status, 0, lines.join('\n'));
    assert.deepEqual(startedSteps(lines), ['vitest: frontend']);
  });

  it('takes several lanes, and every step belongs to exactly one lane', () => {
    const all = startedSteps(dryRun([]).lines).sort();
    const byLane = ['py', 'tsc', 'lint', 'test', 'web', 'sec'].flatMap((lane) => startedSteps(dryRun(['--lane', lane]).lines));
    assert.deepEqual(byLane.sort(), all);
    assert.deepEqual(startedSteps(dryRun(['--lane', 'py,web']).lines).sort(),
      [...startedSteps(dryRun(['--lane', 'py']).lines), 'vitest: frontend'].sort());
  });

  it('keeps pytest in the py lane under --pytest-first and --serial', () => {
    for (const extra of [['--pytest-first'], ['--serial']]) {
      const { status, lines } = dryRun([...extra, '--lane', 'py']);
      assert.equal(status, 0, lines.join('\n'));
      assert.ok(startedSteps(lines).includes('pytest'), `${extra.join(' ')}: ${lines.join('\n')}`);
    }
  });

  it('combines with --only: a step must be in the lane AND one of the groups', () => {
    const { status, lines } = dryRun(['--lane', 'lint', '--only', 'frontend']);
    assert.equal(status, 0, lines.join('\n'));
    assert.deepEqual(startedSteps(lines), ['eslint: frontend']);
  });

  it('refuses an unknown lane', () => {
    const { status, lines } = dryRun(['--lane', 'nope']);
    assert.equal(status, 2);
    assert.ok(lines.some((l) => l.includes('unknown lane nope')));
  });
});

describe('validate.sh coverage baseline mode (local prunes graduated rows, CI stays strict)', () => {
  /** The first line (the banner) of a dry run of the web lane with `env` replacing process.env. */
  const banner = (env) => {
    runs += 1;
    const result = spawnSync('/bin/bash', [SCRIPT, '--dry-run', '--lane', 'web'], {
      encoding: 'utf8', env: { ...env, ...LANES, VALIDATE_LOG_DIR: join(logRoot, `banner-${runs}`) },
    });
    return result.stdout.split('\n')[0];
  };

  it('is strict on GitHub Actions', () => {
    assert.match(banner({ ...process.env, GITHUB_ACTIONS: 'true' }), /coverage baseline strict \(CI\)/);
  });

  it('prunes graduated rows on a local run', () => {
    const { GITHUB_ACTIONS: _ci, ...local } = process.env;
    assert.match(banner(local), /graduated rows pruned \(local\)/);
  });
});

describe('validate.sh --failed (re-run only what did not pass last time)', () => {
  const failedRoot = join(logRoot, 'failed');
  /** A dry run whose logs go under failedRoot, the root --failed reads the last run from. */
  const runIn = (args, fail = '') => dryRun(args, fail, {
    VALIDATE_LOG_ROOT: failedRoot, VALIDATE_LOG_DIR: join(failedRoot, String(runs + 1).padStart(3, '0')),
  });

  it('needs an earlier run', () => {
    const { status, lines } = runIn(['--failed']);
    assert.equal(status, 2);
    assert.ok(lines.some((l) => l.includes('--failed needs an earlier run')));
  });

  it('re-runs the failed step and the rest of its lane, not the steps that passed, until nothing is left', () => {
    const first = runIn(['--lane', 'py,web', '--keep-going'], 'ruff');
    assert.equal(first.status, 1);
    const pyLane = spawnSync('/bin/bash', [SCRIPT, '--list', '--lane', 'py'], { encoding: 'utf8' }).stdout
      .split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/).slice(2).join(' ')); // lane, groups, name
    const again = runIn(['--failed']);
    assert.equal(again.status, 0, again.lines.join('\n'));
    assert.ok(again.lines.some((l) => l.includes(`re-running the ${pyLane.length} step(s)`)), again.lines.join('\n'));
    assert.deepEqual(startedSteps(again.lines).sort(), [...pyLane].sort());
    assert.ok(!startedSteps(again.lines).includes('vitest: frontend'), 'a step that passed is not re-run');
    const done = runIn(['--failed']);
    assert.equal(done.status, 0);
    assert.ok(done.lines.some((l) => l.includes('nothing to re-run')));
  });

  it('ignores dry runs when the run itself is real', () => {
    const own = join(logRoot, 'dry-only');
    runs += 1;
    spawnSync('/bin/bash', [SCRIPT, '--dry-run', '--lane', 'web'], { encoding: 'utf8', env: { ...process.env, ...LANES, VALIDATE_LOG_ROOT: own, VALIDATE_LOG_DIR: join(own, 'a'), VALIDATE_DRY_RUN_FAIL: 'vitest: frontend' } });
    const env = { ...process.env, ...LANES, VALIDATE_LOG_ROOT: own };
    const result = spawnSync('/bin/bash', [SCRIPT, '--failed', '--list'], { encoding: 'utf8', env });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--failed needs an earlier run/);
  });
});

describe('validate.sh pool (VOC_VALIDATE_JOBS: every step its own job)', () => {
  const SYNTH = 'audit: py_reachability + py_env_contract + py_iam_contract + py_layers + py_sfn_errors + py_shared_constants + py_doc_refs + clones_struct.py --kind function';
  /** A pool dry run; `events` holds each step's start (s) and end (e), in order, when `record` is set. */
  function poolRun(args, { jobs = '8', fail = '', record = false, env = {} } = {}) {
    const events = join(logRoot, `events-${runs + 1}.tsv`);
    const cmd = record
      ? 'printf "s\\t%s\\n" "$VALIDATE_STEP" >> "$EVENTS"; sleep 0.1; printf "e\\t%s\\n" "$VALIDATE_STEP" >> "$EVENTS"'
      : '';
    const result = dryRun(args, fail, { VOC_VALIDATE_JOBS: jobs, EVENTS: events, VALIDATE_DRY_RUN_CMD: cmd, ...env });
    const log = record && existsSync(events)
      ? readFileSync(events, 'utf8').trim().split('\n').map((l) => l.split('\t'))
      : [];
    return { ...result, events: log };
  }
  const at = (events, kind, step) => events.findIndex(([k, s]) => k === kind && s === step);

  it('runs every step the lanes run, once, and passes', () => {
    const lanes = startedSteps(dryRun([]).lines).sort();
    const { status, lines } = poolRun([]);
    assert.equal(status, 0, lines.join('\n'));
    assert.match(lines[0], /^validate: pool of 8 jobs, /);
    assert.deepEqual(startedSteps(lines).sort(), lanes);
    assert.match(lines.join('\n'), /validate: every gate passed/);
  });

  it('runs at most N steps at once, and more than one', () => {
    const { status, lines, events } = poolRun([], { jobs: '4', record: true });
    assert.equal(status, 0, lines.join('\n'));
    let now = 0;
    let most = 0;
    for (const [kind] of events) {
      now += kind === 's' ? 1 : -1;
      most = Math.max(most, now);
    }
    assert.ok(most <= 4, `at most 4 at once, saw ${most}`);
    assert.ok(most >= 2, `the steps ran side by side, saw ${most}`);
  });

  it('keeps the lanes\' orders: the vite build, the synth, the detector tests; the CDK suite after the build', () => {
    const { status, lines, events } = poolRun([], { jobs: '64', record: true });
    assert.equal(status, 0, lines.join('\n'));
    assert.ok(at(events, 'e', 'vite build: frontend') < at(events, 's', SYNTH));
    assert.ok(at(events, 'e', SYNTH) < at(events, 's', 'audit: detector tests'));
    assert.ok(at(events, 'e', 'vite build: frontend') < at(events, 's', 'vitest: CDK app'));
    assert.ok(at(events, 's', 'vitest: CDK app') < at(events, 'e', SYNTH), 'the CDK suite does not wait for the synth');
  });

  it('fails fast: the failing step is named, the steps that need it never start', () => {
    const { status, lines } = poolRun([], { fail: 'vite build: frontend' });
    assert.equal(status, 1);
    assert.equal(reported(lines, 'vite build: frontend'), 'FAIL');
    for (const step of ['audit: detector tests', 'vitest: CDK app']) assert.equal(reported(lines, step), 'not-run', step);
    assert.match(lines.join('\n'), /vite build: frontend failed; stopping the other jobs/);
    assert.match(lines.join('\n'), /validate: FAILED/);
  });

  it('stops the jobs still running when one fails: they are "stopped", the failing one FAIL with its log', () => {
    // No earlier run under this log root: definition order, so ruff (the first step) starts at once.
    const cmd = '[ "$VALIDATE_STEP" = ruff ] && exit 1; sleep 5';
    const env = { VOC_VALIDATE_JOBS: '8', VALIDATE_DRY_RUN_CMD: cmd, VALIDATE_LOG_ROOT: join(logRoot, 'stop-a') };
    const { status, lines } = dryRun([], '', env);
    assert.equal(status, 1);
    assert.equal(reported(lines, 'ruff'), 'FAIL');
    const stopped = lines.filter((l) => /^stopped /.test(l));
    assert.ok(stopped.length >= 1, lines.join('\n'));
    assert.ok(lines.some((l) => /^not-run /.test(l)), 'the steps not started yet are not-run');
    assert.match(lines.join('\n'), /FAILED: ruff \(exit 1\)/);
    assert.doesNotMatch(lines.join('\n'), /FAILED: (?!ruff)/, 'only the failing step\'s log is printed');
  });

  it('reports the step that stopped the run FAIL even when it died from a signal', () => {
    const cmd = '[ "$VALIDATE_STEP" = ruff ] && kill -TERM $$; sleep 5';
    const env = { VOC_VALIDATE_JOBS: '8', VALIDATE_DRY_RUN_CMD: cmd, VALIDATE_LOG_ROOT: join(logRoot, 'stop-b') };
    const { status, lines } = dryRun([], '', env);
    assert.equal(status, 1);
    assert.equal(reported(lines, 'ruff'), 'FAIL');
    assert.match(lines.join('\n'), /FAILED: ruff \(exit 143\)/);
  });

  it('with --keep-going runs every step whose needs passed, and not the ones whose need failed', () => {
    const { status, lines } = poolRun(['--keep-going'], { fail: 'vite build: frontend' });
    assert.equal(status, 1);
    assert.equal(reported(lines, 'vitest: CDK app'), 'not-run');
    assert.equal(reported(lines, 'audit: detector tests'), 'not-run');
    assert.equal(reported(lines, 'vitest: frontend'), 'ok');
    assert.equal(reported(lines, 'ruff'), 'ok');
  });

  it('starts the longest chain first, by each step\'s newest passed duration', () => {
    const root = join(logRoot, 'order');
    mkdirSync(join(root, 'earlier'), { recursive: true });
    writeFileSync(join(root, 'earlier', 'timings.tsv'),
      'ok\t500\tpy\tpytest\nok\t600\ttest\taudit: detector tests\nok\t2\ttest\tvite build: frontend\n');
    // A newer, narrower run (--only tenets) and a newer one where pytest failed early: neither hides the full run.
    mkdirSync(join(root, 'narrow'));
    writeFileSync(join(root, 'narrow', 'timings.tsv'), 'ok\t20\ttsc\ttenets: AI review\nFAIL\t3\tpy\tpytest\n');
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(join(root, 'earlier', 'timings.tsv'), hourAgo, hourAgo);
    const { status, lines } = poolRun([], { jobs: '2', env: { VALIDATE_LOG_ROOT: root } });
    assert.equal(status, 0, lines.join('\n'));
    // The vite build takes 2 s but 600 s of detector tests wait on it, pytest 500 s: with two jobs those two start
    // first (their own start lines may print in either order), every other step only once one of them ended.
    assert.deepEqual(startedSteps(lines).slice(0, 2).sort(), ['pytest', 'vite build: frontend']);
  });

  it('under --pytest-first runs pytest alone, then the pool', () => {
    const { status, lines } = poolRun(['--pytest-first']);
    assert.equal(status, 0, lines.join('\n'));
    assert.ok(indexOf(lines, 'ok', 'pytest') < firstOtherStart(lines));
    assert.match(lines[0], /pool of 8 jobs after pytest alone/);
  });

  it('is off under --serial and for 1 job, and refuses a value that is not a number', () => {
    assert.match(poolRun(['--serial']).lines[0], /^validate: 1 lane\(s\) \[serial\]/);
    assert.match(poolRun([], { jobs: '1' }).lines[0], /^validate: 6 lane\(s\)/);
    const bad = poolRun([], { jobs: 'many' });
    assert.equal(bad.status, 2);
    assert.ok(bad.lines.some((l) => l.includes('VOC_VALIDATE_JOBS must be a number')));
  });

  /** The environment the pytest step gets in a dry run with `env`. */
  function stepEnv(env, args = []) {
    const out = join(logRoot, `env-${runs + 1}.txt`);
    const cmd = '[ "$VALIDATE_STEP" != pytest ] || env > "$OUT"';
    const { status, lines } = dryRun(['--only', 'python-tests', ...args], '', { VALIDATE_DRY_RUN_CMD: cmd, OUT: out, ...env });
    assert.equal(status, 0, lines.join('\n'));
    return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
  }
  const cpus = Number(spawnSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).stdout.trim()) || 4;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(v)));

  it('gives the steps exactly the old environment without the pool', () => {
    const env = stepEnv({});
    for (const name of ['CODEQL_PARALLEL', 'CODEQL_THREADS', 'VALIDATE_POOL', 'VALIDATE_CDK_VITEST_WORKERS', 'VALIDATE_AUDIT_TEST_WORKERS']) {
      assert.equal(env[name] ?? '', '', name);
    }
    assert.equal(env.VALIDATE_PYTEST_WORKERS, String(cpus > 6 ? cpus - 4 : 2));
  });

  it('sizes the pool\'s suites from the cores, and keeps what was set by hand', () => {
    const sized = stepEnv({ VOC_VALIDATE_JOBS: '8' });
    assert.equal(sized.VALIDATE_POOL, '1');
    assert.equal(sized.CODEQL_PARALLEL, '1');
    assert.equal(sized.CODEQL_THREADS, String(clamp(cpus / 4, 1, 4096)));
    assert.equal(sized.VALIDATE_PYTEST_WORKERS, String(clamp(cpus / 2, 2, 4096)));
    assert.equal(sized.VALIDATE_CDK_VITEST_WORKERS, String(clamp(cpus / 6, 4, 32)));
    assert.equal(sized.VALIDATE_AUDIT_TEST_WORKERS, String(clamp(cpus / 12, 2, 16)));
    const given = stepEnv({ VOC_VALIDATE_JOBS: '8', VALIDATE_PYTEST_WORKERS: '7', CODEQL_THREADS: '3', VALIDATE_CDK_VITEST_WORKERS: '5' });
    assert.deepEqual([given.VALIDATE_PYTEST_WORKERS, given.CODEQL_THREADS, given.VALIDATE_CDK_VITEST_WORKERS], ['7', '3', '5']);
    // --pytest-first: pytest runs alone before the pool, on the lanes' count.
    assert.equal(stepEnv({ VOC_VALIDATE_JOBS: '8' }, ['--pytest-first']).VALIDATE_PYTEST_WORKERS, String(cpus > 6 ? cpus - 4 : 2));
  });

  it('names RAM in its banner, and a dry run never touches it', () => {
    const ram = join(logRoot, 'ram-untouched');
    const { status, lines } = poolRun(['--lane', 'web'], { env: { VOC_VALIDATE_RAM: ram } });
    assert.equal(status, 0, lines.join('\n'));
    assert.match(lines[0], /not touched by a dry run/);
    assert.ok(!existsSync(ram));
  });
});
