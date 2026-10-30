/**
 * The two extra things a FIX pull request must say: which test proves the fix, and where else the same
 * defect could live.
 *
 * Why it exists: a fix without a test that fails before it tends to come back, and a defect found in one
 * place is often copied in its siblings. Writing both down in the PR makes the reviewer's two first
 * questions answerable from the description.
 *
 * `Proof:` (exactly one line, in `## Tests`):
 *   Proof: `path/to/test_file.py::test_name` fails without the fix
 *   Proof: `a.test.ts > case` and `b_test.py` fail without the fix
 *   Proof: not provable -- <reason>: <what was checked instead>
 * with <reason> one of NOT_PROVABLE_REASONS.
 *
 * `## Sibling sweep`: either one line `Siblings: none -- <why>`, or one list entry per site:
 *   - `path/to/file.py:120` -- changed here         (the path must be among the PR's changed files)
 *   - `path/to/other.ts` -- follow-up #123           (an issue or PR number, or a URL)
 *   - `path/to/third.py` -- not affected: <why>
 *
 * Limits: this checks the FORM only. It cannot tell whether the named test really fails without the fix,
 * whether the sweep was thorough, or whether a "not provable" reason is honest. Path checks need the PR
 * head's file list and the changed files list; when the caller cannot supply them, those checks are
 * skipped and a notice says so.
 */
import { contentLines, plainLine } from './markdown.mjs'

export const NOT_PROVABLE_REASONS = Object.freeze({
  'deployed-only': 'the defect shows only on a deployed stack (say which deployed check was run)',
  'external-service': 'it depends on a third-party or AWS behaviour that cannot be faked faithfully',
  nondeterministic: 'a race or timing defect that a test cannot reproduce reliably',
  'no-runtime-behaviour': 'docs, configuration text or tooling output with no executable behaviour',
  'test-only': 'the fix is to a test itself; the corrected test is the proof',
})

const DASH = '(?:--|\u2014)'
const PROOF_TESTS = /^proof:\s*(`[^`]+`(?:(?:\s*[,;]\s*(?:and\s+)?|\s+and\s+)`[^`]+`)*)\s+fails?\s+without\s+(?:the|this)\s+fix\b/i
const PROOF_NONE = new RegExp(`^proof:\\s*not provable\\s*${DASH}\\s*([^:\\s][^:]*):\\s*(.*)$`, 'i')
const SIBLINGS_NONE = new RegExp(`^siblings:\\s*none\\b\\s*(?:${DASH}\\s*(.*))?$`, 'i')
const ENTRY = new RegExp(`^\`([^\`]+)\`\\s*(?:${DASH}\\s*(.*))?$`)
const FOLLOW_UP = /^follow-up\s+(?:#\d+|https:\/\/\S+)/i
const NOT_AFFECTED = /^not affected:\s*(.*)$/i
const MIN_REASON_WORDS = 3

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length

/** `path/x.py:12:3` -> `path/x.py`; also drops a test name after `::`, ` > ` or `#`. */
export function pathOf(reference) {
  const head = reference.split(/::| > |#/)[0].trim()
  return head.replace(/:\d+(?::\d+)?$/, '').replace(/\/+$/, '')
}

const looksLikePath = (path) => path.includes('/') || /\.[A-Za-z0-9]+$/.test(path)

/** A file in the tree, or a directory holding one. */
export function existsIn(tree, path) {
  if (tree.has(path)) return true
  const prefix = `${path}/`
  for (const file of tree) if (file.startsWith(prefix)) return true
  return false
}

/** " (did you mean `voc-datalake/x`?)" when exactly one tree file ends with `/path`. */
function suggestion(tree, path) {
  const matches = [...tree].filter((file) => file.endsWith(`/${path}`))
  return matches.length === 1 ? ` (did you mean \`${matches[0]}\`? Paths are from the repository root)` : ''
}

function checkPath(path, context, ctx, problems) {
  if (ctx.headTree === null) return
  if (!existsIn(ctx.headTree, path)) {
    problems.push(`${context}: \`${path}\` does not exist in the PR head${suggestion(ctx.headTree, path)}`)
  }
}

/** Problems with the `Proof:` line(s) of the `## Tests` section. */
export function proofProblems(testsSection, ctx) {
  const proofs = contentLines(testsSection).map(plainLine).filter((line) => /^proof:/i.test(line))
  if (proofs.length === 0) {
    return ['Tests: a fix PR needs one `Proof:` line naming the test that fails without the fix, or `Proof: not provable -- <reason>: <detail>`']
  }
  if (proofs.length > 1) return [`Tests: found ${proofs.length} \`Proof:\` lines; write exactly one (it may name several tests)`]
  const line = proofs[0]
  const none = PROOF_NONE.exec(line)
  if (none !== null) {
    const reason = none[1].trim().toLowerCase()
    if (!Object.hasOwn(NOT_PROVABLE_REASONS, reason)) {
      return [`Tests: "${reason}" is not a known not-provable reason; use one of: ${Object.keys(NOT_PROVABLE_REASONS).join(', ')}`]
    }
    return words(none[2]) < MIN_REASON_WORDS ? ['Tests: `Proof: not provable` needs a detail after the reason (what was checked instead)'] : []
  }
  const tests = PROOF_TESTS.exec(line)
  if (tests === null) {
    return ['Tests: the `Proof:` line must read "Proof: `<test file>::<test>` fails without the fix" or "Proof: not provable -- <reason>: <detail>"']
  }
  const paths = [...tests[1].matchAll(/`([^`]+)`/g)].map((match) => pathOf(match[1])).filter(looksLikePath)
  if (paths.length === 0) return ['Tests: the `Proof:` line must name the test FILE (repository-root path), not only a test name']
  const problems = []
  for (const path of paths) checkPath(path, 'Tests: Proof', ctx, problems)
  return problems
}

function entryProblems(path, status, ctx) {
  const problems = []
  const label = `Sibling sweep: \`${path}\``
  if (/^changed here\b/i.test(status)) {
    checkPath(path, 'Sibling sweep', ctx, problems)
    const changed = ctx.changedFiles
    if (changed !== null && !changed.has(path) && ![...changed].some((file) => file.startsWith(`${path}/`))) {
      problems.push(`${label} says "changed here" but is not among the PR's changed files`)
    }
    return problems
  }
  const notAffected = NOT_AFFECTED.exec(status)
  if (notAffected !== null) {
    if (words(notAffected[1]) < MIN_REASON_WORDS) problems.push(`${label}: "not affected:" needs a reason`)
  } else if (!FOLLOW_UP.test(status)) {
    problems.push(`${label}: the status must be "changed here", "follow-up #<n>" (or a URL) or "not affected: <why>"`)
  }
  checkPath(path, 'Sibling sweep', ctx, problems)
  return problems
}

/** Problems with the `## Sibling sweep` section of a fix PR. */
export function siblingProblems(section, ctx) {
  if (section === null) return ['a fix PR needs a "## Sibling sweep" section (other sites with the same defect, or `Siblings: none -- <why>`)']
  const lines = contentLines(section).map(plainLine)
  const none = lines.map((line) => SIBLINGS_NONE.exec(line)).filter((match) => match !== null)
  const entries = lines.map((line) => ENTRY.exec(line)).filter((match) => match !== null)
  if (none.length > 0 && entries.length > 0) return ['Sibling sweep: write either `Siblings: none -- <why>` or a list of sites, not both']
  if (none.length > 1) return ['Sibling sweep: write `Siblings: none -- <why>` once']
  if (none.length === 1) {
    return words(none[0][1]) < MIN_REASON_WORDS ? ['Sibling sweep: `Siblings: none` needs a reason after `--` (how you looked)'] : []
  }
  if (entries.length === 0) {
    return ['Sibling sweep: list each site as "- `path` -- changed here | follow-up #<n> | not affected: <why>", or write `Siblings: none -- <why>`']
  }
  return entries.flatMap((match) => entryProblems(pathOf(match[1]), (match[2] ?? '').trim(), ctx))
}
