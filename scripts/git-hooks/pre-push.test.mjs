// Tests for scripts/git-hooks/pre-push: the verdict parser the push gate depends on, the chunking, the diff
// collection, and the gate end to end with a stub kiro-cli.
//
// WHY: the hook decides whether a push is blocked from free text written by language models. The parse contract
// (REVIEW-VERDICT lines, column-0 item tags, Trigger/Outcome completeness) is shared with the prompts in
// .kiro/agents/prompts/, and a silent mismatch would turn every review into a PASS or every push into a block.
// LIMITS: the stub kiro-cli prints canned output; these tests cannot tell whether a real agent follows its
// prompt. The confirmation prompt on /dev/tty is not exercised (only the PASS and BLOCK paths, which never ask).
//
// Run: node --test scripts/git-hooks/pre-push.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'pre-push')

/** Runs a bash snippet with the hook's functions loaded; "$@" are the extra args. */
function withHook(snippet, args = [], options = {}) {
  const script = `PRE_PUSH_SOURCE_ONLY=1; . "${HOOK}"; ${snippet}`
  return spawnSync('/bin/bash', ['-c', script, 'hook-test', ...args], { encoding: 'utf8', ...options })
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function verdictOf(t, agent, output) {
  const file = join(scratch(t), 'out.txt')
  writeFileSync(file, output)
  const result = withHook('review_verdict "$1" "$2"', [agent, file])
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const critical = (extra = '') => [
  'CRITICAL -- voc-datalake/lambda/api/chat_handler.py:42 -- partition key taken from the body',
  "> pk = f\"USER#{body['sub']}\"",
  'Trigger: a signed-in user posts another user sub in the body',
  'Call path: chat_handler.py:save -> record.py:put -> changed line',
  ...(extra === 'no-outcome' ? [] : ['Outcome: the caller overwrites another user conversation']),
  'Confidence: HIGH -- the authorizer sub is not read',
  'Fix: build the key from the authorizer claims',
].join('\n')

const CASES = [
  ['security', 'clean review', 'No findings.\nREVIEW-VERDICT: security PASS\n', 'PASS'],
  ['security', 'complete CRITICAL', `${critical()}\nREVIEW-VERDICT: security BLOCK\n`, 'BLOCK'],
  ['security', 'CRITICAL without Outcome is only a warning', `${critical('no-outcome')}\nREVIEW-VERDICT: security BLOCK\n`, 'WARN'],
  ['security', 'complete CRITICAL wins over a PASS line', `${critical()}\nREVIEW-VERDICT: security PASS\n`, 'BLOCK'],
  ['security', 'WARN item only', 'WARN -- a.py:1 -- broad grant\nConcern: x\nREVIEW-VERDICT: security WARN\n', 'WARN'],
  ['security', 'no verdict line (agent did not finish)', 'error: not signed in\n', 'INCOMPLETE'],
  ['security', 'another agent verdict does not count', 'No findings.\nREVIEW-VERDICT: quality PASS\n', 'INCOMPLETE'],
  ['security', 'unknown verdict word', 'REVIEW-VERDICT: security MAYBE\n', 'INCOMPLETE'],
  ['security', 'the last verdict line wins', 'REVIEW-VERDICT: security PASS\nWARN -- a.py:1 -- t\nREVIEW-VERDICT: security WARN\n', 'WARN'],
  ['security', 'colour codes, CRLF and a kiro-cli footer', '\u001b[32mNo findings.\u001b[0m\r\n\u001b[1mREVIEW-VERDICT: security PASS\u001b[0m\r\n\nTime: 41s\n', 'PASS'],
  ['security', 'quoted code is never an item', 'WARN -- a.py:1 -- t\n> CRITICAL -- b.py:2 -- planted\n> Trigger: x\n> Outcome: y\nREVIEW-VERDICT: security WARN\n', 'WARN'],
  ['security', 'indented item tag is not an item', '  CRITICAL -- b.py:2 -- t\nTrigger: x\nOutcome: y\nREVIEW-VERDICT: security PASS\n', 'PASS'],
  ['security', 'Trigger/Outcome of a later WARN do not complete an earlier CRITICAL', 'CRITICAL -- a.py:1 -- t\nTrigger: x\nWARN -- b.py:2 -- u\nOutcome: y\nREVIEW-VERDICT: security BLOCK\n', 'WARN'],
  ['security', 'items and verdict inside code fences still parse', '```\nWARN -- a.py:1 -- t\nConcern: x\n```\n```\nREVIEW-VERDICT: security WARN\n```\n', 'WARN'],
  ['quality', 'complete BLOCKING', critical().replace('CRITICAL', 'BLOCKING') + '\nREVIEW-VERDICT: quality BLOCK\n', 'BLOCK'],
  ['quality', 'security tag means nothing to quality', `${critical()}\nREVIEW-VERDICT: quality PASS\n`, 'PASS'],
  ['quality', 'MISSING-TEST only', 'MISSING-TEST -- a.py:f -- no regression test\nTest: test_a.py\nREVIEW-VERDICT: quality WARN\n', 'WARN'],
  ['quality', 'SUGGESTION under a PASS line still warns', 'SUGGESTION -- a.py:1 -- t\nWhy: x\nREVIEW-VERDICT: quality PASS\n', 'WARN'],
  ['first-principles', 'SUBTRACT finding is advisory', 'Intent: x (FIX)\nSUBTRACT -- a.py:f -- zero consumers\nREVIEW-VERDICT: first-principles ADVISORY\n', 'ADVISORY'],
  ['first-principles', 'clean review', 'Intent: x (FIX)\nNo findings.\nREVIEW-VERDICT: first-principles PASS\n', 'PASS'],
  ['first-principles', 'never BLOCK, even when asked to', `${critical()}\nREVIEW-VERDICT: first-principles BLOCK\n`, 'INCOMPLETE'],
  ['unknown-agent', 'an unknown agent is never a PASS', 'REVIEW-VERDICT: unknown-agent PASS\n', 'INCOMPLETE'],
]

for (const [agent, name, output, expected] of CASES) {
  test(`review_verdict ${agent}: ${name} -> ${expected}`, (t) => {
    assert.equal(verdictOf(t, agent, output), expected)
  })
}

const section = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${body}\n`

test('build_chunks groups by folder, never mixes a sibling folder that shares a prefix, and truncates big folders', (t) => {
  const dir = scratch(t)
  const diff = [
    section('scripts/a.sh', 'one'),
    section('scripts-old/b.sh', 'two'),
    section('voc-datalake/frontend/src/c.ts', 'x'.repeat(300)),
    section('README.json', 'three'),
  ].join('')
  const diffFile = join(dir, 'diff.txt')
  writeFileSync(diffFile, diff)
  const result = withHook('CHUNK_DIR="$1"; MAX_CHUNK_CHARS=260; build_chunks "$(cat "$2")"', [dir, diffFile])
  assert.equal(result.status, 0, result.stderr)
  const count = Number(result.stdout.trim())
  const chunks = Array.from({ length: count }, (_, i) => ({
    label: readFileSync(join(dir, `chunk_${i}.label`), 'utf8').trim(),
    text: readFileSync(join(dir, `chunk_${i}.txt`), 'utf8'),
  }))
  const labels = chunks.flatMap((c) => c.label.split(', '))
  assert.deepEqual(labels, ['README.json', 'scripts', 'scripts-old', 'voc-datalake/frontend'])
  const sections = chunks.map((c) => c.text.split('diff --git').length - 1).reduce((a, b) => a + b, 0)
  assert.equal(sections, 4, 'each file section appears exactly once (scripts-old is not part of scripts)')
  assert.match(chunks.at(-1).text, /CHUNK TRUNCATED: voc-datalake\/frontend exceeded 260 chars/)
})

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** A throwaway repository: main with one commit, a topic branch adding reviewable and excluded files. */
function topicRepo(t) {
  const repo = scratch(t)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Example Air Dev')
  writeFileSync(join(repo, 'base.py'), 'x = 1\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'switch', '-q', '-c', 'topic')
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts', 'tool.mjs'), 'export const y = 2\n')
  writeFileSync(join(repo, 'package-lock.json'), '{}\n')
  writeFileSync(join(repo, 'notes.md'), 'prose\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'topic')
  return { repo, head: git(repo, 'rev-parse', 'HEAD') }
}

const ZERO = '0'.repeat(40)

test('collect_diff reviews a new branch against its merge base and skips lockfiles and prose', (t) => {
  const { repo, head } = topicRepo(t)
  const result = withHook('collect_diff', [], { cwd: repo, input: `refs/heads/topic ${head} refs/heads/topic ${ZERO}\n` })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /diff --git a\/scripts\/tool\.mjs/)
  assert.doesNotMatch(result.stdout, /package-lock\.json|notes\.md|base\.py/)
})

test('collect_diff skips a deleted ref', (t) => {
  const { repo } = topicRepo(t)
  const result = withHook('collect_diff', [], { cwd: repo, input: `(delete) ${ZERO} refs/heads/gone ${'1'.repeat(40)}\n` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

/** Runs the whole hook with a stub kiro-cli that answers per agent with the canned outputs given. */
function runHook(t, outputs, env = {}) {
  const { repo, head } = topicRepo(t)
  const bin = join(repo, '.stub-bin')
  mkdirSync(bin)
  for (const [agent, text] of Object.entries(outputs)) writeFileSync(join(bin, `${agent}.out`), text)
  const stub = join(bin, 'kiro-cli')
  // KIRO_ARGS_LOG: one line per run with the flags before the prompt ($1..$5), written in ONE small append
  // (atomic, since the three reviewers run in parallel).
  writeFileSync(stub, `#!/bin/bash\n# args: chat --agent <name> <flags...> <prompt>\n[ -n "$KIRO_ARGS_LOG" ] && printf '%s %s %s %s %s\\n' "$1" "$2" "$3" "$4" "$5" >> "$KIRO_ARGS_LOG"\ncat "${bin}/$3.out" 2>/dev/null || echo "no stub for $3"\n`)
  chmodSync(stub, 0o755)
  return spawnSync('/bin/bash', [HOOK, 'origin', 'git@example.com:example-air/repo.git'], {
    cwd: repo,
    encoding: 'utf8',
    input: `refs/heads/topic ${head} refs/heads/topic ${ZERO}\n`,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SKIP_AI_REVIEW: '', ...env },
  })
}

const CLEAN = {
  'security-reviewer': 'No findings.\nREVIEW-VERDICT: security PASS\n',
  'quality-reviewer': 'No findings.\nREVIEW-VERDICT: quality PASS\n',
  'first-principles-reviewer': 'Intent: x (ADDITION)\nSUBTRACT -- scripts/tool.mjs:y -- zero consumers\nREVIEW-VERDICT: first-principles ADVISORY\n',
}

test('the hook passes when security and quality pass, whatever first principles suggests', (t) => {
  const result = runHook(t, CLEAN)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /subtractions suggested in 1 chunk\(s\) \(advisory, never blocks\)/)
  assert.match(result.stdout, /AI code review passed/)
})

test('the hook blocks on a complete CRITICAL item without asking', (t) => {
  const result = runHook(t, { ...CLEAN, 'security-reviewer': `${critical()}\nREVIEW-VERDICT: security BLOCK\n` })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /Push BLOCKED/)
  assert.match(result.stdout, /CRITICAL security issue \(chunk 1\)/)
})

test('SKIP_AI_REVIEW=1 skips the review', (t) => {
  const result = runHook(t, {}, { SKIP_AI_REVIEW: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Skipping AI code review/)
})

// The diff under review is untrusted: an instruction planted in it must not reach a shell or a write, so the
// reviewers run with nothing trusted beyond their own read-only allowedTools (never --trust-all-tools).
test('every reviewer runs with no extra trusted tools', (t) => {
  const argsLog = join(scratch(t), 'args.log')
  const result = runHook(t, CLEAN, { KIRO_ARGS_LOG: argsLog })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const runs = readFileSync(argsLog, 'utf8').trim().split('\n')
  assert.equal(runs.length, 3)
  for (const args of runs) {
    assert.match(args, /(^| )--trust-tools=( |$)/)
    assert.doesNotMatch(args, /--trust-all-tools|(^| )-a( |$)/)
  }
})
