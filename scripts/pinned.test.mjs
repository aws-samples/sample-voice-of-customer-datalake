// scripts/pinned.sh: a hand-run command pinned to NUMA node 0 as validate.sh pins itself (scripts/lib/pin.sh), its
// pytest / eslint worker counts capped, and a bare python / pytest run on the tree's venv, else the main checkout's,
// else python3. NUMA is faked (VALIDATE_NUMA_ROOT, VALIDATE_NPROC_ALL) and taskset, git and the commands are stubs on
// PATH that print what they were given, so nothing heavy runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPTS = dirname(new URL(import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), 'pinned-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
let made = 0;
const fresh = (name) => { made += 1; const d = join(work, `${name}-${made}`); mkdirSync(d, { recursive: true }); return d; };

/** An executable shell script at `path`. */
function script(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
// A command stub: prints its name, its PATH's first entry and each argument on a line, then exits $SHOW_EXIT.
const SHOW = (name) => `echo "RUN ${name}"; echo "PATH1 \${PATH%%:*}"; for a in "$@"; do echo "ARG $a"; done; `
  + 'echo "ENV xdist=$PYTEST_XDIST_AUTO_NUM_WORKERS eslint=$VALIDATE_ESLINT_CONCURRENCY codeql=$CODEQL_THREADS '
  + 'pinned=$VALIDATE_PINNED"; exit "${SHOW_EXIT:-0}"';

/** Copies scripts/pinned.sh, scripts/lib/pin.sh and validate.sh into `root`'s scripts/. */
function install(root) {
  for (const f of ['pinned.sh', 'validate.sh', 'lib/pin.sh']) {
    mkdirSync(dirname(join(root, 'scripts', f)), { recursive: true });
    copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  }
  return root;
}
/** A tree holding the scripts, with its own venv or not. */
function tree({ venv = false } = {}) {
  const root = install(fresh('tree'));
  if (venv) script(join(root, 'voc-datalake/.venv/bin/python'), SHOW('tree-venv'));
  return root;
}

// Stubs on PATH: taskset logs its arguments to $TASKSET_LOG and runs the command after `-c <list>` (or refuses with
// TASKSET_REFUSE=1); the commands print what they got; git (after its own -C <dir>) answers rev-parse --git-common-dir
// with $FAKE_GIT_COMMON and --show-toplevel with $FAKE_GIT_TOPLEVEL, else the folder it was run in (none when
// FAKE_GIT_COMMON is empty: not a repository).
const stubs = fresh('bin');
script(join(stubs, 'taskset'), '[ -n "$TASKSET_REFUSE" ] && exit 1; echo "$*" >> "$TASKSET_LOG"; shift 2; exec "$@"');
for (const name of ['eslint', 'npx', 'show', 'python3']) script(join(stubs, name), SHOW(name));
const gitStubs = fresh('gitbin');
script(join(gitStubs, 'git'), '[ "$1" = -C ] && { cd "$2" || exit 128; shift 2; }; [ -n "$FAKE_GIT_COMMON" ] || exit 128; '
  + 'case "$*" in *--show-toplevel*) echo "${FAKE_GIT_TOPLEVEL:-$(pwd -P)}" ;; *) echo "$FAKE_GIT_COMMON" ;; esac');

/** A PATH of `dirs` plus links to only the system tools pinned.sh needs: no taskset, no git. */
function bareSystem() {
  const dir = fresh('sys');
  for (const tool of ['bash', 'sh', 'env', 'nproc', 'tr', 'dirname', 'basename']) {
    const at = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (at) symlinkSync(at, join(dir, tool));
  }
  return dir;
}
const BARE = bareSystem();

// This process's CPU count: "not pinned yet" means the machine's count (VALIDATE_NPROC_ALL) is the same.
const cpus = spawnSync('/bin/sh', ['-c', 'env -u OMP_NUM_THREADS -u OMP_THREAD_LIMIT nproc'], { encoding: 'utf8' }).stdout.trim();
/** A fake /sys/devices/system/node with `nodes` nodes, node 0 on CPUs 0-95. */
function numaRoot(nodes) {
  const root = fresh('numa');
  for (let n = 0; n < nodes; n += 1) mkdirSync(join(root, `node${n}`));
  writeFileSync(join(root, 'node0', 'cpulist'), '0-95\n');
  return root;
}

/** Runs `bash <root>/scripts/pinned.sh ...args` with the stubs; its output lines, stderr, status and taskset's log. */
function pinned(args, { root = tree(), nodes = 2, env = {}, path = `${stubs}:${gitStubs}:${process.env.PATH}` } = {}) {
  const log = join(fresh('log'), 'taskset.log');
  writeFileSync(log, '');
  const result = spawnSync('/bin/bash', [join(root, 'scripts/pinned.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: path, TASKSET_LOG: log, VALIDATE_NUMA_ROOT: numaRoot(nodes), VALIDATE_NPROC_ALL: cpus,
      VALIDATE_PINNED: '', GITHUB_ACTIONS: '', PYTHON_BIN: '', OMP_NUM_THREADS: '', OMP_THREAD_LIMIT: '',
      PYTEST_XDIST_AUTO_NUM_WORKERS: '', VALIDATE_ESLINT_CONCURRENCY: '', CODEQL_THREADS: '', TASKSET_REFUSE: '',
      FAKE_GIT_COMMON: '', FAKE_GIT_TOPLEVEL: '', ...env,
    },
  });
  const tasksetCalls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, out: result.stdout.split('\n').filter(Boolean), err: result.stderr, tasksetCalls };
}
const argsOf = (out) => out.filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4));

describe('pinned.sh: the pin', () => {
  it('runs the command under taskset -c <node 0> on a machine of two nodes', () => {
    const r = pinned(['show', 'a']);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.tasksetCalls, ['-c 0-95 true', '-c 0-95 show a']);
    assert.ok(r.out.includes('ENV xdist=32 eslint=8 codeql=16 pinned=1'), r.out.join('\n'));
  });

  it("keeps a caller's own worker counts at or below the caps, and replaces the rest by the cap", () => {
    const caps = (v) => ({ PYTEST_XDIST_AUTO_NUM_WORKERS: v[0], VALIDATE_ESLINT_CONCURRENCY: v[1], CODEQL_THREADS: v[2] });
    const own = pinned(['show', 'a'], { env: caps(['4', '2', '4']) });
    assert.equal(own.status, 0, own.err);
    assert.ok(own.out.includes('ENV xdist=4 eslint=2 codeql=4 pinned=1'), own.out.join('\n'));
    assert.equal(own.err, '');
    const atCap = pinned(['show', 'a'], { env: caps(['32', '8', '16']) });
    assert.ok(atCap.out.includes('ENV xdist=32 eslint=8 codeql=16 pinned=1'), atCap.out.join('\n'));
    assert.equal(atCap.err, '');
    const high = pinned(['show', 'a'], { env: caps(['96', '96', '64']) });
    assert.ok(high.out.includes('ENV xdist=32 eslint=8 codeql=16 pinned=1'), high.out.join('\n'));
    assert.match(high.err, /PYTEST_XDIST_AUTO_NUM_WORKERS=96 replaced by 32/);
    assert.match(high.err, /VALIDATE_ESLINT_CONCURRENCY=96 replaced by 8/);
    assert.match(high.err, /CODEQL_THREADS=64 replaced by 16/);
    // Not a whole number from 1 up (CodeQL's 0 is every CPU it may use): the cap.
    for (const v of ['0', 'auto', '-1', '2.5', ' 4']) {
      const r = pinned(['show', 'a'], { env: caps([v, v, v]) });
      assert.ok(r.out.includes('ENV xdist=32 eslint=8 codeql=16 pinned=1'), `${v}: ${r.out.join('\n')}`);
    }
  });

  it('runs it as it is on one node, when already pinned, in CI, without taskset, or when taskset refuses', () => {
    const cases = {
      'one node': pinned(['show', 'a'], { nodes: 1 }),
      'VALIDATE_PINNED': pinned(['show', 'a'], { env: { VALIDATE_PINNED: '1' } }),
      "a caller's taskset": pinned(['show', 'a'], { env: { VALIDATE_NPROC_ALL: String(Number(cpus) + 96) } }),
      CI: pinned(['show', 'a'], { env: { GITHUB_ACTIONS: 'true' } }),
      'no taskset': pinned([join(stubs, 'show'), 'a'], { path: BARE }),
      'taskset refuses': pinned(['show', 'a'], { env: { TASKSET_REFUSE: '1' } }),
    };
    for (const [why, r] of Object.entries(cases)) {
      assert.equal(r.status, 0, `${why}: ${r.err}`);
      assert.ok(!r.tasksetCalls.some((c) => c.includes(' a')), `${why}: ${r.tasksetCalls}`);
      assert.deepEqual(argsOf(r.out), ['a'], why);
      // The caps hold either way.
      assert.ok(r.out.some((l) => /^ENV xdist=32 eslint=8 codeql=16 pinned=1?$/.test(l)), why);
    }
  });

  it('passes the exit code through, pinned or not, and keeps arguments with spaces whole', () => {
    for (const nodes of [1, 2]) {
      const r = pinned(['show', 'one two', '', "it's"], { nodes, env: { SHOW_EXIT: '7' } });
      assert.equal(r.status, 7);
      assert.deepEqual(argsOf(r.out), ['one two', '', "it's"]);
    }
    assert.equal(pinned([]).status, 2);
  });
});

describe('pinned.sh: worker caps', () => {
  const py = (args) => pinned(['python', '-m', 'pytest', ...args], { root: tree({ venv: true }) });

  it('lowers a pytest-xdist count above 32 in each spelling, and says so', () => {
    const r = py(['-q', '-n', '96', 'a.py']);
    assert.deepEqual(argsOf(r.out), ['-m', 'pytest', '-q', '-n', '32', 'a.py']);
    assert.match(r.err, /pytest -n 96 lowered to 32/);
    assert.deepEqual(argsOf(py(['-n96']).out).slice(2), ['-n32']);
    assert.deepEqual(argsOf(py(['--numprocesses', '96']).out).slice(2), ['--numprocesses', '32']);
    assert.deepEqual(argsOf(py(['--numprocesses=96']).out).slice(2), ['--numprocesses=32']);
    assert.deepEqual(argsOf(pinned(['pytest', '-n', '64'], { root: tree({ venv: true }) }).out).slice(2), ['-n', '32']);
  });

  it("tells pytest by the command as given, whatever the chosen interpreter's name", () => {
    const pypy = script(join(fresh('pypy'), 'pypy3'), SHOW('pypy3'));
    const r = pinned(['python', '-m', 'pytest', '-n', '96'], { env: { PYTHON_BIN: pypy } });
    assert.equal(r.out[0], 'RUN pypy3');
    assert.deepEqual(argsOf(r.out), ['-m', 'pytest', '-n', '32']);
    assert.match(r.err, /pytest -n 96 lowered to 32/);
    assert.deepEqual(argsOf(pinned(['pytest', '-n96'], { env: { PYTHON_BIN: pypy } }).out), ['-m', 'pytest', '-n32']);
    // An interpreter's path as the first word.
    assert.deepEqual(argsOf(pinned([pypy, '-m', 'pytest', '--numprocesses=64']).out), ['-m', 'pytest', '--numprocesses=32']);
    assert.deepEqual(argsOf(pinned([pypy, '-c', 'x', '-n', '96']).out), ['-c', 'x', '-n', '96']);
  });

  it('leaves -n auto / logical and counts of 32 or less as given (the env caps auto)', () => {
    for (const args of [['-n', 'auto'], ['-nauto'], ['-n', 'logical'], ['-n', '32'], ['-n8'], ['--numprocesses=4']]) {
      const r = py(args);
      assert.deepEqual(argsOf(r.out).slice(2), args);
      assert.doesNotMatch(r.err, /lowered/);
      assert.ok(r.out.some((l) => l.startsWith('ENV xdist=32 ')));
    }
  });

  it('lowers eslint --concurrency above 8, and auto, to 8', () => {
    assert.deepEqual(argsOf(pinned(['eslint', '.', '--concurrency', '16']).out), ['.', '--concurrency', '8']);
    assert.deepEqual(argsOf(pinned(['eslint', '--concurrency=auto']).out), ['--concurrency=8']);
    assert.deepEqual(argsOf(pinned(['npx', 'eslint', '--concurrency', 'auto']).out), ['eslint', '--concurrency', '8']);
    assert.deepEqual(argsOf(pinned(['npx', '--prefix', '/x', 'eslint', '--concurrency=12']).out),
      ['--prefix', '/x', 'eslint', '--concurrency=8']);
    for (const kept of [['--concurrency', '4'], ['--concurrency=off'], ['--concurrency', '8']]) {
      assert.deepEqual(argsOf(pinned(['eslint', ...kept]).out), kept);
    }
  });

  it("leaves other commands' arguments alone", () => {
    assert.deepEqual(argsOf(pinned(['show', '-n', '96', '--concurrency', '16']).out), ['-n', '96', '--concurrency', '16']);
    // eslint's flag in a pytest run, pytest's in an eslint run.
    assert.deepEqual(argsOf(py(['--concurrency', '16']).out).slice(2), ['--concurrency', '16']);
    assert.deepEqual(argsOf(pinned(['eslint', '-n', '96']).out), ['-n', '96']);
  });
});

describe('the Python lookup (pinned.sh and validate.sh)', () => {
  /** A main checkout at <dir> with a venv whose python is a stub named `label`. */
  function mainCheckout(label = 'main-venv') {
    const main = fresh('main');
    mkdirSync(join(main, '.git'));
    script(join(main, 'voc-datalake/.venv/bin/python'), SHOW(label));
    return main;
  }

  it("uses the tree's own venv first, its folder first on PATH, quietly", () => {
    const root = tree({ venv: true });
    const r = pinned(['python', '-c', 'x'], { root, env: { FAKE_GIT_COMMON: join(mainCheckout(), '.git') } });
    assert.equal(r.out[0], 'RUN tree-venv');
    assert.equal(r.out[1], `PATH1 ${join(root, 'voc-datalake/.venv/bin')}`);
    assert.deepEqual(argsOf(r.out), ['-c', 'x']);
    assert.equal(r.err, '');
  });

  it("uses the main checkout's venv in a worktree without one, and says so", () => {
    const main = mainCheckout();
    const r = pinned(['pytest', '-q', 'a b.py'], { env: { FAKE_GIT_COMMON: join(main, '.git') } });
    assert.equal(r.out[0], 'RUN main-venv');
    assert.deepEqual(argsOf(r.out), ['-m', 'pytest', '-q', 'a b.py']);
    assert.match(r.err, /no voc-datalake\/\.venv in this tree; using the main checkout's /);
    assert.ok(r.err.includes(join(main, 'voc-datalake/.venv/bin/python')));
  });

  it('falls back to python3 when neither has a venv (or the tree is the main checkout), and says so', () => {
    const root = tree();
    for (const common of ['.git', join(fresh('novenv'), '.git'), '']) {
      const r = pinned(['python3', '-V'], { root, env: { FAKE_GIT_COMMON: common } });
      assert.equal(r.out[0], 'RUN python3');
      assert.match(r.err, /no voc-datalake\/\.venv here or in the main checkout; using .*python3/);
    }
  });

  it("puts only an absolute .venv/bin first on PATH: never `.` for a bare name, nor the system python3's folder", () => {
    // gitStubs first, so a folder put before it shows.
    const path = `${gitStubs}:${stubs}:${process.env.PATH}`;
    const bare = pinned(['python', '-V'], { env: { PYTHON_BIN: 'python3' }, path });
    assert.equal(bare.out[0], 'RUN python3', bare.err);
    assert.equal(bare.out[1], `PATH1 ${gitStubs}`);
    const fallback = pinned(['python', '-V'], { path });
    assert.equal(fallback.out[0], 'RUN python3', fallback.err);
    assert.equal(fallback.out[1], `PATH1 ${gitStubs}`);
    const elsewhere = script(join(fresh('py'), 'bin', 'python'), SHOW('elsewhere'));
    assert.equal(pinned(['python', '-V'], { env: { PYTHON_BIN: elsewhere }, path }).out[1], `PATH1 ${gitStubs}`);
    const venv = script(join(fresh('venv'), '.venv', 'bin', 'python'), SHOW('a-venv'));
    assert.equal(pinned(['python', '-V'], { env: { PYTHON_BIN: venv }, path }).out[1], `PATH1 ${dirname(venv)}`);
    const missing = pinned(['python', '-V'], { env: { PYTHON_BIN: 'no-such-python' }, path });
    assert.equal(missing.status, 127);
    assert.match(missing.err, /PYTHON_BIN=no-such-python is not on PATH/);
  });

  it('never takes the venv of a repository the tree merely sits inside', () => {
    const main = mainCheckout();
    const r = pinned(['python3', '-V'], { env: { FAKE_GIT_COMMON: join(main, '.git'), FAKE_GIT_TOPLEVEL: main } });
    assert.equal(r.out[0], 'RUN python3', r.err);
    assert.match(r.err, /no voc-datalake\/\.venv here or in the main checkout; using .*python3/);
  });

  it('keeps PYTHON_BIN when it is set, and leaves a path to an interpreter as given', () => {
    const other = script(join(fresh('py'), 'python'), SHOW('given'));
    assert.equal(pinned(['pytest'], { root: tree({ venv: true }), env: { PYTHON_BIN: other } }).out[0], 'RUN given');
    assert.equal(pinned([other], { root: tree({ venv: true }) }).out[0], 'RUN given');
  });

  it("finds the main checkout of a real git worktree", (t) => {
    const base = fresh('git');
    const main = join(base, 'main');
    const git = (...args) => spawnSync('git', args, {
      encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    const steps = [
      ['init', '-q', main],
      ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null',
        'commit', '-q', '--allow-empty', '-m', 'x'],
      ['-C', main, 'worktree', 'add', '-q', '--detach', join(base, 'wt')],
    ];
    for (const s of steps) {
      const r = git(...s);
      if (r.status !== 0) { t.skip(`git worktree unavailable here: ${r.stderr.trim()}`); return; }
    }
    script(join(main, 'voc-datalake/.venv/bin/python'), SHOW('real-main-venv'));
    const r = pinned(['python', '-V'], { root: install(join(base, 'wt')), path: `${stubs}:${process.env.PATH}` });
    assert.equal(r.out[0], 'RUN real-main-venv', r.err);
    // A plain folder inside the repository is not a checkout of it: python3, never the repository's venv.
    const nested = pinned(['python', '-V'], { root: install(join(main, 'nested')), path: `${stubs}:${process.env.PATH}` });
    assert.equal(nested.out[0], 'RUN python3', nested.err);
    // In the main checkout itself the common dir is its own: no venv there means python3, never a loop.
    rmSync(join(main, 'voc-datalake'), { recursive: true });
    assert.equal(pinned(['python3', '-V'], { root: install(main), path: `${stubs}:${process.env.PATH}` }).out[0], 'RUN python3');
  });

  it("validate.sh takes the same order: a worktree's run uses the main checkout's venv", () => {
    const root = tree();
    const main = mainCheckout();
    const out = join(fresh('env'), 'env.txt');
    const result = spawnSync('/bin/bash', [join(root, 'scripts/validate.sh'), '--dry-run', '--only', 'python-tests'], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${gitStubs}:${process.env.PATH}`, FAKE_GIT_COMMON: join(main, '.git'), PYTHON_BIN: '',
        VALIDATE_NUMA_ROOT: numaRoot(1), VALIDATE_PINNED: '', GITHUB_ACTIONS: '', VOC_VALIDATE_JOBS: '',
        VOC_VALIDATE_RAM: 'off', VALIDATE_LOG_DIR: fresh('logs'), OUT: out,
        VALIDATE_DRY_RUN_CMD: '[ "$VALIDATE_STEP" != pytest ] || echo "$PYTHON_BIN" > "$OUT"',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(readFileSync(out, 'utf8').trim(), join(main, 'voc-datalake/.venv/bin/python'));
    assert.match(result.stderr, /^validate: no voc-datalake\/\.venv in this tree; using the main checkout's /m);
  });
});
