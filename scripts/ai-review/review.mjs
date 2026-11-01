#!/usr/bin/env node
/**
 * Local AI reviews of the change you are about to push, by the developer's OWN coding agent:
 *
 *   node scripts/ai-review/review.mjs --kind tenets   does the change move away from a tenet in TENETS.md?
 *   node scripts/ai-review/review.mjs --kind commit   a review of the whole change like the GitHub PR review
 *
 * Both are steps of scripts/validate.sh (groups `tenets` and `commit`; `npm run validate:tenets`,
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
 * (AI_REVIEW_CACHE=0 ignores the cache; answers older than 30 days are pruned). AI_REVIEW_TIMEOUT (seconds, default 600) bounds a run; a timeout is a skip and stops the agent.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPrompt, capDiff, chooseRunner, KINDS, onPath, parseVerdict, REVIEW_PATHSPEC, runnerCommand, SECRET_PATHS } from './lib.mjs'

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
  // Names only: the changed paths SECRET_PATHS kept out of the diff.
  const omitted = [
    ...(git(root, ['diff', '--name-only', base, '--', ...SECRET_PATHS]) ?? '').split('\n'),
    ...(git(root, ['ls-files', '--others', '--exclude-standard', '--', ...SECRET_PATHS]) ?? '').split('\n'),
  ].filter(Boolean)
  return { diff: [tracked, ...added].join('\n').trim(), files, commits, omitted: [...new Set(omitted)] }
}

/** Runs the agent with the prompt on stdin: `{output, stderr, code, timedOut}`. */
function runAgent({ command, args }, prompt, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    // Its own process group, so a timeout stops every process the CLI started, not only the CLI itself.
    const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    let stderr = ''
    let timedOut = false
    const signalGroup = (signal) => { try { process.kill(-child.pid, signal) } catch { child.kill(signal) } }
    // SIGTERM first; an agent that ignores it gets SIGKILL 5 s later (the step must end).
    const stop = () => { signalGroup('SIGTERM'); setTimeout(() => signalGroup('SIGKILL'), 5000).unref() }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    // A Ctrl-C or kill of this script reaches the agent's group too (it no longer shares ours): SIGTERM, then exit
    // when the agent has closed, or SIGKILL its group and exit after 5 s.
    const onSignal = (signal) => {
      const code = signal === 'SIGINT' ? 130 : 143
      signalGroup('SIGTERM')
      child.once('close', () => process.exit(code))
      setTimeout(() => { signalGroup('SIGKILL'); process.exit(code) }, 5000)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    const done = () => { clearTimeout(timer); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal) }
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk; stderr += chunk })
    child.on('error', (error) => { done(); resolve({ output: `${output}\n${error.message}`, stderr: error.message, code: null, timedOut }) })
    child.on('close', (code) => { done(); resolve({ output, stderr, code, timedOut }) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** A CI runner: GITHUB_ACTIONS set, or CI set to anything but empty, `false` or `0`. */
export function isCi(env) {
  const ci = String(env.CI ?? '').trim().toLowerCase()
  return Boolean(env.GITHUB_ACTIONS) || (ci !== '' && ci !== 'false' && ci !== '0')
}

/** Why a blocking-tag item does not block: what it lacks. */
function incompleteReason(item, kind) {
  const missing = [!item.trigger && 'Trigger', !item.outcome && 'Outcome'].filter(Boolean)
  if (missing.length > 0) return `no ${missing.join('/')}`
  return kind.tenet ? `unknown tenet ${item.tenet ?? '(none)'}` : 'incomplete'
}

/** Cached answers older than CACHE_DAYS are removed, so .cache/ai-review/ does not grow forever. */
const CACHE_DAYS = 30
function pruneCache(dir) {
  if (!existsSync(dir)) return
  const cutoff = Date.now() - CACHE_DAYS * 86_400_000
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
    } catch {
      // A file removed by a parallel run is fine.
    }
  }
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
  const { diff, files, commits, omitted } = collectChange(root, base)
  if (omitted.length > 0) say(`not sent (named like a secret; review them yourself): ${omitted.join(', ')}`)
  if (!diff) { say(`nothing to review since ${base.slice(0, 8)}`); return 0 }

  const systemPrompt = readFileSync(join(root, `.kiro/agents/prompts/${kind.agent}.md`), 'utf8')
  const tenets = readFileSync(join(root, 'TENETS.md'), 'utf8')
  const { text, truncated } = capDiff(diff)
  const prompt = buildPrompt({ kind: kindName, tenets, commits, base: base.slice(0, 12), files, diff: text, truncated, omitted })

  const cacheDir = join(root, '.cache', 'ai-review')
  const key = createHash('sha256').update(`${kindName}\n${choice.runner}\n${env.AI_REVIEW_MODEL ?? ''}\n${systemPrompt}\n${prompt}`).digest('hex')
  const cacheFile = join(cacheDir, `${kindName}-${key.slice(0, 32)}.txt`)
  let output
  let exited = null
  pruneCache(cacheDir)
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
    exited = { code: run.code, stderr: run.stderr }
    if (run.timedOut) { say(`skipped: the agent did not answer within ${timeoutMs / 1000} s`); return 0 }
    if (parseVerdict(output, kindName).verdict !== 'INCOMPLETE') {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cacheFile, output)
    }
  }

  console.log(output.trim())
  const result = parseVerdict(output, kindName)
  for (const item of [...result.blocking, ...result.others]) {
    const why = item.kind === kind.block && !result.blocking.includes(item) ? ` (${incompleteReason(item, kind)}: not blocking)` : ''
    say(`${item.kind}${item.tenet ? ` tenet ${item.tenet}` : ''} at ${item.where}: ${item.title}${why}`)
  }
  switch (result.verdict) {
    case 'BLOCK':
      say(`BLOCK: a complete ${kind.block} item (above). Fix it${kindName === 'tenets' ? ', or explain the trade-off TENETS.md allows,' : ''} and re-run.`)
      return 1
    case 'WARN': say('WARN: findings above, not blocking'); return 0
    case 'PASS': say('PASS'); return 0
    default: {
      // Not signed in, a usage error after a CLI upgrade, a crash: all leave no verdict. Say which, loudly, so a
      // review that silently stopped working is visible in every run.
      const firstError = exited?.stderr.split('\n').map((line) => line.trim()).find(Boolean)
      const how = exited && exited.code !== 0 ? `the agent exited ${exited.code} without a verdict` : 'the agent gave no verdict'
      say(`skipped: ${how}${firstError ? ` (${firstError.slice(0, 200)})` : ''}. Is the CLI signed in and up to date? Its output is above.`)
      return 0
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
