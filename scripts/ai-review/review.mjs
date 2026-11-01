#!/usr/bin/env node
/**
 * Local AI reviews of the change you are about to push, by the developer's OWN coding agent:
 *
 *   node scripts/ai-review/review.mjs --kind tenets   does the change move away from a tenet in TENETS.md?
 *   node scripts/ai-review/review.mjs --kind commit   a review of the whole change like the GitHub PR review
 *
 * Both are steps of scripts/validate.sh (groups `tenets` and `review`; `npm run validate:tenets`,
 * `npm run validate:commit`).
 *
 * WHAT IS REVIEWED: everything between the merge base with origin/main (else main) and the working tree, untracked
 * files included, plus (commit) the commit messages since that base. AI_REVIEW_BASE=<ref> picks another base.
 *
 * WHICH AGENT: AI_REVIEW=auto (default) uses kiro-cli when it is on PATH, else claude (Claude Code); =kiro or
 * =claude forces one (and fails if it is missing); =off skips. AI_REVIEW_MODEL passes --model through.
 * Neither installed, or a CLI that is not signed in: the step is SKIPPED with a notice and exits 0, so validate.sh
 * works on every machine. On CI (CI or GITHUB_ACTIONS set) it is skipped: there is no agent or credential there.
 *
 * VERDICT (lib.mjs → parseVerdict): a complete blocking item (tenets: VIOLATION, commit: MUST-FIX, each with a
 * Trigger and an Outcome) exits 1; the other items only print. The agent is a language model: a PASS is not proof,
 * and two runs can differ. The same change is reviewed once: answers are cached in .cache/ai-review/ by prompt hash
 * (AI_REVIEW_CACHE=0 ignores the cache). AI_REVIEW_TIMEOUT (seconds, default 600) bounds a run; a timeout is a skip and stops the agent.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPrompt, capDiff, chooseRunner, KINDS, onPath, parseVerdict, REVIEW_PATHSPEC, runnerCommand } from './lib.mjs'

function git(root, args, okStatuses = [0]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || !okStatuses.includes(result.status)) return null
  return result.stdout
}

function reviewBase(root, env) {
  if (env.AI_REVIEW_BASE) return git(root, ['rev-parse', '--verify', env.AI_REVIEW_BASE])?.trim() ?? null
  for (const ref of ['origin/main', 'main']) {
    const base = git(root, ['merge-base', 'HEAD', ref])?.trim()
    if (base) return base
  }
  return null
}

/** The diff from `base` to the working tree, untracked files shown as new files. */
function collectChange(root, base) {
  const tracked = git(root, ['diff', '--no-color', base, '--', ...REVIEW_PATHSPEC]) ?? ''
  const untracked = (git(root, ['ls-files', '--others', '--exclude-standard', '--', ...REVIEW_PATHSPEC]) ?? '')
    .split('\n').filter(Boolean)
  // `git diff --no-index` exits 1 when the files differ, which they always do against /dev/null.
  const added = untracked.map((file) => git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], [0, 1]) ?? '')
  const files = [
    git(root, ['diff', '--stat=200', base, '--', ...REVIEW_PATHSPEC]) ?? '',
    ...untracked.map((file) => ` ${file} (new, untracked)`),
  ].join('\n')
  const commits = git(root, ['log', '--no-color', '--format=%h %s%n%b', `${base}..HEAD`]) ?? ''
  return { diff: [tracked, ...added].join('\n').trim(), files, commits }
}

/** Runs the agent with the prompt on stdin: `{output, timedOut}`. */
function runAgent({ command, args }, prompt, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // Its own process group, so a timeout stops every process the CLI started, not only the CLI itself.
    const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    let timedOut = false
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    // A Ctrl-C or kill of this script reaches the agent's group too (it no longer shares ours).
    const onSignal = (signal) => { stop(); process.exit(signal === 'SIGINT' ? 130 : 143) }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    const done = () => { clearTimeout(timer); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal) }
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (error) => { done(); resolve({ output: `${output}\n${error.message}`, timedOut }) })
    child.on('close', () => { done(); resolve({ output, timedOut }) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** A CI runner: GITHUB_ACTIONS set, or CI set to anything but empty, `false` or `0`. */
export function isCi(env) {
  const ci = String(env.CI ?? '').trim().toLowerCase()
  return Boolean(env.GITHUB_ACTIONS) || (ci !== '' && ci !== 'false' && ci !== '0')
}

/** `--kind <name>` (or `--kind=<name>`) from argv; tenets when absent. */
export function kindFromArgs(argv) {
  const at = argv.findIndex((arg) => arg === '--kind' || arg.startsWith('--kind='))
  if (at < 0) return 'tenets'
  return argv[at].includes('=') ? argv[at].slice('--kind='.length) : (argv[at + 1] ?? '')
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const kindName = kindFromArgs(argv)
  const say = (message) => console.log(`${kindName} review: ${message}`)
  const kind = KINDS[kindName]
  if (kind === undefined) { say(`unknown --kind; use one of ${Object.keys(KINDS).join(', ')}`); return 2 }

  const root = git(process.cwd(), ['rev-parse', '--show-toplevel'])?.trim()
  if (!root) { say('skipped: not inside a git repository'); return 0 }

  const choice = chooseRunner({ mode: env.AI_REVIEW, ci: isCi(env), has: (bin) => onPath(bin, env.PATH) })
  if (choice.error) { say(choice.error); return 2 }
  say(choice.notice)
  if (choice.runner === null) return 0

  const base = reviewBase(root, env)
  if (!base) { say('skipped: no base to diff against (fetch origin/main or set AI_REVIEW_BASE)'); return 0 }
  const { diff, files, commits } = collectChange(root, base)
  if (!diff) { say(`nothing to review since ${base.slice(0, 8)}`); return 0 }

  const systemPrompt = readFileSync(join(root, `.kiro/agents/prompts/${kind.agent}.md`), 'utf8')
  const tenets = readFileSync(join(root, 'TENETS.md'), 'utf8')
  const { text, truncated } = capDiff(diff)
  const prompt = buildPrompt({ kind: kindName, tenets, commits, base: base.slice(0, 12), files, diff: text, truncated })

  const cacheDir = join(root, '.cache', 'ai-review')
  const key = createHash('sha256').update(`${kindName}\n${choice.runner}\n${env.AI_REVIEW_MODEL ?? ''}\n${systemPrompt}\n${prompt}`).digest('hex')
  const cacheFile = join(cacheDir, `${kindName}-${key.slice(0, 32)}.txt`)
  let output
  if (env.AI_REVIEW_CACHE !== '0' && existsSync(cacheFile)) {
    say(`this exact change was reviewed before: using the cached answer (${cacheFile}; AI_REVIEW_CACHE=0 re-runs)`)
    output = readFileSync(cacheFile, 'utf8')
  } else {
    const seconds = Number(env.AI_REVIEW_TIMEOUT)
    const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000
    say(`reviewing ${diff.length} characters of diff since ${base.slice(0, 8)}${truncated ? ' (cut; the agent reads the rest)' : ''}...`)
    const command = runnerCommand(choice.runner, { agent: kind.agent, systemPrompt, model: env.AI_REVIEW_MODEL })
    const run = await runAgent(command, prompt, { cwd: root, timeoutMs })
    output = run.output
    if (run.timedOut) { say(`skipped: the agent did not answer within ${timeoutMs / 1000} s`); return 0 }
    if (parseVerdict(output, kindName).verdict !== 'INCOMPLETE') {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cacheFile, output)
    }
  }

  console.log(output.trim())
  const result = parseVerdict(output, kindName)
  for (const item of [...result.blocking, ...result.others]) {
    say(`${item.kind}${item.tenet ? ` tenet ${item.tenet}` : ''} at ${item.where}: ${item.title}`)
  }
  switch (result.verdict) {
    case 'BLOCK':
      say(`BLOCK: a complete ${kind.block} item (above). Fix it${kindName === 'tenets' ? ', or explain the trade-off TENETS.md allows,' : ''} and re-run.`)
      return 1
    case 'WARN': say('WARN: findings above, not blocking'); return 0
    case 'PASS': say('PASS'); return 0
    default:
      say('skipped: the agent gave no verdict (is the CLI signed in? its output is above)')
      return 0
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
