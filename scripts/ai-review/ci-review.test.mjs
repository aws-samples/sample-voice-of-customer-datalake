import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOT_LOGIN, CI_PREAMBLE, converseLong, converseRequest, diffHash, latestReview, prContext, readComments, readConverse,
  renderComment, renderMarker, writeOutput,
} from './ci-lib.mjs'
import { bedrockCall, DEFAULT_MODEL, main, parseArgs, pullRequestOf } from './ci-review.mjs'
import { buildPrompt, parseVerdict } from './lib.mjs'
import { collectChange } from './review.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SHA = 'a'.repeat(40)
const comment = (login, body, extra = {}) => ({ user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, body, created_at: '2026-11-03T10:00:00Z', ...extra })

test('comments are read from slurped pages, and anything not shaped like a comment is left out', () => {
  const read = readComments([[comment('ana', 'hi')], [comment(BOT_LOGIN, 'x'), 'junk', null]])
  assert.deepEqual(read.map((c) => [c.login, c.isBot]), [['ana', false], [BOT_LOGIN, true]])
  assert.deepEqual(readComments({ message: 'Not Found' }), [])
  assert.deepEqual(readComments(null), [])
})

test('only the workflow bot\'s first-line marker counts, and the newest wins', () => {
  const marker = (sha, hash) => renderMarker(sha, hash)
  const comments = readComments([
    comment(BOT_LOGIN, `${marker('1111111', '0123456789abcdef')}\nold`),
    comment('mallory', `${marker('2222222', 'ffffffffffffffff')}\nspoofed by a person`),
    comment(BOT_LOGIN, `review text\n${marker('3333333', 'eeeeeeeeeeeeeeee')}`),
    comment(BOT_LOGIN, `${marker('4444444', 'fedcba9876543210')}\nnew`),
  ])
  assert.deepEqual(latestReview(comments), { sha: '4444444', diffhash: 'fedcba9876543210' })
  assert.equal(latestReview(comments.slice(1, 3)), null)
})

test('the pull request context keeps people\'s comments, oldest first, and leaves bots and automated reviews out', () => {
  const text = prContext({
    title: ' Add a NAT gateway ', body: 'Why: speed',
    issueComments: readComments([
      comment('bo', 'second', { created_at: '2026-11-03T12:00:00Z' }),
      comment('ana', 'first', { created_at: '2026-11-03T09:00:00Z' }),
      comment('dependabot[bot]', 'bump'),
      comment('perrozzi', '<!-- repo-review-bot kind=pr sha=1 -->\nold webhook review'),
      comment(BOT_LOGIN, `${renderMarker(SHA, '0123456789abcdef')}\nours`),
      comment('cy', '   '),
    ]),
    reviewComments: readComments([comment('cy', 'is this on by default?', { path: 'lib/x.ts', line: 12, created_at: '2026-11-03T11:00:00Z' })]),
  })
  assert.match(text, /^Title: Add a NAT gateway\n\nDescription:\nWhy: speed\n/)
  const order = ['@ana, 2026-11-03: first', '@cy on lib/x.ts:12, 2026-11-03: is this on by default?', '@bo, 2026-11-03: second']
  assert.deepEqual(text.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2)), order)
  assert.doesNotMatch(text, /bump|old webhook review|ours/)
  assert.match(prContext({ title: '', body: '', issueComments: [], reviewComments: [] }), /Title: \(none\)\n\nDescription:\n\(none\)\n\nConversation[^\n]*\n\(none\)$/)
})

test('past its budget the conversation drops the OLDEST comments and says how many', () => {
  const many = Array.from({ length: 12 }, (_, i) => comment('ana', `${i}:${'x'.repeat(3500)}`, { created_at: `2026-11-03T10:${String(i).padStart(2, '0')}:00Z` }))
  const text = prContext({ title: 't', body: '', issueComments: readComments(many), reviewComments: [] })
  assert.match(text, /\[4 earlier comments left out\]/)
  assert.doesNotMatch(text, /- @ana, 2026-11-03: 3:/)
  assert.match(text, /- @ana, 2026-11-03: 11:/)
})

test('a Converse request carries no temperature and no thinking field', () => {
  const request = converseRequest({ modelId: 'm', systemPrompt: 'S', messages: [], maxTokens: 10 })
  assert.deepEqual(request, { modelId: 'm', system: [{ text: 'S' }], messages: [], inferenceConfig: { maxTokens: 10 } })
})

test('a Converse response yields only its text blocks and tolerates a malformed one', () => {
  const response = { output: { message: { content: [{ reasoningContent: { reasoningText: { text: 'hmm' } } }, { text: 'a' }, { text: 'b' }] } }, stopReason: 'end_turn' }
  assert.deepEqual(readConverse(response), { text: 'ab', stopReason: 'end_turn' })
  assert.deepEqual(readConverse({ output: 'x' }), { text: '', stopReason: '' })
  assert.deepEqual(readConverse(null), { text: '', stopReason: '' })
})

const reply = (text, stopReason = 'end_turn') => ({ output: { message: { content: [{ text }] } }, stopReason })
const long = (answers, options = {}) => {
  const requests = []
  const call = async (request) => { requests.push(request); return answers.shift() }
  return { requests, run: converseLong(call, { modelId: 'm', systemPrompt: 'S', prompt: 'P', maxTokens: 5, maxContinuations: 2, deadlineMs: 60_000, ...options }) }
}

test('an answer cut on max_tokens is continued and stitched, replaying the partial answer', async () => {
  const { requests, run } = long([reply('one ', 'max_tokens'), reply('two', 'end_turn')])
  assert.deepEqual(await run, { text: 'one two', truncated: false })
  assert.deepEqual(requests[1].messages.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(requests[1].messages[1].content[0].text, 'one ')
})

test('an answer still cut after every continuation, or with an empty continuation, says it is truncated', async () => {
  assert.deepEqual(await long([reply('a', 'max_tokens'), reply('b', 'max_tokens'), reply('c', 'max_tokens')]).run, { text: 'abc', truncated: true })
  assert.deepEqual(await long([reply('a', 'max_tokens'), reply('  ', 'max_tokens')]).run, { text: 'a', truncated: true })
})

test('no continuation is asked once the deadline has passed', async () => {
  let clock = 0
  const { requests, run } = long([reply('a', 'max_tokens'), reply('b')], { deadlineMs: 10, now: () => (clock += 20) })
  assert.deepEqual(await run, { text: 'a', truncated: true })
  assert.equal(requests.length, 1)
})

test('an empty first answer is an error: there is nothing to post', async () => {
  await assert.rejects(long([reply('', 'max_tokens')]).run, /returned no text \(stop reason max_tokens\)/)
})

const PASS = (kind) => `Looks fine.\nREVIEW-VERDICT: ${kind} PASS\n`
const VIOLATION = 'VIOLATION -- lib/x.ts:2 -- tenet 7: a NAT gateway on by default\n> new NatGateway()\nTrigger: a default deploy\nOutcome: a monthly bill\nFix: a flag\nREVIEW-VERDICT: tenets BLOCK\n'

test('the comment starts with a marker latestReview reads back, and fences answers so they cannot break out', () => {
  const output = 'x ```` y\nREVIEW-VERDICT: commit PASS'
  const body = renderComment({
    headSha: SHA, hash: '0123456789abcdef', modelId: DEFAULT_MODEL, diffTruncated: true, omitted: ['.env'],
    results: [
      { kind: 'tenets', output: VIOLATION, truncated: true, verdict: parseVerdict(VIOLATION, 'tenets') },
      { kind: 'commit', output, truncated: false, verdict: parseVerdict(output, 'commit') },
    ],
  })
  assert.deepEqual(latestReview(readComments([comment(BOT_LOGIN, body)])), { sha: SHA, diffhash: '0123456789abcdef' })
  assert.match(body, /\| Tenets \(TENETS\.md\) \| ❌ BLOCK: 1 VIOLATION \|/)
  assert.match(body, /\| Code review \| ✅ PASS \|/)
  assert.match(body, /`````text\nx ```` y\nREVIEW-VERDICT: commit PASS\n`````/)
  assert.match(body, /the answer reached the output limit/i)
  assert.match(body, /this review is partial/)
  assert.match(body, /named like a secret, review them yourself\): `\.env`/)
  assert.ok(body.indexOf('#### Tenets') < body.indexOf('#### Code review'), 'the tenets come first')
})

test('a verdict the table does not know is shown as it is, never as undefined', () => {
  const body = renderComment({ headSha: SHA, hash: '0123456789abcdef', modelId: 'm',
    results: [{ kind: 'commit', output: 'x', truncated: false, verdict: { verdict: 'ODD', blocking: [], others: [] } }] })
  assert.match(body, /\| Code review \| ODD \|/)
  assert.doesNotMatch(body, /undefined/)
})

test('a secret-shaped path named by the pull request cannot break out of its code span', () => {
  const body = renderComment({ headSha: SHA, hash: '0123456789abcdef', modelId: 'm', diffTruncated: false, results: [],
    omitted: ['a`.env` [x](https://evil.example) @team\n> injected'] })
  assert.match(body, /review them yourself\): `a\.env \[x\]\(https:\/\/evil\.example\) @team> injected`$/m)
})

test('a review that was not run says so in the table and its section', () => {
  // Also: `diffTruncated` and `omitted` may be left out.
  const body = renderComment({ headSha: SHA, hash: '0123456789abcdef', modelId: 'm', results: [{ kind: 'tenets', error: true }] })
  assert.match(body, /\| Tenets \(TENETS\.md\) \| ⛔ not run/)
  assert.match(body, /Not run: the Bedrock call failed/)
  assert.doesNotMatch(body, /partial|named like a secret/)
})

test('outputs are written with a delimiter the value cannot contain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-out-'))
  try {
    const file = join(dir, 'out')
    writeOutput(file, 'body', 'line 1\nline 2')
    writeOutput('', 'ignored', 'x')
    const [first, ...rest] = readFileSync(file, 'utf8').split('\n')
    const delimiter = first.replace('body<<', '')
    assert.match(delimiter, /^ghadelimiter_[0-9a-f-]{36}$/)
    assert.deepEqual(rest, ['line 1', 'line 2', delimiter, ''])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('arguments and the event are validated', () => {
  assert.match(parseArgs(['--repo', 'r']).error, /missing --prompts-root, --event/)
  assert.match(parseArgs(['--nope', 'x']).error, /unexpected argument --nope/)
  assert.match(parseArgs(['--repo']).error, /unexpected argument --repo/)
  assert.deepEqual(parseArgs(['--repo', 'r', '--prompts-root', 'p', '--event', 'e', '--out', 'o']), { repo: 'r', promptsRoot: 'p', event: 'e', out: 'o' })
  assert.deepEqual(pullRequestOf({ pull_request: { number: 7, head: { sha: SHA }, title: 't', body: null } }), { number: 7, headSha: SHA, title: 't', body: '' })
  assert.equal(pullRequestOf({ pull_request: { number: 7, head: { sha: 'main' } } }), null)
  assert.equal(pullRequestOf({ issue: {} }), null)
})

test('the CI prompt carries the pull request and admits it cannot read a cut diff', () => {
  const prompt = buildPrompt({ kind: 'tenets', tenets: 'T', commits: 'c', base: 'b', files: 'f', diff: '+d', truncated: true, pullRequest: 'Title: x', canRead: false })
  assert.match(prompt, /<\/tenets>\n\n<pull-request>\nTitle: x\n<\/pull-request>/)
  assert.match(prompt, /You cannot read the rest: review what is shown and say the review is partial/)
  assert.doesNotMatch(prompt, /read tools/)
  assert.doesNotMatch(buildPrompt({ kind: 'tenets', tenets: 'T', base: 'b', files: 'f', diff: '+d', truncated: false }), /<pull-request>/)
})

// ── End to end: a scratch repository with refs/pr/base and refs/pr/head, and a trusted prompts root ──

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-ci-'))
  const repo = join(dir, 'repo')
  const trusted = join(dir, 'trusted')
  mkdirSync(repo)
  mkdirSync(join(trusted, '.kiro/agents/prompts'), { recursive: true })
  copyFileSync(join(ROOT, 'TENETS.md'), join(trusted, 'TENETS.md'))
  for (const agent of ['tenets-reviewer', 'commit-reviewer']) {
    copyFileSync(join(ROOT, `.kiro/agents/prompts/${agent}.md`), join(trusted, `.kiro/agents/prompts/${agent}.md`))
  }
  const run = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' })
  run('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'stack.ts'), 'export const a = 1\n')
  run('add', '.')
  run('commit', '-q', '-m', 'base')
  run('update-ref', 'refs/pr/base', 'HEAD')
  writeFileSync(join(repo, 'stack.ts'), 'export const a = 1\nnew NatGateway()\n')
  writeFileSync(join(repo, '.env'), 'SECRET-VALUE-123\n')
  run('add', '.')
  run('commit', '-q', '-m', '5.75.01: add a NAT gateway')
  run('update-ref', 'refs/pr/head', 'HEAD')
  // Work in the scratch checkout is NOT the pull request: only refs/pr/head is reviewed.
  writeFileSync(join(repo, 'local-only.ts'), 'export const local = 1\n')
  writeFileSync(join(repo, 'stack.ts'), 'export const a = 1\nnew NatGateway()\n// WORKTREE-EDIT\n')
  const headSha = run('rev-parse', 'HEAD').stdout.trim()
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 9, head: { sha: headSha }, title: 'NAT', body: 'Adds a NAT gateway' } }))
  writeFileSync(join(dir, 'comments.json'), JSON.stringify([[comment('ana', 'please check tenet 7')]]))
  const args = ['--repo', repo, '--prompts-root', trusted, '--event', join(dir, 'event.json'), '--issue-comments', join(dir, 'comments.json'), '--out', join(dir, 'comment.md')]
  return { dir, repo, args, headSha }
}

const fakeBedrock = (answers) => {
  const requests = []
  return { requests, call: async (request) => { requests.push(request); const answer = answers[requests.length - 1]; if (answer instanceof Error) throw answer; return answer } }
}
const outputsOf = (file) => existsSync(file) ? readFileSync(file, 'utf8') : ''

test('collectChange with a head reads that commit range only, never the working tree', () => {
  const box = scratch()
  try {
    const base = spawnSync('git', ['merge-base', 'refs/pr/base', 'refs/pr/head'], { cwd: box.repo, encoding: 'utf8' }).stdout.trim()
    const change = collectChange(box.repo, base, 'refs/pr/head')
    assert.match(change.diff, /\+new NatGateway\(\)/)
    assert.doesNotMatch(change.diff, /local-only|WORKTREE-EDIT|SECRET-VALUE-123/)
    assert.match(change.commits, /5\.75\.01: add a NAT gateway/)
    assert.deepEqual(change.omitted, ['.env'])
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('both reviews run with the trusted prompts behind the no-tools preamble, and one comment is produced', async () => {
  const box = scratch()
  try {
    const out = join(box.dir, 'github-output')
    const fake = fakeBedrock([reply(VIOLATION), reply(PASS('commit'))])
    const code = await main(box.args, { GITHUB_OUTPUT: out }, { call: fake.call })
    assert.equal(code, 0, 'advisory: a BLOCK does not fail the job')
    assert.equal(fake.requests.length, 2)
    const [tenets, commit] = fake.requests
    assert.equal(tenets.modelId, DEFAULT_MODEL)
    assert.ok(tenets.system[0].text.startsWith(CI_PREAMBLE))
    assert.match(tenets.system[0].text, /# Tenets Review Agent/)
    assert.match(commit.system[0].text, /# Commit Review Agent/)
    const prompt = commit.messages[0].content[0].text
    assert.match(prompt, /<pull-request>\nTitle: NAT\n\nDescription:\nAdds a NAT gateway[\s\S]*@ana, 2026-11-03: please check tenet 7/)
    assert.match(prompt, /<commits>\n[0-9a-f]+ 5\.75\.01: add a NAT gateway/)
    assert.doesNotMatch(prompt, /SECRET-VALUE-123|local-only/)
    assert.doesNotMatch(tenets.messages[0].content[0].text, /<commits>/)
    const body = readFileSync(join(box.dir, 'comment.md'), 'utf8')
    assert.ok(body.startsWith(renderMarker(box.headSha, diffHash(collectChange(box.repo, 'refs/pr/base', 'refs/pr/head').diff))))
    assert.match(outputsOf(out), /^comment<<ghadelimiter_[^\n]+\ntrue\n/)
    assert.match(outputsOf(out), /body<<ghadelimiter_[^\n]+\n<!-- voc-ai-review sha=/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a push that leaves the diff unchanged is not reviewed again, and costs no model call', async () => {
  const box = scratch()
  try {
    await main(box.args, {}, { call: fakeBedrock([reply(PASS('tenets')), reply(PASS('commit'))]).call })
    const posted = readFileSync(join(box.dir, 'comment.md'), 'utf8')
    writeFileSync(join(box.dir, 'comments.json'), JSON.stringify([[comment(BOT_LOGIN, posted)]]))
    const out = join(box.dir, 'github-output')
    const fake = fakeBedrock([])
    assert.equal(await main(box.args, { GITHUB_OUTPUT: out }, { call: fake.call }), 0)
    assert.equal(fake.requests.length, 0)
    assert.match(outputsOf(out), /^comment<<ghadelimiter_[^\n]+\nfalse\n/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('AI_REVIEW_ENFORCED=true fails on a complete VIOLATION; a failed call is posted as not run', async () => {
  const box = scratch()
  try {
    const fake = fakeBedrock([reply(VIOLATION), new Error('ThrottlingException')])
    assert.equal(await main(box.args, { AI_REVIEW_ENFORCED: 'true' }, { call: fake.call }), 1)
    assert.match(readFileSync(join(box.dir, 'comment.md'), 'utf8'), /\| Code review \| ⛔ not run/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('when every call fails nothing is posted and the job still passes', async () => {
  const box = scratch()
  try {
    const out = join(box.dir, 'github-output')
    const fake = fakeBedrock([new Error('AccessDeniedException'), new Error('AccessDeniedException')])
    assert.equal(await main(box.args, { GITHUB_OUTPUT: out, AI_REVIEW_ENFORCED: 'true' }, { call: fake.call }), 0)
    assert.match(outputsOf(out), /\nfalse\n/)
    assert.equal(existsSync(join(box.dir, 'comment.md')), false)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a missing merge base or a bad event is a skip; bad arguments are an error', async () => {
  const box = scratch()
  try {
    spawnSync('git', ['update-ref', '-d', 'refs/pr/base'], { cwd: box.repo })
    assert.equal(await main(box.args, {}, { call: fakeBedrock([]).call }), 0)
    writeFileSync(join(box.dir, 'event.json'), '{"issue": {}}')
    assert.equal(await main(box.args, {}, { call: fakeBedrock([]).call }), 0)
    assert.equal(await main(['--repo', box.repo], {}), 2)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

// ── bedrockCall against a fake `aws` on PATH ──

function fakeAws(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-aws-'))
  const node = spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim()
  symlinkSync(node, join(dir, 'node'))
  writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node\n${script}\n`)
  chmodSync(join(dir, 'aws'), 0o755)
  return dir
}

test('bedrockCall sends the request file with a long read timeout and returns the parsed response', async () => {
  const bin = fakeAws(`const fs = require('fs')
const args = process.argv.slice(2)
const file = args[args.indexOf('--cli-input-json') + 1].replace('file://', '')
fs.writeFileSync(process.env.SEEN, JSON.stringify({ args, request: JSON.parse(fs.readFileSync(file, 'utf8')), file }))
process.stdout.write(JSON.stringify({ output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }))`)
  try {
    const seen = join(bin, 'seen.json')
    const response = await bedrockCall({ modelId: 'm' }, { region: 'us-east-1', env: { PATH: bin, SEEN: seen } })
    assert.deepEqual(readConverse(response), { text: 'ok', stopReason: 'end_turn' })
    const { args, request, file } = JSON.parse(readFileSync(seen, 'utf8'))
    assert.deepEqual(args.slice(0, 2), ['bedrock-runtime', 'converse'])
    assert.equal(args[args.indexOf('--cli-read-timeout') + 1], '600')
    assert.equal(args[args.indexOf('--region') + 1], 'us-east-1')
    assert.deepEqual(request, { modelId: 'm' })
    assert.equal(existsSync(file), false, 'the request file is removed')
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('bedrockCall kills a CLI that outlives the review budget, and refuses to start when it is spent', async () => {
  const hanging = fakeAws('setInterval(() => {}, 1000)')
  try {
    const started = Date.now()
    await assert.rejects(bedrockCall({}, { region: 'r', env: { PATH: hanging }, timeoutMs: 300 }), /did not answer within 1 s \(the review budget\)/)
    assert.ok(Date.now() - started < 10_000, 'the hanging CLI was killed')
    await assert.rejects(bedrockCall({}, { region: 'r', env: { PATH: hanging }, timeoutMs: 0 }), /no time left in the review budget/)
  } finally {
    rmSync(hanging, { recursive: true, force: true })
  }
})

test('bedrockCall rejects when the AWS CLI is not installed', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'ai-review-noaws-'))
  try {
    await assert.rejects(bedrockCall({}, { region: 'r', env: { PATH: empty } }), /ENOENT/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('bedrockCall rejects with the CLI\'s first error line, and on output that is not JSON', async () => {
  const failing = fakeAws(`process.stderr.write('\\nAn error occurred (AccessDeniedException) when calling the Converse operation: no\\nmore\\n'); process.exit(254)`)
  const garbled = fakeAws(`process.stdout.write('not json')`)
  try {
    await assert.rejects(bedrockCall({}, { region: 'r', env: { PATH: failing } }), /^Error: An error occurred \(AccessDeniedException\)/)
    await assert.rejects(bedrockCall({}, { region: 'r', env: { PATH: garbled } }), /printed no JSON/)
  } finally {
    rmSync(failing, { recursive: true, force: true })
    rmSync(garbled, { recursive: true, force: true })
  }
})
