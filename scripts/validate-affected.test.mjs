// Base resolution of scripts/validate-affected.sh (5.48.04): origin/main by default, the local main only outside
// CI when origin/main is missing, and a hard stop otherwise. Runs the real script in a throwaway repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRIPT = new URL('./validate-affected.sh', import.meta.url);
let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** The script's stderr+stdout for `--explain [base]`, with `CI` set or cleared. */
function explain({ base, ci }) {
  const env = { ...process.env };
  delete env.CI;
  if (ci) env.CI = 'true';
  const args = [join(repo, 'scripts', 'validate-affected.sh'), '--explain', ...(base ? [base] : [])];
  const result = spawnSync('bash', args, { cwd: repo, encoding: 'utf8', env });
  return { status: result.status, output: `${result.stderr}${result.stdout}` };
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'validate-affected-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(SCRIPT, join(repo, 'scripts', 'validate-affected.sh'));
  // --explain ends by asking validate.sh for its step list; a no-op stub keeps the test on base resolution.
  writeFileSync(join(repo, 'scripts', 'validate.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
});

after(() => rmSync(repo, { recursive: true, force: true }));

describe('validate-affected base resolution', () => {
  it('uses an explicit base as given', () => {
    const { status, output } = explain({ base: 'main' });
    assert.equal(status, 0);
    assert.match(output, /base main,/);
    assert.doesNotMatch(output, /no origin\/main here/);
  });

  it('falls back to the local main outside CI when origin/main is missing, and says so', () => {
    const { status, output } = explain({});
    assert.equal(status, 0);
    assert.match(output, /no origin\/main here; comparing against the local main/);
    assert.match(output, /base main,/);
  });

  it('stops in CI instead of falling back', () => {
    const { status, output } = explain({ ci: true });
    assert.equal(status, 2);
    assert.match(output, /base origin\/main is not a commit \(git fetch origin main/);
  });

  for (const base of ['no-such-ref', 'origin/main']) {
    it(`names the bad base an explicit argument gave (${base}), without the fetch hint`, () => {
      const { status, output } = explain({ base });
      assert.equal(status, 2);
      assert.match(output, new RegExp(`base ${base} is not a commit \\(pass one`));
    });
  }
});

/** The `groups:` the script selects when only `path` changed (an untracked file against base main). */
function groupsFor(path) {
  const file = join(repo, path);
  // Remember the directories this call creates, so cleanup removes exactly those (never scripts/ itself).
  const created = [];
  for (let dir = dirname(file); dir !== repo && !existsSync(dir); dir = dirname(dir)) created.push(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x\n');
  try {
    const { status, output } = explain({ base: 'main' });
    assert.equal(status, 0, output);
    const line = output.split('\n').find((l) => l.startsWith('groups: ')) ?? '';
    return line.slice('groups: '.length).split(',').filter(Boolean).sort();
  } finally {
    rmSync(file);
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
}

describe('validate-affected path mapping (5.49.00 gates)', () => {
  it('runs the three test suites (and repo) for a change to the coverage gate', () => {
    assert.deepEqual(groupsFor('scripts/coverage/check-per-file-coverage.mjs'),
      ['frontend-tests', 'python-tests', 'repo', 'stream-tests']);
  });

  it('runs only the repo group for GitHub config no gate step reads', () => {
    for (const path of ['.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md', '.github/dependency-review-config.yml']) {
      assert.deepEqual(groupsFor(path), ['repo'], path);
    }
  });

  it('still runs everything for a workflow change', () => {
    assert.deepEqual(groupsFor('.github/workflows/quality-gates.yml'),
      ['audit', 'bridge', 'cdk', 'frontend', 'python', 'repo', 'stream']);
  });

  // `repo` is always selected (the script starts from it), so it appears beside the mapped group.
  it('runs the python group for the production pyright config', () => {
    assert.deepEqual(groupsFor('voc-datalake/pyrightconfig.production.json'), ['python', 'repo']);
  });
});

describe('validate-affected never selects the AI reviews (a model call per branch)', () => {
  it('leaves out the tenets and commit groups, also when everything runs', () => {
    for (const path of ['scripts/ai-review/review.mjs', '.kiro/agents/commit-reviewer.json',
      'TENETS.md', 'some-new-top-level/file.txt', '.github/workflows/quality-gates.yml']) {
      const groups = groupsFor(path);
      assert.ok(groups.includes('repo'), path);
      assert.ok(!groups.includes('tenets') && !groups.includes('commit'), `${path}: ${groups.join(',')}`);
    }
  });
});

