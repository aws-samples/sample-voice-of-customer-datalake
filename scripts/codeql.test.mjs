// scripts/codeql.sh's languages side by side (CODEQL_PARALLEL=1, set by validate.sh's pool): both build and analyse
// at once, their logs print in order, and one language failing fails the run. Runs a copy of the script in a temp
// tree (it writes .cache/codeql under its own repo root) with a stub `codeql` on PATH that records what it did.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPTS = new URL('.', import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), 'codeql-test-'));
after(() => rmSync(base, { recursive: true, force: true }));

// `database create <db> --language=<lang>`: start, 0.5 s, end (FAIL_LANG's exits 3); `database analyze --output=<f>`:
// an empty SARIF. Every event goes to $EVENTS.
const STUB = `#!/bin/sh
case "$1 $2" in
  version*) echo 2.0.0 ;;
  "database create")
    lang=""; for a in "$@"; do case "$a" in --language=*) lang="\${a#--language=}" ;; esac; done
    echo "start $lang" >> "$EVENTS"; sleep 0.5
    [ "$lang" = "$FAIL_LANG" ] && { echo "create failed for $lang"; exit 3; }
    mkdir -p "$3"; echo "end $lang" >> "$EVENTS"; echo "created $lang" ;;
  "database analyze")
    [ -n "$FAIL_ANALYZE_DB" ] && [ "\${3##*/}" = "$FAIL_ANALYZE_DB" ] && { echo "analyze failed for $3"; exit 3; }
    for a in "$@"; do case "$a" in --output=*) printf '{"runs":[]}' > "\${a#--output=}" ;; esac; done ;;
esac
`;

let n = 0;
function run(env, { staleSarif = false } = {}) {
  n += 1;
  const root = join(base, `t${n}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  if (staleSarif) {   // an earlier run's clean SARIF: a failed analyse must not let it pass for this one
    mkdirSync(join(root, '.cache', 'codeql'), { recursive: true });
    writeFileSync(join(root, '.cache', 'codeql', 'javascript-typescript.sarif'), '{"runs":[]}');
  }
  mkdirSync(join(root, 'bin'));
  for (const f of ['codeql.sh', 'codeql-config.yml', 'codeql-summary.mjs']) copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  writeFileSync(join(root, 'bin', 'codeql'), STUB);
  chmodSync(join(root, 'bin', 'codeql'), 0o755);
  const events = join(root, 'events');
  writeFileSync(events, '');
  const result = spawnSync('/bin/bash', [join(root, 'scripts', 'codeql.sh')], {
    encoding: 'utf8',
    // CODEQL_PARALLEL cleared first: validate.sh's pool exports it to the gate that runs this file.
    env: { ...process.env, CODEQL_PARALLEL: '', PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVENTS: events, CODEQL_STRICT: '1', ...env },
  });
  return { ...result, events: readFileSync(events, 'utf8').trim().split('\n') };
}

describe('codeql.sh CODEQL_PARALLEL=1', () => {
  it('builds both languages at once and prints their logs in order', () => {
    const { status, stdout, stderr, events } = run({ CODEQL_PARALLEL: '1' });
    assert.equal(status, 0, stdout + stderr);
    assert.deepEqual(events.slice(0, 2).sort(), ['start javascript-typescript', 'start python'], 'both started before either ended');
    assert.ok(stdout.indexOf('created javascript-typescript') < stdout.indexOf('created python'), stdout);
  });

  it('fails the run when one language fails, and still prints the other\'s log', () => {
    const { status, stdout, stderr } = run({ CODEQL_PARALLEL: '1', FAIL_LANG: 'javascript-typescript' });
    assert.equal(status, 1, stdout + stderr);
    assert.match(stderr, /codeql: the .*javascript-typescript\.log run failed/);
    assert.match(stdout, /create failed for javascript-typescript/);
    assert.match(stdout, /created python/);
  });

  it('fails the run when an analyse fails, even with an earlier clean SARIF on disk, before any summary', () => {
    const { status, stdout, stderr } = run({ CODEQL_PARALLEL: '1', FAIL_ANALYZE_DB: 'db-js' }, { staleSarif: true });
    assert.equal(status, 1, stdout + stderr);
    assert.match(stdout, /analyze failed for .*db-js/);
    assert.match(stdout, /created python/);
    assert.doesNotMatch(stdout, /TOTAL errors=/, 'the summary never ran');
  });

  it('runs one language after the other without it', () => {
    const { status, stdout, stderr, events } = run({});
    assert.equal(status, 0, stdout + stderr);
    assert.deepEqual(events, ['start javascript-typescript', 'end javascript-typescript', 'start python', 'end python']);
  });
});
