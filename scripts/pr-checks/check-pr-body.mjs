#!/usr/bin/env node
/**
 * Checks that a pull request description follows .github/PULL_REQUEST_TEMPLATE.md well enough for a
 * reviewer to start from it: the goal in one line, what is out of scope, what changed, whether it is
 * compatible, what ran, and which release it is. A FIX pull request also names the test that proves the
 * fix (`Proof:`) and the other sites checked for the same defect (`## Sibling sweep`); fix-rules.mjs.
 *
 * Which PRs are fixes: the release section the PR adds to CHANGELOG.md has a `### Fixed` group. Titles
 * start with a version here, so a title prefix cannot say; the CHANGELOG group is the author's own
 * classification, made anyway for every release (.kiro/steering/changelog.md). A release that bundles
 * several fixes writes ONE `Proof:` line (it may name several tests) and ONE sweep, not one per bullet.
 *
 * Inputs (environment): PR_BODY, PR_TITLE, PR_DRAFT ('true' skips), PR_AUTHOR (bots in SKIPPED_AUTHORS
 * skip), PR_CHECK_ENFORCED ('true' = problems fail the job; anything else = warnings only).
 * Optional files (arguments): --changed-files <one path per line>, --head-tree <every file of the PR
 * head, one per line>, --base-changelog / --head-changelog <CHANGELOG.md at the base and head>.
 * A missing file turns the checks that need it off, with a notice.
 *
 * Limits: FORM only, never truth. It cannot tell whether the goal is the real goal, whether the named
 * test fails without the fix, whether "Compatible" is right, or whether `bash scripts/validate.sh` ran.
 * It reads Markdown the simple way markdown.mjs describes.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { contentLines, findSection, plainLine, sections } from './markdown.mjs'
import { addedReleases, addsGroup } from './changelog.mjs'
import { proofProblems, siblingProblems } from './fix-rules.mjs'
import { tenetsProblems } from './tenets.mjs'

export const REQUIRED_SECTIONS = Object.freeze([
  'Goal', 'Why it matters', 'Not a goal', 'What changed', 'Backwards compatibility', 'Tests', 'Release',
])
export const SKIPPED_AUTHORS = Object.freeze(['dependabot[bot]'])
const MIN_GOAL_WORDS = 4
const VERSION = /\b\d+\.\d{2}\.\d{2}\b/
const BUMP = /\b(?:major|minor|patch)\b/i
const PLACEHOLDER = /^<[^>]*>$|^(?:tbd|todo|n\/a|\.\.\.)$/i

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length

function goalProblems(all) {
  const goals = contentLines(findSection(all, 'Goal')).map(plainLine).filter((line) => /^goal:/i.test(line))
  if (goals.length !== 1) return ['Goal: write exactly one line `**Goal:** <one sentence, in the user\'s terms>`']
  const text = goals[0].slice(5).trim()
  if (PLACEHOLDER.test(text) || words(text) < MIN_GOAL_WORDS) {
    return [`Goal: the goal line needs a real sentence (at least ${MIN_GOAL_WORDS} words), not a placeholder`]
  }
  return []
}

function compatibilityProblems(all, added) {
  const first = plainLine(contentLines(findSection(all, 'Backwards compatibility'))[0] ?? '')
  const match = /^(compatible|breaking):\s*(\S.*)?$/i.exec(first)
  if (match === null || match[2] === undefined) {
    return ['Backwards compatibility: start with `Compatible: <why>` or `Breaking: <what breaks>`']
  }
  if (match[1].toLowerCase() === 'breaking' && added !== null && !addsGroup(added, 'Upgrade notes')) {
    return ['Backwards compatibility: a breaking PR needs an `### Upgrade notes` group in its CHANGELOG.md release section']
  }
  return []
}

function releaseProblems(all, title, added) {
  const text = contentLines(findSection(all, 'Release')).join(' ')
  const problems = []
  if (!VERSION.test(text) || !BUMP.test(text)) {
    problems.push('Release: name the version (`X.YY.ZZ`) and the bump kind (major, minor or patch)')
  }
  const newest = added?.[0]?.version
  if (newest !== undefined) {
    if (!text.includes(newest)) problems.push(`Release: the PR adds CHANGELOG.md section ${newest}; name that version`)
    if (!String(title ?? '').includes(newest)) problems.push(`Title: start the title with the release, e.g. "${newest}: <what it does>"`)
  }
  return problems
}

/**
 * The verdict for one pull request: `{status: 'pass'|'fail'|'skip', isFix, errors[], notices[]}`.
 * `changedFiles`, `headTree` are Sets or null; the changelogs are strings or null.
 */
export function checkPrBody({ body, title, draft, author, changedFiles = null, headTree = null, baseChangelog = null, headChangelog = null }) {
  const notices = []
  if (draft === true) return { status: 'skip', isFix: false, errors: [], notices: ['Draft PR: the description is checked once it is ready for review'] }
  if (SKIPPED_AUTHORS.includes(author)) return { status: 'skip', isFix: false, errors: [], notices: [`${author} writes its own description; not checked`] }

  const all = sections(body)
  const errors = REQUIRED_SECTIONS.filter((name) => findSection(all, name) === null)
    .map((name) => `missing section "## ${name}" (headings inside code fences or HTML comments do not count)`)
  for (const name of ['Why it matters', 'Not a goal', 'What changed', 'Tests']) {
    const section = findSection(all, name)
    if (section !== null && contentLines(section).length === 0) errors.push(`${name}: the section is empty`)
  }
  if (findSection(all, 'Goal') !== null) errors.push(...goalProblems(all))
  errors.push(...tenetsProblems(all))
  const added = addedReleases(baseChangelog, headChangelog)
  if (added === null) notices.push('CHANGELOG.md of the PR head is unknown: fix and breaking-change rules not applied')
  else if (added.length === 0) notices.push('CHANGELOG.md gains no release section; every PR to main adds one (.kiro/steering/changelog.md)')
  if (findSection(all, 'Backwards compatibility') !== null) errors.push(...compatibilityProblems(all, added))
  if (findSection(all, 'Release') !== null) errors.push(...releaseProblems(all, title, added))

  const isFix = addsGroup(added, 'Fixed')
  if (isFix) {
    if (headTree === null) notices.push('PR head file list unknown: path existence not checked')
    if (changedFiles === null) notices.push('changed files unknown: "changed here" entries not checked')
    const ctx = { headTree, changedFiles }
    const tests = findSection(all, 'Tests')
    if (tests !== null) errors.push(...proofProblems(tests, ctx))
    errors.push(...siblingProblems(findSection(all, 'Sibling sweep'), ctx))
  }
  return { status: errors.length === 0 ? 'pass' : 'fail', isFix, errors, notices }
}

/** A workflow-command message with %, CR and LF escaped (GitHub's documented encoding). */
export function escapeCommand(message) {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

/** `--name value` pairs from argv. */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`expected "--name value", got ${JSON.stringify(argv[i])}`)
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

const readOptional = (path) => (path !== undefined && existsSync(path) ? readFileSync(path, 'utf8') : null)
function readSet(path) {
  const text = readOptional(path)
  return text === null ? null : new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
}

function summary(result, enforced) {
  const mode = enforced ? 'enforced' : 'advisory'
  const head = `### PR description check: ${result.status} (${mode}${result.isFix ? ', fix PR' : ''})\n\n`
  const list = (items) => items.map((item) => `- ${item}`).join('\n')
  const errors = result.errors.length > 0 ? `${list(result.errors)}\n\nTemplate: .github/PULL_REQUEST_TEMPLATE.md\n` : ''
  const notices = result.notices.length > 0 ? `\nNotes:\n${list(result.notices)}\n` : ''
  return head + errors + notices
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = process.env
  const enforced = env.PR_CHECK_ENFORCED === 'true'
  const result = checkPrBody({
    body: env.PR_BODY ?? '',
    title: env.PR_TITLE ?? '',
    draft: env.PR_DRAFT === 'true',
    author: env.PR_AUTHOR ?? '',
    changedFiles: readSet(args['changed-files']),
    headTree: readSet(args['head-tree']),
    baseChangelog: readOptional(args['base-changelog']),
    headChangelog: readOptional(args['head-changelog']),
  })
  const level = enforced ? 'error' : 'warning'
  for (const error of result.errors) console.log(`::${level} title=PR description::${escapeCommand(error)}`)
  for (const notice of result.notices) console.log(`::notice title=PR description::${escapeCommand(notice)}`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(result, enforced))
  console.log(`PR description check: ${result.status}${result.errors.length > 0 && !enforced ? ' (advisory: not failing the job)' : ''}`)
  process.exitCode = result.status === 'fail' && enforced ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
