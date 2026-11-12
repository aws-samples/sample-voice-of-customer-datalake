// Tests for scripts/git-hooks/pre-commit: real `git commit`s in a throwaway repository with the hook installed, so
// the hook sees exactly what git gives it (the top level as cwd, GIT_INDEX_FILE for `git commit -a`).
//
// WHY: the hook is the only thing that stops a commit the review gate has not passed. A hook that read the wrong
// index, honoured a skip variable, or let a missing gate script through would pass every commit silently.
// LIMITS: the record is written here by the test, as a developer would; nothing checks the reviews behind it.
//
// Run: node --test scripts/git-hooks/pre-commit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HOOKS, '..')
const REVIEWERS = ['tenets', 'commit', 'security', 'quality', 'first-principles']

function run(cwd, command, args, env = {}) {
  // The parent's GIT_* (a test run from inside a hook) must not point these commands at another repository.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...clean, ...env } })
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/**
 * A throwaway repository with the hook installed as CONTRIBUTING.md says (copied into its hooks directory) and
 * this checkout's scripts/ linked in, so the hook runs the real gate.mjs through a symlinked folder (a plain "am I the main
 * module" test compares the link with the real path and exits 0 without checking anything). One file is committed, a
 * second is staged.
 */
function hookedRepo(t, { linkScripts = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'pre-commit-test-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Example Air Dev')
  writeFileSync(join(repo, '.gitignore'), '.cache/\nscripts\nrecord.json\n')
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1\n')
  git(repo, 'add', '.gitignore', 'a.mjs')
  git(repo, 'commit', '-q', '--no-verify', '-m', 'base')
  if (linkScripts) symlinkSync(SCRIPTS, join(repo, 'scripts'))
  const hooks = join(repo, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  // The repository's own hooks directory, whatever a machine-wide core.hooksPath says.
  git(repo, 'config', 'core.hooksPath', hooks)
  copyFileSync(join(HOOKS, 'pre-commit'), join(hooks, 'pre-commit'))
  chmodSync(join(hooks, 'pre-commit'), 0o755)
  writeFileSync(join(repo, 'b.mjs'), 'export const b = 2\n')
  git(repo, 'add', 'b.mjs')
  return repo
}

/** Records a GO for the tree now staged in `repo` with the real gate.mjs (`env`: e.g. another GIT_INDEX_FILE). */
function recordGo(repo, env = {}) {
  const written = run(repo, 'git', ['write-tree'], env)
  assert.equal(written.status, 0, written.stderr)
  const tree = written.stdout.trim()
  const record = {
    tree,
    rounds: [{ round: 1, reviews: REVIEWERS.map((reviewer) => ({ reviewer, findings: [] })) }],
    go: { verdict: 'GO', reasons: 'no findings' },
  }
  writeFileSync(join(repo, 'record.json'), JSON.stringify(record))
  const result = run(repo, process.execPath, [join(SCRIPTS, 'ai-review', 'gate.mjs'), 'record', '--file', 'record.json'], env)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return tree
}

const commit = (repo, args = [], env = {}) => run(repo, 'git', ['commit', '-q', '-m', 'change', ...args], env)

test('a commit with no GO record for its staged tree is refused, and says how to get one', (t) => {
  const repo = hookedRepo(t)
  const result = commit(repo)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  // git sends a hook's stdout to its stderr.
  assert.match(result.stderr, /no review gate record for the staged tree[\s\S]*gate\.mjs record --file/)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1', 'nothing committed')
})

test('a commit whose staged tree has a GO record goes through', (t) => {
  const repo = hookedRepo(t)
  const tree = recordGo(repo)
  const result = commit(repo)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), tree)
})

test('the hook judges the index git commits: `git commit -a` with unreviewed changes is refused', (t) => {
  const repo = hookedRepo(t)
  recordGo(repo)
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 3\n')
  const result = commit(repo, ['-a'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1')
})

/** What `git commit -a` will commit: a copy of the index with every tracked change added (the real one untouched). */
function commitAllIndex(repo) {
  const index = join(repo, '.git', 'index-commit-a')
  copyFileSync(join(repo, '.git', 'index'), index)
  const added = run(repo, 'git', ['add', '-u'], { GIT_INDEX_FILE: index })
  assert.equal(added.status, 0, added.stderr)
  return { GIT_INDEX_FILE: index }
}

test('the hook judges the index git commits: `git commit -a` whose tree has a GO record goes through', (t) => {
  const repo = hookedRepo(t)
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 3\n')
  // Reviewed and recorded as `git commit -a` will commit it: the edit of a.mjs and the staged b.mjs.
  const tree = recordGo(repo, commitAllIndex(repo))
  // The staged index alone (b.mjs, without the edit of a.mjs) is another tree: a hook reading it would refuse.
  assert.notEqual(git(repo, 'write-tree'), tree)
  const result = commit(repo, ['-a'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), tree)
})

test('no environment variable skips it; only git\'s own --no-verify does', (t) => {
  const repo = hookedRepo(t)
  for (const env of [{ SKIP_AI_REVIEW: '1' }, { SKIP_REVIEW_GATE: '1' }, { AI_REVIEW: 'off' }, { CI: 'true' }]) {
    assert.equal(commit(repo, [], env).status, 1, JSON.stringify(env))
  }
  assert.equal(commit(repo, ['--no-verify']).status, 0)
})

test('silence is not a pass: NODE_OPTIONS=--preserve-symlinks-main through the symlinked scripts does not skip the check', (t) => {
  const repo = hookedRepo(t)
  const env = { NODE_OPTIONS: '--preserve-symlinks-main' }
  const refused = commit(repo, [], env)
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /no review gate record for the staged tree/)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1', 'nothing committed')
  recordGo(repo)
  const passed = commit(repo, [], env)
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
})

test('a gate.mjs that exits 0 without a main() to answer is refused', (t) => {
  const repo = hookedRepo(t, { linkScripts: false })
  mkdirSync(join(repo, 'scripts', 'ai-review'), { recursive: true })
  writeFileSync(join(repo, 'scripts', 'ai-review', 'gate.mjs'), 'process.exitCode = 0\n')
  const result = commit(repo)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /gate\.mjs has no main\(\)[\s\S]*commit refused/)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1', 'nothing committed')
})

test('without gate.mjs in the checkout the commit is refused', (t) => {
  const repo = hookedRepo(t, { linkScripts: false })
  const result = commit(repo)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /gate\.mjs is missing in this checkout[\s\S]*commit refused/)
})
