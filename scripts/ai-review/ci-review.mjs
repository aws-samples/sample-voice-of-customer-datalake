#!/usr/bin/env node
/**
 * The pull request AI review, run by .github/workflows/ai-review.yml: the tenets review and the code review of
 * `npm run validate:tenets` / `npm run validate:commit`, by Claude on Amazon Bedrock, as one pull request comment.
 *
 *   node scripts/ai-review/ci-review.mjs --repo <git dir> --prompts-root <dir> --event <event.json>
 *     [--issue-comments <json>] [--review-comments <json>] [--out <comment.md>]
 *
 * --repo         a git repository holding refs/pr/base (the base branch) and refs/pr/head (the pull request). The
 *                change is read from git objects only: nothing of the pull request is checked out or run.
 * --prompts-root the TRUSTED checkout of the default branch: TENETS.md and .kiro/agents/prompts/ come from there, so
 *                a pull request cannot rewrite the review it gets.
 * --event        $GITHUB_EVENT_PATH: the pull request's number, head SHA, title and description.
 * --issue-comments / --review-comments
 *                `gh api --paginate --slurp` of the conversation and of the inline review comments.
 *
 * The model has NO tools (CI_PREAMBLE in ci-lib.mjs): Bedrock Converse is called through the AWS CLI with the
 * credentials in the environment (the workflow's OIDC role, tools/ai-review-ci/). The two reviews run in parallel.
 *
 * A push that leaves the diff unchanged (a rebase onto a moved base with the same change) is not reviewed again: the
 * marker of the last comment carries the diff's hash. Writes `comment=true|false` and the `body` to $GITHUB_OUTPUT.
 *
 * Env: AI_REVIEW_MODEL (default global.anthropic.claude-opus-5-5), AWS_REGION (default us-east-1),
 * AI_REVIEW_ENFORCED ('true': exit 1 on a complete VIOLATION or MUST-FIX; anything else: advisory, exit 0).
 * A Bedrock failure is a warning in the log, never a failed check.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CI_PREAMBLE, converseLong, diffHash, followUpPreamble, latestReview, prContext, readComments, renderComment, REVIEW_ORDER, reviewRounds, writeOutput } from './ci-lib.mjs'
import { changedPaths, contextFiles, referencedPaths, reviewRange, riskTier, tierNote, TIERS } from './context.mjs'
import { advanceLedger, emptyLedger, encodeLedger, passVerdict, previousFindingsBlock, stripStatusLines } from './ledger.mjs'
import { buildPrompt, capDiff, KINDS, parseVerdict } from './lib.mjs'
import { collectChange, git } from './review.mjs'

export const DEFAULT_MODEL = 'global.anthropic.claude-opus-5-5'
// The output budget per pass is the depth's (TIERS in context.mjs): reasoning shares it with the answer and grows
// with the diff, and 8K cut real reviews of 77 KB diffs short, so standard and deep reviews get 24K and 32K, and a
// longer answer is continued, then disclosed as cut.
// The time budget, inside the job's `timeout-minutes: 30`. Every AWS CLI call (retries included) is killed when the
// review's REVIEW_BUDGET_MS is spent, and no continuation starts after CONTINUE_DEADLINE_MS, so the comment is always
// rendered and the `post` job always runs. Measured: a 22 KB diff answers in 36 s.
const REVIEW_BUDGET_MS = 20 * 60_000
const CONTINUE_DEADLINE_MS = 10 * 60_000
const READ_TIMEOUT_SECONDS = 600

const OPTIONS = Object.freeze({
  '--repo': 'repo', '--prompts-root': 'promptsRoot', '--event': 'event',
  '--issue-comments': 'issueComments', '--review-comments': 'reviewComments', '--out': 'out',
})

/** The options, or `{error}` naming what is wrong. */
export function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = OPTIONS[argv[i]]
    if (key === undefined || argv[i + 1] === undefined) return { error: `unexpected argument ${argv[i]}` }
    options[key] = argv[i + 1]
  }
  const missing = ['repo', 'promptsRoot', 'event'].filter((key) => !options[key])
  return missing.length > 0 ? { error: `missing ${missing.map((key) => Object.keys(OPTIONS).find((flag) => OPTIONS[flag] === key)).join(', ')}` } : options
}

function readJson(path) {
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The pull request fields the review needs, or null when the event is not a pull request event. */
export function pullRequestOf(event) {
  const pr = event?.pull_request
  if (typeof pr !== 'object' || pr === null || !Number.isInteger(pr.number)) return null
  const headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : ''
  if (!/^[0-9a-f]{40}$/.test(headSha)) return null
  return { number: pr.number, headSha, title: typeof pr.title === 'string' ? pr.title : '', body: typeof pr.body === 'string' ? pr.body : '' }
}

/**
 * One Bedrock Converse call through the AWS CLI: resolves the parsed response, rejects with the CLI's first error.
 * `timeoutMs` bounds the whole call, the CLI's own retries included: past it the CLI is killed and the call rejects.
 */
export function bedrockCall(request, { region, env = process.env, timeoutMs = REVIEW_BUDGET_MS }) {
  if (!(timeoutMs > 0)) return Promise.reject(new Error('no time left in the review budget'))
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-'))
  const file = join(dir, 'request.json')
  writeFileSync(file, JSON.stringify(request), { mode: 0o600 })
  const args = ['bedrock-runtime', 'converse', '--cli-input-json', `file://${file}`, '--region', region,
    '--output', 'json', '--cli-read-timeout', String(READ_TIMEOUT_SECONDS), '--cli-connect-timeout', '30']
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, {
      env: { AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '3', ...env, AWS_PAGER: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    let settled = false
    let timedOut = false
    // Our own timer, not spawn's `timeout`: that one is never cleared when the spawn fails, and would hold the
    // process open for the whole budget.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, Math.ceil(timeoutMs))
    // A spawn failure emits 'error' and may still emit 'close': settle and clean up once.
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      if (error) reject(error); else resolve(value)
    }
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(`the AWS CLI did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s (the review budget)`))
        return
      }
      if (code !== 0) {
        const first = stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? `exit ${code}`
        finish(new Error(first.slice(0, 300)))
        return
      }
      try {
        finish(null, JSON.parse(stdout))
      } catch {
        finish(new Error('the AWS CLI printed no JSON'))
      }
    })
  })
}

async function runReview(kind, { call, modelId, systemPrefix, promptsRoot, prompt, tier }) {
  const systemPrompt = systemPrefix + readFileSync(join(promptsRoot, `.kiro/agents/prompts/${KINDS[kind].agent}.md`), 'utf8')
  try {
    const answer = await converseLong(call, {
      modelId, systemPrompt, prompt, maxTokens: tier.maxTokens, maxContinuations: tier.maxContinuations, deadlineMs: CONTINUE_DEADLINE_MS,
    })
    return { kind, output: stripStatusLines(answer.text), raw: answer.text, truncated: answer.truncated, verdict: parseVerdict(answer.text, kind) }
  } catch (error) {
    console.log(`::warning title=AI review::the ${kind} review was not run: ${error instanceof Error ? error.message : String(error)}`)
    return { kind, error: true }
  }
}

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** The prompt blocks only CI adds: the repository files and, from round 2, the open findings and the new commits. */
function extraBlocks(kind, { context, ledger, incremental }) {
  return [
    ...(context.text ? [{ tag: 'repository-files', body: context.text, attrs: ' ref="pull request head"' }] : []),
    ...(ledger ? [{ tag: 'previous-findings', body: previousFindingsBlock(ledger, kind) || '(none open)', attrs: ` round="${ledger.round}"` }] : []),
    ...(incremental ? [{ tag: 'changes-since-last-review', body: incremental.text, attrs: ` from="${incremental.from.slice(0, 12)}"` }] : []),
  ]
}

export async function main(argv = process.argv.slice(2), env = process.env, { call } = {}) {
  const say = (message) => console.log(`ai review: ${message}`)
  const skip = (message) => { say(message); writeOutput(env.GITHUB_OUTPUT, 'comment', 'false'); return 0 }
  const options = parseArgs(argv)
  if (options.error) { say(options.error); return 2 }

  const pr = pullRequestOf(readJson(options.event))
  if (pr === null) return skip('skipped: the event is not a pull request with a head SHA')
  const head = 'refs/pr/head'
  const base = git(options.repo, ['merge-base', 'refs/pr/base', head])?.trim()
  if (!base) return skip('skipped: refs/pr/base and refs/pr/head have no merge base (were both fetched?)')
  const change = collectChange(options.repo, base, head)
  if (!change.diff) return skip(`nothing to review since ${base.slice(0, 8)}`)

  const hash = diffHash(change.diff)
  const issueComments = readComments(readJson(options.issueComments))
  const previous = latestReview(issueComments)
  if (previous?.diffhash === hash) return skip(`the diff is the one reviewed at ${previous.sha.slice(0, 12)}: no new review`)

  // A comment from before ledgers existed still counts as a round, with nothing to carry over.
  // (No `reviewed` record either: both passes resume from that comment's commit.)
  const ledger = previous ? (previous.ledger ?? { ...emptyLedger(), reviewed: undefined, round: reviewRounds(issueComments).length }) : null
  // Where each pass resumes: the last commit IT reviewed to the end. A pass that failed or was cut short keeps its
  // older commit (or none), so it reviews the commits it missed; a ledger without this record means both passes ran.
  const resumeFrom = (kind) => (ledger?.reviewed ? (ledger.reviewed[kind] || null) : (previous?.sha ?? null))
  const sinceCache = new Map()
  const planFor = (kind) => {
    let range = reviewRange(git, options.repo, { previousSha: resumeFrom(kind), base: 'refs/pr/base', head })
    if (ledger && resumeFrom(kind) === null) range = { mode: 'full', reason: 'this review did not finish in an earlier round' }
    if (range.mode === 'incremental' && !sinceCache.has(range.from)) sinceCache.set(range.from, collectChange(options.repo, range.from, head))
    const since = range.mode === 'incremental' ? sinceCache.get(range.from) : null
    const incremental = since?.diff ? { ...capDiff(since.diff), from: range.from } : null
    return {
      incremental, commits: (incremental ? since : change).commits,
      range: incremental ? range : { mode: 'full', reason: range.reason ?? 'no new reviewable commits since the last review' },
    }
  }
  const plans = Object.fromEntries(REVIEW_ORDER.map((kind) => [kind, planFor(kind)]))

  const paths = changedPaths(git, options.repo, base, head)
  const tier = riskTier(paths)
  const budget = TIERS[tier.tier]
  // The files to show: what any pass reviews this round (all changed files as soon as one pass reviews the whole diff).
  const reviewedTexts = [...new Set(Object.values(plans).map((plan) => plan.incremental?.text ?? change.diff))]
  const focus = Object.values(plans).some((plan) => !plan.incremental) ? paths
    : [...new Set(Object.values(plans).flatMap((plan) => changedPaths(git, options.repo, plan.incremental.from, head)))]
  const tree = new Set((git(options.repo, ['ls-tree', '-r', '--name-only', head]) ?? '').split('\n').filter(Boolean))
  const context = contextFiles(git, options.repo, head, {
    changed: focus, referenced: referencedPaths(`${reviewedTexts.join('\n')}\n${pr.body}`, tree), maxChars: budget.contextChars,
  })

  const modelId = env.AI_REVIEW_MODEL || DEFAULT_MODEL
  const region = env.AWS_REGION || 'us-east-1'
  // One budget for both reviews (they run in parallel) and every continuation.
  const budgetEnds = Date.now() + REVIEW_BUDGET_MS
  const caller = call ?? ((request) => bedrockCall(request, { region, env, timeoutMs: budgetEnds - Date.now() }))
  const { text, truncated } = capDiff(change.diff)
  const pullRequest = prContext({ title: pr.title, body: pr.body, issueComments, reviewComments: readComments(readJson(options.reviewComments)) })
  const tenets = readFileSync(join(options.promptsRoot, 'TENETS.md'), 'utf8')
  const reviewGuide = readText(join(options.promptsRoot, 'REVIEW.md'))
  const round = (ledger?.round ?? 0) + 1
  const describe = (plan) => (plan.incremental ? `commits since ${plan.incremental.from.slice(0, 8)}` : 'whole diff')
  say(`round ${round} (${REVIEW_ORDER.map((kind) => `${kind}: ${describe(plans[kind])}`).join(', ')}), depth ${tier.tier}, ${context.included.length} repository files, ${modelId}${truncated ? ', diff cut' : ''}...`)
  const results = await Promise.all(REVIEW_ORDER.map((kind) => runReview(kind, {
    call: caller, modelId, promptsRoot: options.promptsRoot, tier: budget,
    systemPrefix: CI_PREAMBLE + tierNote(tier)
      + (ledger ? followUpPreamble({ round, incremental: Boolean(plans[kind].incremental), reason: plans[kind].range.reason }) : ''),
    prompt: buildPrompt({
      kind, tenets, reviewGuide, commits: plans[kind].commits, base: base.slice(0, 12), files: change.files, diff: text,
      truncated, omitted: change.omitted, pullRequest, canRead: false, extra: extraBlocks(kind, { context, ledger, incremental: plans[kind].incremental }),
    }),
  })))
  if (results.every((result) => result.error)) return skip('no review was run (see the warnings above): nothing to post')

  // The STATUS lines are read from the raw answer; the comment shows the answer without them (they are in the recap).
  const { ledger: next, recap } = advanceLedger(ledger, results.map((r) => (r.error ? r : { ...r, output: r.raw })))
  // A pass moves its resume point only when it reviewed this head to the end (no failure, no cut answer).
  next.reviewed = Object.fromEntries(results.map((r) => [r.kind, !r.error && !r.truncated ? pr.headSha : (resumeFrom(r.kind) ?? '')]))
  const verdicts = Object.fromEntries(results.map((r) => [r.kind, passVerdict(recap[r.kind], r.verdict?.verdict)]))
  for (const result of results) say(`${result.kind}: ${result.error ? 'not run' : verdicts[result.kind]}`)
  const body = renderComment({
    headSha: pr.headSha, hash, ledgerLine: encodeLedger(next), modelId, results, recap, verdicts, round,
    ranges: Object.fromEntries(REVIEW_ORDER.map((kind) => [kind, plans[kind].range])), tier, context,
    earlierRounds: reviewRounds(issueComments), diffTruncated: truncated, omitted: change.omitted, dropped: next.dropped,
  })
  if (options.out) writeFileSync(options.out, body)
  writeOutput(env.GITHUB_OUTPUT, 'comment', 'true')
  writeOutput(env.GITHUB_OUTPUT, 'body', body)
  const blocked = Object.values(verdicts).includes('BLOCK')
  if (blocked && env.AI_REVIEW_ENFORCED === 'true') { say('BLOCK: a complete VIOLATION or MUST-FIX is open (AI_REVIEW_ENFORCED=true)'); return 1 }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
