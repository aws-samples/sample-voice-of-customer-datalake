// Tests for scripts/ai-review/gate.mjs: the rules a GO record must meet, and the record / check / show commands on a
// throwaway repository (git init under a temp dir), so the staged tree is the real `git write-tree` of its index.
//
// LIMITS: the record is the developer's own word; these tests pin its shape and that it names the staged tree, which
// is all the gate can check.
//
// Run: node --test scripts/ai-review/gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ROUNDS, recordPath, REVIEWERS, summaryLine, validateRecord } from './gate.mjs'

const GATE = join(import.meta.dirname, 'gate.mjs')
const TREE = 'a'.repeat(40)

const finding = (fields = {}) => ({ id: 'C1', severity: 'should-fix', summary: 'a cap is never applied', outcome: 'fixed', note: '', ...fields })
/** One round with the five reviews; `findings` maps a reviewer to its findings. */
const round = (number, findings = {}) => ({ round: number, reviews: REVIEWERS.map((reviewer) => ({ reviewer, findings: findings[reviewer] ?? [] })) })
const BLOCKER = finding({ id: 'S1', severity: 'blocking', summary: 'the partition key comes from the body' })
const goRecord = (fields = {}) => ({
  tree: TREE,
  rounds: [round(1, { security: [BLOCKER], quality: [finding({ outcome: 'deferred', note: 'follow-up' })] }), round(2)],
  go: { verdict: 'GO', reasons: 'every blocking finding fixed; the tests cover the new key' },
  ...fields,
})

test('a record of rounds that converged on no blocking finding, with a GO, is valid', () => {
  assert.deepEqual(validateRecord(goRecord(), { tree: TREE }), [])
  assert.deepEqual(validateRecord(goRecord({ rounds: [round(1, { commit: [finding({ severity: 'nit' })] })] })), [], 'one clean round is enough')
  assert.deepEqual(validateRecord(goRecord({ tree: 'b'.repeat(64) })), [], 'a SHA-256 repository\'s tree id')
})

test('only a GO with its reasons is recorded', () => {
  assert.match(validateRecord(goRecord({ go: { verdict: 'NO-GO', reasons: 'x' } })).join('\n'), /NO-GO: only a GO is recorded/)
  assert.match(validateRecord(goRecord({ go: { verdict: 'go', reasons: 'x' } })).join('\n'), /go\.verdict: one of GO, NO-GO/)
  assert.match(validateRecord(goRecord({ go: { verdict: 'GO', reasons: ' ' } })).join('\n'), /go\.reasons/)
  assert.match(validateRecord(goRecord({ go: undefined })).join('\n'), /go\.verdict/)
})

test('the record must name the staged tree', () => {
  assert.match(validateRecord(goRecord(), { tree: 'c'.repeat(40) }).join('\n'), /the change moved since its review/)
  for (const tree of ['../../etc/passwd', 'A'.repeat(40), 'a'.repeat(39), undefined]) {
    assert.match(validateRecord(goRecord({ tree })).join('\n'), /tree: not a tree hash/, String(tree))
  }
})

test('at most three rounds, numbered in order, each with the five reviewers once', () => {
  assert.equal(MAX_ROUNDS, 3)
  const blocked = (n) => round(n, { tenets: [{ ...BLOCKER, id: `T${n}` }] })
  assert.match(validateRecord(goRecord({ rounds: [blocked(1), blocked(2), blocked(3), round(4)] })).join('\n'), /between 1 and 3 rounds \(found 4\)/)
  assert.match(validateRecord(goRecord({ rounds: [] })).join('\n'), /between 1 and 3 rounds \(found 0\)/)
  assert.match(validateRecord(goRecord({ rounds: [blocked(1), round(3)] })).join('\n'), /rounds\[1\]: round must be 2/)
  const missing = { round: 1, reviews: round(1).reviews.filter((r) => r.reviewer !== 'first-principles') }
  assert.match(validateRecord(goRecord({ rounds: [missing] })).join('\n'), /the first-principles review must appear exactly once \(found 0\)/)
  const twice = { round: 1, reviews: [...round(1).reviews, { reviewer: 'security', findings: [] }, { reviewer: 'style', findings: [] }] }
  const errors = validateRecord(goRecord({ rounds: [twice] })).join('\n')
  assert.match(errors, /the security review must appear exactly once \(found 2\)/)
  assert.match(errors, /unknown reviewer "style"/)
  const noList = { round: 1, reviews: round(1).reviews.map((r) => (r.reviewer === 'quality' ? { reviewer: 'quality' } : r)) }
  assert.match(validateRecord(goRecord({ rounds: [noList] })).join('\n'), /reviews\[3\]: no findings list/)
})

test('the last round has no blocking finding, and only the last round is without one', () => {
  assert.match(validateRecord(goRecord({ rounds: [round(1, { security: [BLOCKER] })] })).join('\n'), /the last round has 1 blocking finding/)
  // A fixed blocker in the last round is still a blocker found in that round: the loop needed another round.
  assert.match(validateRecord(goRecord({ rounds: [round(1, { commit: [BLOCKER] }), round(2, { quality: [BLOCKER] })] })).join('\n'), /rounds\[1\]: the last round has 1/)
  assert.match(validateRecord(goRecord({ rounds: [round(1), round(2)] })).join('\n'), /rounds\[0\]: a round with no blocking finding ends the loop/)
})

test('a blocking finding in round 3 leaves no way to a GO but starting again', () => {
  const three = [round(1, { commit: [BLOCKER] }), round(2, { quality: [BLOCKER] }), round(3, { security: [BLOCKER] })]
  const message = validateRecord(goRecord({ rounds: three })).join('\n')
  assert.match(message, /round 3 still has 1 blocking finding\(s\): no GO for this change; split or rework it and start the gate again at round 1/)
  assert.doesNotMatch(message, /run another round/)
})

test('a blocking finding is fixed, or rejected with a note, never deferred', () => {
  const withBlocker = (blocker) => goRecord({ rounds: [round(1, { security: [blocker] }), round(2)] })
  assert.deepEqual(validateRecord(withBlocker({ ...BLOCKER, outcome: 'rejected', note: 'the key is the authorizer\'s sub, see handler.py:40' })), [])
  assert.match(validateRecord(withBlocker({ ...BLOCKER, outcome: 'rejected', note: '' })).join('\n'), /a rejected blocking finding needs a note/)
  assert.match(validateRecord(withBlocker({ ...BLOCKER, outcome: 'deferred', note: 'later' })).join('\n'), /cannot be deferred/)
  assert.deepEqual(validateRecord(goRecord({ rounds: [round(1, { quality: [finding({ outcome: 'rejected' })] })] })), [], 'a non-blocking one can be rejected without a note')
})

test('each finding has an id, a known severity and outcome, and a summary', () => {
  const errors = validateRecord(goRecord({ rounds: [round(1, { commit: [{ id: '', severity: 'major', summary: '', outcome: 'ignored', note: 3 }, 'junk'] })] })).join('\n')
  for (const message of [/no id/, /severity must be one of blocking, should-fix, nit/, /no summary/, /outcome must be one of fixed, rejected, deferred/, /note must be a string/, /findings\[1\]: not an object/]) {
    assert.match(errors, message)
  }
  assert.deepEqual(validateRecord(null), ['the record is not a JSON object'])
  assert.match(validateRecord(goRecord({ recordedAt: 'yesterday' })).join('\n'), /recordedAt: not a date/)
})

test('the summary line counts the rounds and gives the verdict', () => {
  assert.equal(summaryLine(goRecord()), 'review gate: 2 rounds, GO')
  assert.equal(summaryLine(goRecord({ rounds: [round(1, { commit: [finding()] })] })), 'review gate: 1 round, GO')
})

// The parent's GIT_* (a test run from inside a hook) must not point these commands at another repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/**
 * A throwaway repository with one staged file and .cache/ ignored (as in this repository), its working tree equal to
 * its index; returns its root and staged tree. Record files are written outside it, in their own temp dir.
 */
function stagedRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'gate-test-'))
  const records = mkdtempSync(join(tmpdir(), 'gate-records-'))
  t.after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(records, { recursive: true, force: true }) })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, '.gitignore'), '.cache/\n')
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1\n')
  git(repo, 'add', '.gitignore', 'a.mjs')
  recordDirs.set(repo, records)
  return { repo, tree: git(repo, 'write-tree') }
}

const gate = (cwd, ...args) => spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8', env: ENV })

const recordDirs = new Map()
function writeRecord(repo, record) {
  const file = join(recordDirs.get(repo), 'record.json')
  writeFileSync(file, JSON.stringify(record))
  return file
}

test('record keeps a GO record for the staged tree, and check and show find it', (t) => {
  const { repo, tree } = stagedRepo(t)
  assert.equal(gate(repo, 'check').status, 1, 'nothing recorded yet')
  const recorded = gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree, subject: 'fix: the key', extra: 'dropped' })))
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr)
  assert.match(recorded.stdout, /review gate: 2 rounds, GO/)
  const kept = JSON.parse(readFileSync(recordPath(repo, tree), 'utf8'))
  assert.deepEqual(Object.keys(kept), ['tree', 'rounds', 'go', 'recordedAt'], 'only the schema\'s fields are kept')
  assert.ok(!Number.isNaN(Date.parse(kept.recordedAt)))
  const checked = gate(repo, 'check')
  assert.equal(checked.status, 0, checked.stdout)
  assert.match(checked.stdout, /GO recorded for the staged tree/)
  const shown = gate(repo, 'show')
  assert.equal(shown.status, 0)
  assert.equal(JSON.parse(shown.stdout.slice(0, shown.stdout.lastIndexOf('}') + 1)).tree, tree)
  assert.match(shown.stdout.trim().split('\n').at(-1), /^review gate: 2 rounds, GO$/)
})

test('staging anything after the record needs a new one', (t) => {
  const { repo, tree } = stagedRepo(t)
  assert.equal(gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree }))).status, 0)
  writeFileSync(join(repo, 'b.mjs'), 'export const b = 2\n')
  git(repo, 'add', 'b.mjs')
  const checked = gate(repo, 'check')
  assert.equal(checked.status, 1)
  assert.match(checked.stdout, /no review gate record for the staged tree [0-9a-f]{40}[\s\S]*gate\.mjs record --file/)
  assert.equal(gate(repo, 'check', '--tree', tree).status, 0, 'the old tree is still recorded')
})

test('record refuses a NO-GO, a record of another tree, and a bad file, writing nothing', (t) => {
  const { repo, tree } = stagedRepo(t)
  const nogo = gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree, go: { verdict: 'NO-GO', reasons: 'tests missing' } })))
  assert.equal(nogo.status, 1)
  assert.match(nogo.stdout, /refused:[\s\S]*NO-GO/)
  const other = gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree: 'c'.repeat(40) })))
  assert.equal(other.status, 1)
  assert.match(other.stdout, /the change moved since its review/)
  assert.equal(gate(repo, 'record', '--file', join(repo, 'missing.json')).status, 2)
  assert.equal(gate(repo, 'record').status, 2, '--file is required')
  for (const flag of [['--tree', TREE], [`--tree=${TREE}`], ['--tree', tree]]) {
    const given = gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree })), ...flag)
    assert.equal(given.status, 2, flag.join(' '))
    assert.match(given.stdout, /record takes no --tree/)
  }
  assert.ok(!existsSync(join(repo, '.cache')), 'nothing written')
})

test('record refuses unless the working tree is exactly the index (what the reviews read is what is committed)', (t) => {
  const { repo, tree } = stagedRepo(t)
  const file = writeRecord(repo, goRecord({ tree }))
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 2\n')
  const unstaged = gate(repo, 'record', '--file', file)
  assert.equal(unstaged.status, 1)
  assert.match(unstaged.stdout, /refused: tracked files have unstaged changes[\s\S]*exactly what is staged/)
  git(repo, 'checkout', '--', 'a.mjs')
  writeFileSync(join(repo, 'new.mjs'), 'export const n = 1\n')
  const untracked = gate(repo, 'record', '--file', file)
  assert.equal(untracked.status, 1)
  assert.match(untracked.stdout, /refused: untracked files that are not ignored: new\.mjs/)
  assert.ok(!existsSync(join(repo, '.cache')), 'nothing written')
  rmSync(join(repo, 'new.mjs'))
  mkdirSync(join(repo, '.cache', 'other'), { recursive: true })
  writeFileSync(join(repo, '.cache', 'other', 'log.txt'), 'ignored\n')
  const clean = gate(repo, 'record', '--file', file)
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  assert.equal(gate(repo, 'check').status, 0)
})

test('check refuses a stored record that is not a GO for that tree', (t) => {
  const { repo, tree } = stagedRepo(t)
  assert.equal(gate(repo, 'record', '--file', writeRecord(repo, goRecord({ tree }))).status, 0)
  const file = recordPath(repo, tree)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), go: { verdict: 'NO-GO', reasons: 'edited' } }))
  const edited = gate(repo, 'check')
  assert.equal(edited.status, 1)
  assert.match(edited.stdout, /is not a GO record/)
  writeFileSync(file, '{')
  const broken = gate(repo, 'check')
  assert.equal(broken.status, 1)
  assert.match(broken.stdout, /is not valid JSON/)
})

test('run through a symlinked folder, also with --preserve-symlinks-main, it still checks (never a silent exit 0)', (t) => {
  const { repo } = stagedRepo(t)
  const links = mkdtempSync(join(tmpdir(), 'gate-link-'))
  t.after(() => rmSync(links, { recursive: true, force: true }))
  symlinkSync(import.meta.dirname, join(links, 'ai-review'))
  const linked = join(links, 'ai-review', 'gate.mjs')
  for (const env of [ENV, { ...ENV, NODE_OPTIONS: '--preserve-symlinks-main' }]) {
    const result = spawnSync(process.execPath, [linked, 'check'], { cwd: repo, encoding: 'utf8', env })
    assert.equal(result.status, 1, `${env.NODE_OPTIONS ?? 'plain'}: ${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /no review gate record/)
  }
})

test('usage errors and a directory outside git exit 2', (t) => {
  const { repo } = stagedRepo(t)
  assert.equal(gate(repo, 'publish').status, 2)
  assert.equal(gate(repo, 'check', '--tree', '../x').status, 2)
  const outside = mkdtempSync(join(tmpdir(), 'gate-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [GATE, 'check'], { cwd: outside, encoding: 'utf8', env: { ...ENV, GIT_CEILING_DIRECTORIES: tmpdir() } })
  assert.equal(result.status, 2)
  assert.match(result.stdout, /not inside a git repository/)
})
