#!/usr/bin/env node
/**
 * The review gate's record: proof, kept on this machine, that the exact tree about to be committed went through the
 * review rounds and got a GO.
 *
 *   node scripts/ai-review/gate.mjs record --file <record.json>   validate a GO record for the staged tree and keep it
 *   node scripts/ai-review/gate.mjs check [--tree <hash>]        exit 0 when the staged tree (or <hash>) has one
 *   node scripts/ai-review/gate.mjs show [--tree <hash>]         print the record and its summary line
 *
 * `record` only ever records the staged tree, and only when the working tree is the index: no unstaged change to a
 * tracked file (`git diff --quiet`) and no untracked file that is not ignored (`git ls-files --others
 * --exclude-standard`). The reviews read the working tree, untracked files included, so this is what makes the tree
 * they reviewed the one that is committed. A review that printed `skipped:` did not run: rerun it before its round
 * counts.
 *
 * THE GATE (CONTRIBUTING.md → "Review gate before commit"): `npm run validate` green; then at most MAX_ROUNDS review
 * rounds on the exact change, each with the five REVIEWERS (the tenets and commit reviews of validate.sh, with
 * AI_REVIEW_CACHE=0, and the security, quality and first-principles agents of .kiro/agents/); every blocking finding is
 * fixed, and a round with no blocking finding ends the loop; then one fresh agent answers GO or NO-GO. Only a GO is
 * recorded, under .cache/ai-review/gate/<tree>.json (ignored by git), keyed by the tree `git write-tree` gives for the
 * index, so any change to what is staged needs a new record. scripts/git-hooks/pre-commit runs `check`.
 *
 * LIMITS: the record is written by the developer (or their agent) and lives only on their machine. The gate checks its
 * shape and that it names the staged tree; it cannot check that the reviews it lists really ran or say what it claims.
 * It is a discipline, not a security boundary, and CI does not see it. The hook runs the gate.mjs of the checked-out
 * tree, so a local edit to this file changes the check (and a checkout without it is refused). `git write-tree` adds a tree object to the
 * object database (as `git commit` would); it changes no ref and not the index.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from './review.mjs'

export const MAX_ROUNDS = 3
export const REVIEWERS = Object.freeze(['tenets', 'commit', 'security', 'quality', 'first-principles'])
const SEVERITIES = Object.freeze(['blocking', 'should-fix', 'nit'])
const OUTCOMES = Object.freeze(['fixed', 'rejected', 'deferred'])
const VERDICTS = Object.freeze(['GO', 'NO-GO'])
// A tree id: SHA-1 (40 hex) or, in a SHA-256 repository, 64 hex. Also what makes it safe as a file name.
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const filled = (value) => typeof value === 'string' && value.trim() !== ''

/** The problems of one finding (`where` names it in the messages). */
function findingErrors(finding, where) {
  if (!isRecord(finding)) return [`${where}: not an object`]
  const errors = []
  if (!filled(finding.id)) errors.push(`${where}: no id`)
  if (!SEVERITIES.includes(finding.severity)) errors.push(`${where}: severity must be one of ${SEVERITIES.join(', ')}`)
  if (!filled(finding.summary)) errors.push(`${where}: no summary`)
  if (!OUTCOMES.includes(finding.outcome)) errors.push(`${where}: outcome must be one of ${OUTCOMES.join(', ')}`)
  if (finding.note !== undefined && typeof finding.note !== 'string') errors.push(`${where}: note must be a string`)
  if (finding.severity === 'blocking' && finding.outcome === 'deferred') errors.push(`${where}: a blocking finding cannot be deferred: fix it, or reject it with a note`)
  if (finding.severity === 'blocking' && finding.outcome === 'rejected' && !filled(finding.note)) errors.push(`${where}: a rejected blocking finding needs a note saying why`)
  return errors
}

/** The problems of one round, and whether it had a blocking finding. */
function roundErrors(round, index) {
  const where = `rounds[${index}]`
  if (!isRecord(round)) return { errors: [`${where}: not an object`], blocking: 0 }
  const errors = []
  if (round.round !== index + 1) errors.push(`${where}: round must be ${index + 1} (rounds are numbered 1, 2, 3 in order)`)
  const reviews = Array.isArray(round.reviews) ? round.reviews : []
  if (!Array.isArray(round.reviews)) errors.push(`${where}: no reviews list`)
  const seen = reviews.map((review) => (isRecord(review) ? review.reviewer : undefined))
  for (const name of REVIEWERS) {
    const times = seen.filter((reviewer) => reviewer === name).length
    if (times !== 1) errors.push(`${where}: the ${name} review must appear exactly once (found ${times})`)
  }
  for (const name of seen.filter((reviewer) => !REVIEWERS.includes(reviewer))) errors.push(`${where}: unknown reviewer ${JSON.stringify(name)}`)
  let blocking = 0
  reviews.forEach((review, r) => {
    const at = `${where}.reviews[${r}]`
    if (!isRecord(review) || !Array.isArray(review.findings)) { errors.push(`${at}: no findings list (use [] for none)`); return }
    review.findings.forEach((finding, f) => {
      errors.push(...findingErrors(finding, `${at}.findings[${f}]`))
      if (isRecord(finding) && finding.severity === 'blocking') blocking += 1
    })
  })
  return { errors, blocking }
}

/**
 * Every reason `record` is not a GO record for `tree` (an empty list when it is one). The rules: at most MAX_ROUNDS
 * rounds, each with the five reviewers; a blocking finding is fixed, or rejected with a note, never deferred; every
 * round but the last had a blocking finding (a round without one ends the loop) and the last has none; the final
 * agent's verdict is GO with its reasons.
 */
export function validateRecord(record, { tree } = {}) {
  if (!isRecord(record)) return ['the record is not a JSON object']
  const errors = []
  if (typeof record.tree !== 'string' || !TREE.test(record.tree)) errors.push('tree: not a tree hash (40 or 64 lowercase hex)')
  else if (tree !== undefined && record.tree !== tree) errors.push(`tree: the record is for ${record.tree}, but the staged tree is ${tree} (the change moved since its review)`)
  const rounds = Array.isArray(record.rounds) ? record.rounds : []
  if (rounds.length < 1 || rounds.length > MAX_ROUNDS) errors.push(`rounds: between 1 and ${MAX_ROUNDS} rounds (found ${rounds.length})`)
  rounds.forEach((round, index) => {
    const result = roundErrors(round, index)
    errors.push(...result.errors)
    const last = index === rounds.length - 1
    if (last && result.blocking > 0) {
      errors.push(index + 1 < MAX_ROUNDS
        ? `rounds[${index}]: the last round has ${result.blocking} blocking finding(s): fix them and run another round`
        : `rounds[${index}]: round ${MAX_ROUNDS} still has ${result.blocking} blocking finding(s): no GO for this change; split or rework it and start the gate again at round 1`)
    }
    if (!last && result.blocking === 0) errors.push(`rounds[${index}]: a round with no blocking finding ends the loop, so it must be the last`)
  })
  const go = isRecord(record.go) ? record.go : {}
  if (!VERDICTS.includes(go.verdict)) errors.push(`go.verdict: one of ${VERDICTS.join(', ')}`)
  else if (go.verdict !== 'GO') errors.push('go.verdict: NO-GO: only a GO is recorded; fix what the final agent named and review again')
  if (!filled(go.reasons)) errors.push('go.reasons: the final agent\'s reasons')
  if (record.recordedAt !== undefined && Number.isNaN(Date.parse(record.recordedAt))) errors.push('recordedAt: not a date')
  return errors
}

/** The record as it is kept: only the fields of the schema, in its order. */
function normalise(record, now) {
  const finding = ({ id, severity, summary, outcome, note }) => ({ id, severity, summary, outcome, note: note ?? '' })
  return {
    tree: record.tree,
    rounds: record.rounds.map(({ round, reviews }) => ({
      round, reviews: reviews.map(({ reviewer, findings }) => ({ reviewer, findings: findings.map(finding) })),
    })),
    go: { verdict: record.go.verdict, reasons: record.go.reasons },
    recordedAt: record.recordedAt ?? now.toISOString(),
  }
}

/** The line a commit message carries: `review gate: 2 rounds, GO`. */
export function summaryLine(record) {
  const rounds = record.rounds.length
  return `review gate: ${rounds} round${rounds === 1 ? '' : 's'}, ${record.go.verdict}`
}

/** Where the record of `tree` is kept. */
export function recordPath(root, tree) {
  return join(root, '.cache', 'ai-review', 'gate', `${tree}.json`)
}

/** `--name <value>` or `--name=<value>` from argv; null when absent, '' when it has no value. */
function option(argv, name) {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`))
  if (at < 0) return null
  return argv[at].includes('=') ? argv[at].slice(name.length + 1) : (argv[at + 1] ?? '')
}

const HOW = 'Run the review gate (CONTRIBUTING.md → "Review gate before commit") on exactly what is staged, then '
  + '`node scripts/ai-review/gate.mjs record --file <record.json>`.'

const SAME = 'The reviews read the working tree, untracked files included, so it must be exactly what is staged: '
  + 'stage, stash or ignore the rest, review that tree, then record.'

/** Why the working tree is not the index (an empty list when it is), so that what the reviews read is what is committed. */
function workingTreeErrors(root) {
  const errors = []
  const diff = spawnSync('git', ['diff', '--quiet'], { cwd: root, encoding: 'utf8' })
  if (diff.status === 1) errors.push('tracked files have unstaged changes (`git diff` is not empty)')
  else if (diff.status !== 0) errors.push('cannot compare the working tree with the index (`git diff --quiet` failed)')
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
  if (untracked === null) errors.push('cannot list the untracked files (`git ls-files --others` failed)')
  else {
    const files = untracked.split('\n').filter(Boolean)
    const more = files.length > 5 ? `, and ${files.length - 5} more` : ''
    if (files.length > 0) errors.push(`untracked files that are not ignored: ${files.slice(0, 5).join(', ')}${more}`)
  }
  return errors
}

/** The stored GO record of `tree`, or `{error}` saying why there is none. */
function readStored(root, tree) {
  const file = recordPath(root, tree)
  if (!existsSync(file)) return { error: `no review gate record for the staged tree ${tree}.` }
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { error: `the record ${file} is not valid JSON.` }
  }
  const errors = validateRecord(record, { tree })
  if (errors.length > 0) return { error: `the record ${file} is not a GO record:\n  ${errors.join('\n  ')}` }
  return { record, file }
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd(), now = new Date() } = {}) {
  const say = (message) => console.log(`review gate: ${message}`)
  const command = argv[0]
  if (!['record', 'check', 'show'].includes(command)) { say('usage: gate.mjs record --file <record.json> | check [--tree <hash>] | show [--tree <hash>]'); return 2 }
  const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim()
  if (!root) { say('not inside a git repository'); return 2 }
  const given = option(argv, '--tree')
  // A record is only ever for the tree staged now: --tree would let one be written for a tree nobody reviewed.
  if (command === 'record' && given !== null) { say('record takes no --tree: it records the staged tree (--tree is for check and show)'); return 2 }
  // The index git is about to commit: GIT_INDEX_FILE (a `git commit -a` or `git commit <paths>`) is honoured.
  const tree = given ?? git(root, ['write-tree'])?.trim()
  if (!tree || !TREE.test(tree)) { say(given === null ? 'cannot read the staged tree (`git write-tree` failed: unmerged paths?)' : `--tree: not a tree hash: ${given}`); return 2 }

  if (command === 'record') {
    const file = option(argv, '--file')
    if (!file) { say('record needs --file <record.json>'); return 2 }
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      say(`cannot read ${file}: ${error.message}`)
      return 2
    }
    const dirty = workingTreeErrors(root)
    if (dirty.length > 0) { say(`refused: ${dirty.join('; ')}.\n${SAME}`); return 1 }
    const errors = validateRecord(record, { tree })
    if (errors.length > 0) { say(`refused:\n  ${errors.join('\n  ')}`); return 1 }
    const kept = normalise(record, now)
    const out = recordPath(root, tree)
    mkdirSync(join(root, '.cache', 'ai-review', 'gate'), { recursive: true })
    writeFileSync(out, `${JSON.stringify(kept, null, 2)}\n`)
    say(`recorded ${out}`)
    console.log(summaryLine(kept))
    return 0
  }

  const stored = readStored(root, tree)
  if (stored.error) { say(`${stored.error}\n${HOW}`); return 1 }
  if (command === 'check') { say(`GO recorded for the staged tree ${tree.slice(0, 12)} (${summaryLine(stored.record)})`); return 0 }
  console.log(JSON.stringify(stored.record, null, 2))
  console.log(summaryLine(stored.record))
  return 0
}

/** Whether node was started with this file, both sides compared by real path. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

// By real path on both sides: through a symlinked folder argv[1] keeps the link, and under --preserve-symlinks-main
// import.meta.url keeps it too; a one-sided comparison would then exit 0 without checking anything. The pre-commit
// hook does not rely on this guard: it imports main() and requires its answer.
if (isMain()) process.exitCode = main()
