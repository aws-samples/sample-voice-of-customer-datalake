#!/usr/bin/env node
/**
 * The review gate: a commit lands only with a GO record for exactly the tree it commits.
 *
 * Before a commit, the change goes through at most three review rounds (the tenets and commit AI reviews of
 * validate.sh, plus security, quality and first-principles reviewers), and a final reviewer that wrote none of it
 * answers GO or NO-GO. This script keeps the outcome: `record` checks a record of those rounds and stores it under
 * `.cache/ai-review/gate/<tree>.json`, keyed by `git write-tree` of the index, so it covers exactly what is staged;
 * `check` (the pre-commit hook, scripts/git-hooks/pre-commit) refuses a commit whose staged tree has no valid GO
 * record. Restaging anything changes the tree, so a record covers exactly the staged tree. What the reviewers saw of
 * that tree is theirs to say: the tenets and commit reviews leave out lockfiles, locale files and secret-shaped paths
 * and cut a long diff (scripts/ai-review/lib.mjs), while the reviewer subagents get the whole diff.
 *
 * Record (JSON):
 *   { "change": "<one line>",
 *     "rounds": [ { "findings": [ { "source": "tenets|commit|security|quality|first-principles",
 *                                   "id": "<id>", "severity": "blocking|should-fix|nit|advisory",
 *                                   "title": "<one line>", "outcome": "fixed|rejected|deferred",
 *                                   "note": "<why, required unless fixed>" } ] } ],
 *     "go": { "verdict": "GO", "reasons": "<why>" } }
 *
 * Rules: one to three rounds; the last round has no blocking finding (a round without one may end the loop; one more
 * round after it, say one that adds a reviewer, is more review and allowed); a
 * blocking finding of an earlier round was fixed; every finding has an id, a title and an outcome, and one not fixed
 * says why; the final verdict is GO with its reasons.
 *
 * Severities, from what the reviewers print: `blocking` = a tenets VIOLATION, a commit MUST-FIX, a security
 * CRITICAL, a quality BLOCKING; `should-fix` = SHOULD-FIX, a security WARNING, a quality MISSING-TEST; `nit` = NIT;
 * `advisory` = a CONCERN, a SUGGESTION, a security NOTE, a first-principles SUBTRACT or SIMPLIFY.
 *
 * Usage: node scripts/ai-review/gate.mjs record <record.json> | check
 *   record: validate and store the record for the staged tree. Refused when the working tree is not exactly the
 *           index (an unstaged edit or an untracked file): the reviews read the working tree.
 *   check:  exit 0 when the staged tree has a valid GO record and print the commit message line
 *           ("review gate: N rounds, GO"), else exit 1 and say why
 * Records stay local (.cache/ is ignored); they are evidence for this clone, not part of the change. Once installed,
 * the hook gates every `git commit` of the clone, on every branch (a clean merge, cherry-pick, rebase or revert runs
 * no pre-commit hook); `git commit --no-verify` skips it, so the gate is a discipline the hook reminds of, not a lock.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ROUNDS = 3
const SOURCES = new Set(['tenets', 'commit', 'security', 'quality', 'first-principles'])
const SEVERITIES = new Set(['blocking', 'should-fix', 'nit', 'advisory'])
const OUTCOMES = new Set(['fixed', 'rejected', 'deferred'])

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const filled = (value) => typeof value === 'string' && value.trim() !== ''

/** The problems of one finding, `where` naming it in the messages. */
function findingProblems(finding, where) {
  if (!isRecord(finding)) return [`${where}: not an object`]
  const problems = []
  if (!SOURCES.has(finding.source)) problems.push(`${where}: source must be one of ${[...SOURCES].join(', ')}`)
  if (!filled(finding.id)) problems.push(`${where}: no id`)
  if (!SEVERITIES.has(finding.severity)) problems.push(`${where}: severity must be one of ${[...SEVERITIES].join(', ')}`)
  if (!filled(finding.title)) problems.push(`${where}: no title`)
  if (!OUTCOMES.has(finding.outcome)) problems.push(`${where}: outcome must be one of ${[...OUTCOMES].join(', ')}`)
  if (finding.outcome !== 'fixed' && !filled(finding.note)) problems.push(`${where}: an outcome other than fixed needs a note saying why`)
  return problems
}

/** Every reason `record` is not a valid GO record; empty when it is. */
function recordProblems(record) {
  if (!isRecord(record)) return ['the record is not a JSON object']
  const problems = []
  if (!filled(record.change)) problems.push('change: no one-line description')
  const rounds = Array.isArray(record.rounds) ? record.rounds : []
  if (rounds.length < 1 || rounds.length > MAX_ROUNDS) problems.push(`rounds: ${rounds.length}, must be 1 to ${MAX_ROUNDS}`)
  rounds.forEach((round, r) => {
    const findings = isRecord(round) && Array.isArray(round.findings) ? round.findings : null
    if (findings === null) { problems.push(`round ${r + 1}: no findings list (use [] for none)`); return }
    const last = r === rounds.length - 1
    findings.forEach((finding, f) => {
      const where = `round ${r + 1} finding ${f + 1}`
      problems.push(...findingProblems(finding, where))
      if (finding?.severity !== 'blocking') return
      if (last) problems.push(`${where}: the last round still has a blocking finding; run another round or rework the change`)
      else if (finding.outcome !== 'fixed') problems.push(`${where}: a blocking finding must be fixed, not ${String(finding.outcome)}`)
    })
  })
  const go = isRecord(record.go) ? record.go : {}
  if (go.verdict !== 'GO') problems.push(`go: the final verdict is ${JSON.stringify(go.verdict ?? null)}, not GO: do not commit`)
  if (!filled(go.reasons)) problems.push('go: no reasons')
  return problems
}

/** The repository root and the tree the index would commit. */
function stagedTree() {
  return { root: git('rev-parse', '--show-toplevel'), tree: git('write-tree') }
}

const recordPath = (root, tree) => join(root, '.cache', 'ai-review', 'gate', `${tree}.json`)

/** True when `git <args>` exits non-zero (the `--quiet` diffs answer "there is a difference" that way). */
function differs(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}

/**
 * Why the working tree is not exactly the index, or ''. The reviews read the working tree (untracked files too), the
 * record keys on the index: they must be the same, or a GO could cover staged code the reviews never saw.
 */
function workingTreeMismatch() {
  if (differs(['diff', '--quiet'])) return 'the working tree has unstaged changes: stage them (or drop them) and review again'
  // `:/` and --full-name: the whole repository, wherever in it the command runs.
  if (git('ls-files', '--others', '--exclude-standard', '--full-name', ':/') !== '') return 'the working tree has untracked files: stage them (or remove them) and review again'
  return ''
}

function fail(lines) {
  for (const line of lines) console.error(`review gate: ${line}`)
  process.exit(1)
}

function record(file) {
  if (!filled(file)) fail(['usage: gate.mjs record <record.json>'])
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail([`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`])
  }
  const problems = recordProblems(parsed)
  if (problems.length > 0) fail(problems)
  const mismatch = workingTreeMismatch()
  if (mismatch !== '') fail([mismatch])
  const { root, tree } = stagedTree()
  const path = recordPath(root, tree)
  mkdirSync(join(root, '.cache', 'ai-review', 'gate'), { recursive: true })
  // The computed tree and time last: a `tree` key in the input can never stand in for the staged one.
  writeFileSync(path, `${JSON.stringify({ ...parsed, tree, recorded_at: new Date().toISOString() }, null, 2)}\n`)
  console.log(`review gate: GO recorded for tree ${tree} (${parsed.rounds.length} rounds)`)
}

/** The stored record of the staged tree, or the reasons there is none that counts. */
function storedRecord() {
  const { root, tree } = stagedTree()
  const path = recordPath(root, tree)
  if (!existsSync(path)) return { problems: [`no GO record for the staged tree ${tree}: run the review gate on exactly this change`] }
  let stored
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { problems: [`the record ${path} is not valid JSON`] }
  }
  const problems = recordProblems(stored)
  if (!isRecord(stored)) return { problems }
  if (stored.tree !== tree) problems.push(`the record names tree ${String(stored.tree)}, not the staged ${tree}`)
  return { stored, problems }
}

function check() {
  const { stored, problems } = storedRecord()
  if (problems.length > 0) fail([...problems, 'the commit is refused (scripts/ai-review/gate.mjs)'])
  console.log(`review gate: ${stored.rounds.length} rounds, GO`)
}

const [command, argument] = process.argv.slice(2)
if (command === 'record') record(argument)
else if (command === 'check') check()
else fail(['usage: gate.mjs record <record.json> | check'])
