/**
 * The review gate (gate.mjs) and its pre-commit hook, run as a developer runs them: in a scratch git repository,
 * through the CLI and through `git commit`.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'gate.mjs')
const HOOK = join(HERE, '..', 'git-hooks', 'pre-commit')
const scratch = mkdtempSync(join(tmpdir(), 'review-gate-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let repo
let counter = 0
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const gate = (...args) => spawnSync('node', [GATE, ...args], { cwd: repo, encoding: 'utf8' })

const finding = (overrides = {}) => ({ source: 'quality', id: 'Q1', severity: 'should-fix', title: 'a name misleads', outcome: 'fixed', ...overrides })
const goRecord = (overrides = {}) => ({
  change: 'a scratch change',
  rounds: [{ findings: [finding({ severity: 'blocking' })] }, { findings: [] }],
  go: { verdict: 'GO', reasons: 'the blocking finding is fixed and tested' },
  ...overrides,
})

function writeRecord(record) {
  const file = join(scratch, `record-${counter++}.json`)
  writeFileSync(file, JSON.stringify(record))
  return file
}

function stage(name, text) {
  writeFileSync(join(repo, name), text)
  git('add', name)
}

beforeEach(() => {
  repo = join(scratch, `repo-${counter++}`)
  mkdirSync(repo)
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Example Developer')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '.git/hooks') // a global core.hooksPath would skip the hook under test
  stage('a.txt', 'first\n')
  stage('.gitignore', '.cache/\n') // as in the real repository: the records are never untracked files
  git('commit', '-q', '-m', 'first')
})

describe('gate.mjs record and check', () => {
  it('records a GO for the staged tree, and check then passes with the rounds counted', () => {
    stage('a.txt', 'second\n')
    const recorded = gate('record', writeRecord(goRecord()))
    assert.equal(recorded.status, 0, recorded.stderr)
    const checked = gate('check')
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(checked.stdout.trim(), 'review gate: 2 rounds, GO')
  })

  it('sees an untracked file anywhere in the repository when run from a subdirectory', () => {
    mkdirSync(join(repo, 'sub'))
    stage('sub/a.txt', 'staged\n')
    writeFileSync(join(repo, 'elsewhere.txt'), 'not added\n')
    const recorded = spawnSync('node', [GATE, 'record', writeRecord(goRecord())], { cwd: join(repo, 'sub'), encoding: 'utf8' })
    assert.equal(recorded.status, 1)
    assert.match(recorded.stderr, /untracked files/)
  })

  it('refuses a stored record that is valid JSON but not an object, without a stack trace', () => {
    stage('a.txt', 'second\n')
    assert.equal(gate('record', writeRecord(goRecord())).status, 0)
    writeFileSync(join(repo, '.cache', 'ai-review', 'gate', `${git('write-tree')}.json`), 'null')
    const checked = gate('check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /not a JSON object/)
    assert.doesNotMatch(checked.stderr, /TypeError/)
  })

  it('refuses a stored record whose tree is not the staged one', () => {
    stage('a.txt', 'second\n')
    assert.equal(gate('record', writeRecord(goRecord())).status, 0)
    const path = join(repo, '.cache', 'ai-review', 'gate', `${git('write-tree')}.json`)
    writeFileSync(path, JSON.stringify({ ...goRecord(), tree: '0'.repeat(40) }))
    const checked = gate('check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /the record names tree 0{40}/)
  })

  it('refuses a staged tree that changed after its review', () => {
    stage('a.txt', 'second\n')
    assert.equal(gate('record', writeRecord(goRecord())).status, 0)
    stage('b.txt', 'added after the review\n')
    const checked = gate('check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /no GO record for the staged tree/)
  })

  it('refuses to record while the working tree has an unstaged edit the reviews saw but the index lacks', () => {
    stage('a.txt', 'second\n')
    writeFileSync(join(repo, 'a.txt'), 'the fix, not staged\n')
    const recorded = gate('record', writeRecord(goRecord()))
    assert.equal(recorded.status, 1)
    assert.match(recorded.stderr, /unstaged changes/)
    assert.equal(gate('check').status, 1)
  })

  it('refuses to record while an untracked file sits in the working tree', () => {
    stage('a.txt', 'second\n')
    writeFileSync(join(repo, 'new.txt'), 'not added\n')
    const recorded = gate('record', writeRecord(goRecord()))
    assert.equal(recorded.status, 1)
    assert.match(recorded.stderr, /untracked files/)
  })

  it('stores the computed tree even when the input names another', () => {
    stage('a.txt', 'second\n')
    assert.equal(gate('record', writeRecord({ ...goRecord(), tree: '0'.repeat(40) })).status, 0)
    assert.equal(gate('check').status, 0)
  })

  it("records HEAD's own tree, so a message-only amend can be gated", () => {
    const recorded = gate('record', writeRecord(goRecord()))
    assert.equal(recorded.status, 0, recorded.stderr)
    assert.equal(gate('check').status, 0)
  })

  const refused = [
    ['a NO-GO verdict', goRecord({ go: { verdict: 'NO-GO', reasons: 'a leak is left' } }), /not GO/],
    ['no reasons for the GO', goRecord({ go: { verdict: 'GO', reasons: ' ' } }), /go: no reasons/],
    ['a blocking finding in the last round', goRecord({ rounds: [{ findings: [finding({ severity: 'blocking' })] }] }), /last round still has a blocking finding/],
    ['an earlier blocking finding not fixed', goRecord({ rounds: [{ findings: [finding({ severity: 'blocking', outcome: 'rejected', note: 'disagree' })] }, { findings: [] }] }), /must be fixed, not rejected/],
    ['four rounds', goRecord({ rounds: [{ findings: [] }, { findings: [] }, { findings: [] }, { findings: [] }] }), /rounds: 4, must be 1 to 3/],
    ['no rounds', goRecord({ rounds: [] }), /rounds: 0/],
    ['a rejected should-fix without a note', goRecord({ rounds: [{ findings: [finding({ outcome: 'rejected' })] }] }), /needs a note/],
    ['an earlier blocking finding deferred', goRecord({ rounds: [{ findings: [finding({ severity: 'blocking', outcome: 'deferred', note: 'later' })] }, { findings: [] }] }), /must be fixed, not deferred/],
    ['an unknown source', goRecord({ rounds: [{ findings: [finding({ source: 'someone' })] }] }), /source must be one of/],
    ['an unknown severity', goRecord({ rounds: [{ findings: [finding({ severity: 'critical' })] }] }), /severity must be one of/],
    ['an unknown outcome', goRecord({ rounds: [{ findings: [finding({ outcome: 'ignored', note: 'x' })] }] }), /outcome must be one of/],
    ['a round without its findings list', goRecord({ rounds: [{}] }), /no findings list/],
    ['no change description', goRecord({ change: '' }), /change: no one-line description/],
    ['a finding without an id', goRecord({ rounds: [{ findings: [finding({ id: '' })] }] }), /no id/],
  ]
  for (const [name, record, message] of refused) {
    it(`refuses to record ${name}`, () => {
      stage('a.txt', 'second\n')
      const recorded = gate('record', writeRecord(record))
      assert.equal(recorded.status, 1, `${name} was recorded`)
      assert.match(recorded.stderr, message)
      assert.equal(gate('check').status, 1)
    })
  }

  it('refuses a stored record that was edited into an invalid one', () => {
    stage('a.txt', 'second\n')
    assert.equal(gate('record', writeRecord(goRecord())).status, 0)
    const tree = git('write-tree')
    const path = join(repo, '.cache', 'ai-review', 'gate', `${tree}.json`)
    writeFileSync(path, JSON.stringify({ ...goRecord({ go: { verdict: 'NO-GO', reasons: 'edited' } }), tree }))
    const checked = gate('check')
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /not GO/)
  })
})

describe('the pre-commit hook', () => {
  const install = () => {
    // The hook runs the gate of the repository it is in: commit a copy there first (before the hook exists).
    mkdirSync(join(repo, 'scripts', 'ai-review'), { recursive: true })
    copyFileSync(GATE, join(repo, 'scripts', 'ai-review', 'gate.mjs'))
    git('add', 'scripts')
    git('commit', '-q', '-m', 'the gate')
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    copyFileSync(HOOK, hook)
    chmodSync(hook, 0o755)
  }

  it('refuses a commit without a GO record and lets the reviewed tree through', () => {
    install()
    stage('a.txt', 'second\n')
    const refusedCommit = spawnSync('git', ['commit', '-q', '-m', 'unreviewed'], { cwd: repo, encoding: 'utf8' })
    assert.notEqual(refusedCommit.status, 0)
    assert.match(refusedCommit.stderr, /the commit is refused/)
    assert.equal(gate('record', writeRecord(goRecord())).status, 0)
    const committed = spawnSync('git', ['commit', '-q', '-m', 'reviewed'], { cwd: repo, encoding: 'utf8' })
    assert.equal(committed.status, 0, committed.stderr)
    assert.equal(git('log', '-1', '--format=%s'), 'reviewed')
  })

  it('lets a commit through, saying so, on a checkout without the gate', () => {
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    copyFileSync(HOOK, hook)
    chmodSync(hook, 0o755)
    stage('a.txt', 'second\n')
    const committed = spawnSync('git', ['commit', '-q', '-m', 'old branch'], { cwd: repo, encoding: 'utf8' })
    assert.equal(committed.status, 0, committed.stderr)
    assert.match(committed.stderr, /commit not gated/)
  })
})
