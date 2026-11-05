/**
 * What the pull request AI review gets to see beyond the diff, and how hard it looks: all read from git objects of the
 * fetched pull request, nothing checked out or run.
 *
 *   - riskTier: quick (documentation only), standard, or deep (the review, CI, IAM and stacks, data deletion and the
 *     AI-writing guard), from the changed paths, never from the author.
 *   - reviewRange: review only the commits since the last review when that is a clean extension of what was reviewed;
 *     otherwise (history rewritten, base merged in) the whole diff again.
 *   - contextFiles: the current text of the changed files and of the repository files the change names by path, within
 *     a character budget, so a finding can be checked against the code instead of guessed from the diff.
 */
import { REVIEW_PATHSPEC } from './lib.mjs'

/** Paths whose change gets the deep review. Prefixes end with `/`; the rest match the whole path. */
const DEEP_PATHS = Object.freeze([
  '.github/', 'tools/ai-review-ci/', 'scripts/ai-review/', 'scripts/pr-checks/', '.kiro/agents/', 'voc-datalake/lib/stacks/',
  'TENETS.md', 'REVIEW.md', 'voc-datalake/lambda/shared/ai_writing.py',
])
/** Data deletion and authentication code, wherever it lives in the Lambdas. */
const DEEP_LAMBDA = /^voc-datalake\/lambda\/(?:.*\/)?(?:auth\/|[^/]*(?:retention|erasure|delete))/i
/** Documentation that is NOT quick: it changes what the reviewers and contributors are held to. */
const POLICY_DOCS = Object.freeze(['TENETS.md', 'REVIEW.md', 'CONTRIBUTING.md'])

const isDeep = (path) => DEEP_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p)) || DEEP_LAMBDA.test(path)
const isDoc = (path) => !POLICY_DOCS.includes(path) && !path.startsWith('.kiro/')
  && (path.endsWith('.md') || path.startsWith('docs/') || path === 'LICENSE')

/** `{tier, sensitive}`: deep when any path is sensitive (listed in `sensitive`), quick when every path is docs. */
export function riskTier(paths) {
  const sensitive = paths.filter(isDeep)
  if (sensitive.length > 0) return { tier: 'deep', sensitive }
  if (paths.length > 0 && paths.every(isDoc)) return { tier: 'quick', sensitive: [] }
  return { tier: 'standard', sensitive: [] }
}

/** The output budget and context of each tier. Quick reviews are short; deep ones read more and may answer longer. */
export const TIERS = Object.freeze({
  quick: Object.freeze({ maxTokens: 8_000, maxContinuations: 1, contextChars: 30_000 }),
  standard: Object.freeze({ maxTokens: 24_000, maxContinuations: 2, contextChars: 80_000 }),
  deep: Object.freeze({ maxTokens: 32_000, maxContinuations: 2, contextChars: 150_000 }),
})

/** Said to the model, after the CI preamble. */
export function tierNote({ tier, sensitive }) {
  if (tier === 'quick') return '## Depth: quick\n\nThis change touches documentation only. Keep the review short: check that what it says is true of the files you are shown, and do not invent work.\n\n'
  if (tier === 'deep') {
    return `## Depth: deep\n\nThis change touches sensitive paths (${sensitive.slice(0, 12).join(', ')}${sensitive.length > 12 ? ', …' : ''}): the review itself, CI, permissions, stacks, data deletion or the AI-writing guard. Review those files with extra care: trust boundaries, least privilege, what runs with which credentials, and what a mistake would delete or expose.\n\n`
  }
  return ''
}

/** Changed paths between `base` and `head`, review pathspec applied. */
export function changedPaths(git, root, base, head) {
  return (git(root, ['diff', '--name-only', base, head, '--', ...REVIEW_PATHSPEC]) ?? '').split('\n').filter(Boolean)
}

/**
 * `{mode: 'incremental', from}` when `previousSha` is an ancestor of `head` AND the pull request still forks from the
 * base where it did (no rebase, no base merged in), so the commits since it are exactly the author's new work.
 * Otherwise `{mode: 'full', reason}`.
 */
export function reviewRange(git, root, { previousSha, base, head }) {
  if (!previousSha) return { mode: 'full', reason: 'first review' }
  if (git(root, ['cat-file', '-e', `${previousSha}^{commit}`]) === null) return { mode: 'full', reason: `the last reviewed commit ${previousSha.slice(0, 12)} is no longer in the history (rewritten)` }
  if (git(root, ['merge-base', '--is-ancestor', previousSha, head]) === null) return { mode: 'full', reason: `the history was rewritten since ${previousSha.slice(0, 12)}` }
  const forkNow = git(root, ['merge-base', base, head])?.trim()
  const forkThen = git(root, ['merge-base', base, previousSha])?.trim()
  if (!forkNow || forkNow !== forkThen) return { mode: 'full', reason: 'the base branch was merged in since the last review' }
  return { mode: 'incremental', from: previousSha }
}

// A repository path as docs and diffs write it: at least one directory and a file extension.
const PATH_IN_TEXT = /(?:^|[\s`'"(\[<:=])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'")\]>:,;#])/gm
const MAX_REFERENCED = 25

/** Repository paths named in `text`, resolved against `tree` (exact, else a unique path ending with it). */
export function referencedPaths(text, tree) {
  const resolve = (name) => {
    if (tree.has(name)) return name
    const tails = [...tree].filter((candidate) => candidate.endsWith(`/${name}`))
    return tails.length === 1 ? tails[0] : null
  }
  const found = []
  for (const match of String(text).matchAll(PATH_IN_TEXT)) {
    const name = match[1].replace(/^\.\//, '')
    // A diff header writes `a/<path>` and `b/<path>`: try the name as written first, then without that prefix.
    const path = resolve(name) ?? (/^[ab]\//.test(name) ? resolve(name.slice(2)) : null)
    if (path !== null && !found.includes(path)) found.push(path)
    if (found.length >= MAX_REFERENCED) break
  }
  return found
}

const MAX_FILE_CHARS = 40_000

// The empty tree of a SHA-1 repository (GitHub's): a diff from it lists every file at `head`, and unlike `ls-tree` a
// diff takes the review pathspec's exclude (`:!`) entries.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * `{text, included, skipped}`: the head version of `paths` (changed files first, then referenced ones), each clipped to
 * MAX_FILE_CHARS, until `maxChars` is spent. Only paths the review pathspec allows (no secrets, lockfiles, builds,
 * translations or images) and no binary content.
 */
export function contextFiles(git, root, head, { changed, referenced, maxChars }) {
  const allowed = new Set((git(root, ['diff', '--name-only', '--no-renames', EMPTY_TREE, head, '--', ...REVIEW_PATHSPEC]) ?? '').split('\n').filter(Boolean))
  const included = []
  const skipped = []
  const parts = []
  let budget = maxChars
  for (const path of [...new Set([...changed, ...referenced])]) {
    if (!allowed.has(path)) continue
    const content = git(root, ['show', `${head}:${path}`])
    if (content === null || content.includes('\u0000')) continue
    const body = content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n[cut: ${content.length - MAX_FILE_CHARS} more characters]` : content
    const part = `===== ${path} =====\n${body.trimEnd()}\n`
    if (part.length > budget) { skipped.push(path); continue }
    parts.push(part)
    included.push(path)
    budget -= part.length
  }
  return { text: parts.join('\n'), included, skipped }
}
