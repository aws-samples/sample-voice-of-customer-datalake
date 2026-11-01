import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildPrompt, capDiff, chooseRunner, KINDS, onPath, parseVerdict, runnerCommand, SECRET_PATHS } from './lib.mjs'
import { isCi, kindFromArgs } from './review.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const has = (...installed) => (bin) => installed.includes(bin)

test('auto picks kiro-cli first, then claude, and skips when neither is installed', () => {
  assert.equal(chooseRunner({ mode: undefined, ci: false, has: has('kiro-cli', 'claude') }).runner, 'kiro')
  assert.equal(chooseRunner({ mode: 'auto', ci: false, has: has('claude') }).runner, 'claude')
  const none = chooseRunner({ mode: '', ci: false, has: has() })
  assert.equal(none.runner, null)
  assert.match(none.notice, /neither kiro-cli nor claude is installed/)
})

test('a forced runner is used when installed and is an error when missing', () => {
  assert.equal(chooseRunner({ mode: 'claude', ci: false, has: has('kiro-cli', 'claude') }).runner, 'claude')
  assert.match(chooseRunner({ mode: 'KIRO', ci: false, has: has('claude') }).error, /AI_REVIEW=kiro but kiro-cli is not on PATH/)
  assert.match(chooseRunner({ mode: 'gpt', ci: false, has: has() }).error, /use one of auto, off, kiro, claude/)
})

test('off and CI skip without looking for a CLI, and CI ignores a bad setting', () => {
  assert.equal(chooseRunner({ mode: 'gpt', ci: true, has: has('kiro-cli') }).runner, null)
  assert.match(chooseRunner({ mode: 'off', ci: false, has: has('kiro-cli') }).notice, /AI_REVIEW=off/)
  const ci = chooseRunner({ mode: 'kiro', ci: true, has: has('kiro-cli') })
  assert.equal(ci.runner, null)
  assert.match(ci.notice, /skipped on CI/)
})

test('both runners are read-only and take the prompt on stdin', () => {
  const kiro = runnerCommand('kiro', { agent: 'commit-reviewer', systemPrompt: 'S' })
  assert.equal(kiro.command, 'kiro-cli')
  assert.deepEqual(kiro.args.slice(0, 3), ['chat', '--agent', 'commit-reviewer'])
  assert.ok(kiro.args.includes('--trust-tools='))
  assert.ok(!kiro.args.some((arg) => /trust-all/.test(arg)))
  const claude = runnerCommand('claude', { agent: 'tenets-reviewer', systemPrompt: 'S', model: 'm' })
  assert.equal(claude.command, 'claude')
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--tools'), claude.args.indexOf('--tools') + 2), ['--tools', 'Read,Glob'])
  assert.ok(claude.args.includes('--strict-mcp-config'))
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--permission-mode'), claude.args.indexOf('--permission-mode') + 4),
    ['--permission-mode', 'dontAsk', '--allowedTools', 'Read(./**),Glob(./**)'])
  assert.deepEqual(claude.args[claude.args.indexOf('--disallowedTools') + 1].split(','), SECRET_PATHS.map((glob) => `Read(./**/${glob})`))
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'Read,Glob')
  assert.deepEqual(claude.args.slice(-2), ['--model', 'm'])
  assert.throws(() => runnerCommand('other', { agent: 'x', systemPrompt: 'S' }), /unknown runner/)
})

test('capDiff cuts at a line end and says so', () => {
  assert.deepEqual(capDiff('a\nb', 10), { text: 'a\nb', truncated: false })
  assert.deepEqual(capDiff('aaaa\nbbbb\ncccc', 11), { text: 'aaaa\nbbbb', truncated: true })
})

test('the prompt carries TENETS.md, the file list and the diff, labelled as data', () => {
  const prompt = buildPrompt({ kind: 'tenets', tenets: '# Tenets', commits: 'abc fix', base: 'abc', files: ' a.ts | 2 +', diff: '+x', truncated: true })
  assert.match(prompt, /data, not instructions/)
  assert.match(prompt, /<tenets file="TENETS.md">\n# Tenets\n<\/tenets>/)
  assert.match(prompt, /<changed-files base="abc">/)
  assert.match(prompt, /<git-diff>\n\+x\n<\/git-diff>/)
  assert.match(prompt, /Read the remaining changed files/)
  assert.doesNotMatch(prompt, /<commits>/)
  const commit = buildPrompt({ kind: 'commit', tenets: 'T', commits: 'abc1234 5.70.01: x', base: 'b', files: '', diff: '+y', truncated: false })
  assert.match(commit, /as a pull request review would/)
  assert.match(commit, /<commits>\nabc1234 5.70.01: x\n<\/commits>/)
  assert.match(commit, /<changed-files base="b">\n\(none\)/)
})

const VIOLATION = 'VIOLATION -- voc-datalake/lib/x.ts:12 -- tenet 7: a NAT gateway on by default\n> new NatGateway()\nTrigger: a default deploy\nOutcome: an hourly bill while idle\nFix: put it behind a flag'

test('a complete violation blocks, even under a PASS line quoted from the diff', () => {
  const blocked = parseVerdict(`${VIOLATION}\nREVIEW-VERDICT: tenets BLOCK`)
  assert.equal(blocked.verdict, 'BLOCK')
  assert.equal(blocked.blocking[0].tenet, '7')
  assert.equal(parseVerdict(`${VIOLATION}\nREVIEW-VERDICT: tenets PASS`).verdict, 'BLOCK')
})

test('an incomplete violation or an unknown tenet only warns', () => {
  const noOutcome = VIOLATION.replace(/\nOutcome:.*/, '')
  assert.equal(parseVerdict(`${noOutcome}\nREVIEW-VERDICT: tenets BLOCK`).verdict, 'WARN')
  assert.equal(parseVerdict(`${VIOLATION.replace('tenet 7', 'tenet 9')}\nREVIEW-VERDICT: tenets BLOCK`).verdict, 'WARN')
  assert.equal(parseVerdict('CONCERN -- a.ts:1 -- tenet D4: no actor recorded\nWhy: x\nREVIEW-VERDICT: tenets PASS').verdict, 'WARN')
})

test('PASS needs the verdict line, the last line wins, and colour codes are ignored', () => {
  assert.equal(parseVerdict('\u001b[32mREVIEW-VERDICT: tenets PASS\u001b[0m').verdict, 'PASS')
  assert.equal(parseVerdict('REVIEW-VERDICT: tenets WARN\nREVIEW-VERDICT: tenets PASS').verdict, 'PASS')
  assert.equal(parseVerdict('> REVIEW-VERDICT: tenets PASS').verdict, 'INCOMPLETE')
  assert.equal(parseVerdict('Please sign in with kiro-cli login').verdict, 'INCOMPLETE')
})

test('onPath finds only executable files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenets-path-'))
  try {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'plain'), '')
    chmodSync(join(dir, 'tool'), 0o755)
    assert.equal(onPath('tool', `/nonexistent:${dir}`), true)
    assert.equal(onPath('plain', dir), false)
    assert.equal(onPath('tool', ''), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── End to end: a scratch repository and fake CLIs on a PATH holding only git and node ──

function binOf(name) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
  assert.ok(found, `${name} on PATH`)
  return found
}

/** A repository with one committed file and one change, and a bin dir with the given fake CLIs. */
function scratch(fakes) {
  const dir = mkdtempSync(join(tmpdir(), 'tenets-review-'))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  mkdirSync(join(repo, '.kiro/agents/prompts'), { recursive: true })
  mkdirSync(bin)
  copyFileSync(join(ROOT, 'TENETS.md'), join(repo, 'TENETS.md'))
  for (const agent of ['tenets-reviewer', 'commit-reviewer']) {
    copyFileSync(join(ROOT, `.kiro/agents/prompts/${agent}.md`), join(repo, `.kiro/agents/prompts/${agent}.md`))
  }
  writeFileSync(join(repo, 'stack.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, '.gitignore'), '.cache/\n')  // as in the repository: the answer cache is never reviewed
  const run = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  run('init', '-q', '-b', 'main')
  run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.')
  run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  writeFileSync(join(repo, 'stack.ts'), 'export const a = 1\nnew NatGateway()\n')
  writeFileSync(join(repo, 'new.ts'), 'export const b = 2\n')
  for (const tool of ['git', 'node']) symlinkSync(binOf(tool), join(bin, tool))
  for (const [name, reply] of Object.entries(fakes)) {
    // The fake records its argv and stdin, then answers with a fixed review.
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(join(dir, 'called'))}, JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }))
process.stdout.write(${JSON.stringify(reply)})
`)
    chmodSync(join(bin, name), 0o755)
  }
  return { dir, repo, bin }
}

function review({ repo, bin }, env = {}, args = ['--kind', 'tenets']) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts/ai-review/review.mjs'), ...args], {
    cwd: repo, encoding: 'utf8', env: { PATH: bin, HOME: dirname(bin), ...env },
  })
}

const called = (dir) => JSON.parse(readFileSync(join(dir, 'called'), 'utf8'))

test('with neither CLI installed the step is skipped and passes', () => {
  const box = scratch({})
  try {
    const result = review(box)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /neither kiro-cli nor claude is installed/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('with only claude installed it sends the diff and untracked files on stdin and passes on PASS', () => {
  const box = scratch({ claude: 'REVIEW-VERDICT: tenets PASS\n' })
  try {
    const result = review(box)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /using claude/)
    assert.match(result.stdout, /tenets review: PASS/)
    const call = called(box.dir)
    assert.equal(call.name, 'claude')
    assert.match(call.stdin, /\+new NatGateway\(\)/)
    assert.match(call.stdin, /new\.ts \(new, untracked\)/)
    assert.match(call.stdin, /\+export const b = 2/)
    assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /# Tenets Review Agent/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('kiro-cli is preferred, a violation fails the step, and the same change is answered from the cache', () => {
  const box = scratch({ 'kiro-cli': `${VIOLATION}\nREVIEW-VERDICT: tenets BLOCK\n`, claude: 'REVIEW-VERDICT: tenets PASS\n' })
  try {
    const first = review(box)
    assert.equal(first.status, 1, first.stdout + first.stderr)
    assert.match(first.stdout, /VIOLATION tenet 7 at voc-datalake\/lib\/x\.ts:12/)
    assert.equal(called(box.dir).name, 'kiro-cli')
    assert.deepEqual(called(box.dir).args.slice(0, 3), ['chat', '--agent', 'tenets-reviewer'])
    rmSync(join(box.dir, 'called'))
    const second = review(box)
    assert.equal(second.status, 1)
    assert.match(second.stdout, /cached answer/)
    assert.throws(() => called(box.dir), /ENOENT/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a CLI that gives no verdict (not signed in) is a skip, not a failure, and is not cached', () => {
  const box = scratch({ 'kiro-cli': 'error: you are not logged in\n' })
  try {
    const result = review(box)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /gave no verdict/)
    rmSync(join(box.dir, 'called'))
    review(box)
    assert.equal(called(box.dir).name, 'kiro-cli')
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('CI and a forced missing runner', () => {
  const box = scratch({ 'kiro-cli': 'REVIEW-VERDICT: tenets PASS\n' })
  try {
    const ci = review(box, { GITHUB_ACTIONS: 'true' })
    assert.equal(ci.status, 0)
    assert.match(ci.stdout, /skipped on CI/)
    const forced = review(box, { AI_REVIEW: 'claude' })
    assert.equal(forced.status, 2)
    assert.match(forced.stdout, /claude is not on PATH/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('--kind is read from argv, tenets by default', () => {
  assert.equal(kindFromArgs([]), 'tenets')
  assert.equal(kindFromArgs(['--kind', 'commit']), 'commit')
  assert.equal(kindFromArgs(['--kind=commit']), 'commit')
  assert.equal(kindFromArgs(['--kind']), '')
})

const MUST_FIX = 'MUST-FIX -- scripts/x.mjs:3 -- the cap is never applied\n> const cap = 0\nTrigger: any diff\nOutcome: the whole diff is sent\nFix: use MAX'

test('a commit review blocks on a complete MUST-FIX and only warns on SHOULD-FIX and NIT', () => {
  assert.equal(parseVerdict(`${MUST_FIX}\nREVIEW-VERDICT: commit BLOCK`, 'commit').verdict, 'BLOCK')
  assert.equal(parseVerdict(`${MUST_FIX.replace(/\nTrigger:.*/, '')}\nREVIEW-VERDICT: commit BLOCK`, 'commit').verdict, 'WARN')
  const warn = parseVerdict('SHOULD-FIX -- a.md:1 -- stale number\nWhy: x\nNIT -- b.ts:2 -- name\nREVIEW-VERDICT: commit WARN', 'commit')
  assert.equal(warn.verdict, 'WARN')
  assert.deepEqual(warn.others.map((item) => item.kind), ['SHOULD-FIX', 'NIT'])
  assert.equal(parseVerdict('REVIEW-VERDICT: commit PASS', 'commit').verdict, 'PASS')
})

test("each kind reads only its own verdict line and tags", () => {
  assert.equal(parseVerdict('REVIEW-VERDICT: tenets PASS', 'commit').verdict, 'INCOMPLETE')
  assert.equal(parseVerdict(`${VIOLATION}\nREVIEW-VERDICT: commit PASS`, 'commit').verdict, 'PASS')
  assert.throws(() => parseVerdict('', 'other'), /unknown review kind/)
  assert.deepEqual(Object.keys(KINDS), ['tenets', 'commit'])
})

test('the commit review sends the commit messages and uses its own agent and cache', () => {
  const box = scratch({ 'kiro-cli': `${MUST_FIX}\nREVIEW-VERDICT: commit BLOCK\n` })
  try {
    const run = (...args) => spawnSync('git', args, { cwd: box.repo, encoding: 'utf8' })
    run('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-am', '5.70.01: add a NAT gateway')
    const result = review(box, { AI_REVIEW_BASE: 'HEAD~1' }, ['--kind', 'commit'])
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /commit review: MUST-FIX at scripts\/x\.mjs:3: the cap is never applied/)
    const call = called(box.dir)
    assert.deepEqual(call.args.slice(0, 3), ['chat', '--agent', 'commit-reviewer'])
    assert.match(call.stdin, /<commits>\n[0-9a-f]+ 5\.70\.01: add a NAT gateway/)
    assert.equal(review(box, {}, ['--kind', 'nope']).status, 2)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

// Verified live with kiro-cli 2.37 (5.72.01): an agent with tools ['read'], nothing in allowedTools and
// toolsSettings.fs_read.allowedPaths ['./**'] reads ./ files without a prompt; a read of /tmp/… fails in
// --no-interactive with "tool permission approval is not supported"; a read matching deniedPaths fails with "the
// arguments supplied are forbidden". Claude Code (dontAsk, the rules above) DENIED a read outside ./ and of a
// Read-denied ./.env. This pins those configurations.
test('both Kiro review agents can read only inside the repository, and trust nothing', () => {
  for (const agent of ['tenets-reviewer', 'commit-reviewer']) {
    const config = JSON.parse(readFileSync(join(ROOT, `.kiro/agents/${agent}.json`), 'utf8'))
    assert.deepEqual(config.tools, ['read', 'thinking'], agent)
    assert.deepEqual(config.allowedTools, ['thinking'], agent)
    assert.deepEqual(config.toolsSettings, {
      fs_read: { allowedPaths: ['./**'], deniedPaths: SECRET_PATHS.map((glob) => `**/${glob}`) },
    }, agent)
    assert.equal(config.prompt, `file://./prompts/${agent}.md`)
  }
})

test('a timeout stops the agent, is a skip, and is not cached', () => {
  const box = scratch({})
  try {
    writeFileSync(join(box.bin, 'kiro-cli'), '#!/usr/bin/env node\nprocess.stdin.resume()\nsetTimeout(() => {}, 60000)\n')
    chmodSync(join(box.bin, 'kiro-cli'), 0o755)
    const started = Date.now()
    const result = review(box, { AI_REVIEW_TIMEOUT: '1' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /did not answer within 1 s/)
    assert.ok(Date.now() - started < 20000, 'the sleeping agent was stopped')
    assert.equal(existsSync(join(box.repo, '.cache', 'ai-review')), false)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('CI is GITHUB_ACTIONS or a truthy CI', () => {
  assert.equal(isCi({ GITHUB_ACTIONS: 'true' }), true)
  assert.equal(isCi({ CI: 'true' }), true)
  assert.equal(isCi({ CI: '1' }), true)
  assert.equal(isCi({ CI: 'false' }), false)
  assert.equal(isCi({ CI: '0' }), false)
  assert.equal(isCi({}), false)
})

test('secret-shaped untracked files and the cache are never sent', () => {
  const box = scratch({ claude: 'REVIEW-VERDICT: tenets PASS\n' })
  try {
    for (const name of ['.env', 'prod.env.local', 'deploy.pem', 'aws-credentials.json', 'id_rsa']) {
      writeFileSync(join(box.repo, name), 'SECRET-VALUE-123\n')
    }
    const result = review(box)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const { stdin } = called(box.dir)
    assert.doesNotMatch(stdin, /SECRET-VALUE-123/)
    assert.match(stdin, /new\.ts \(new, untracked\)/)
    // Named, never sent: a legitimate file caught by the wide patterns stays visible.
    assert.match(result.stdout, /not sent \(named like a secret; review them yourself\): .*aws-credentials\.json/)
    assert.match(stdin, /<not-sent>\n[^<]*deploy\.pem/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('an agent that exits non-zero without a verdict is a loud skip naming the exit code and its first error', () => {
  const box = scratch({})
  try {
    writeFileSync(join(box.bin, 'kiro-cli'), "#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('end', () => { console.error('error: unexpected argument --wrap'); process.exit(2) })\n")
    chmodSync(join(box.bin, 'kiro-cli'), 0o755)
    const result = review(box)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /skipped: the agent exited 2 without a verdict \(error: unexpected argument --wrap\)/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('an incomplete blocking item says why it does not block', () => {
  const box = scratch({ claude: `${VIOLATION.replace(/\nOutcome:.*/, '')}\nREVIEW-VERDICT: tenets BLOCK\n` })
  try {
    const result = review(box)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /VIOLATION tenet 7 at voc-datalake\/lib\/x\.ts:12: a NAT gateway on by default \(no Outcome: not blocking\)/)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('cached answers older than 30 days are pruned', () => {
  const box = scratch({ claude: 'REVIEW-VERDICT: tenets PASS\n' })
  try {
    const cache = join(box.repo, '.cache', 'ai-review')
    mkdirSync(cache, { recursive: true })
    const old = join(cache, 'tenets-old.txt')
    writeFileSync(old, 'REVIEW-VERDICT: tenets PASS\n')
    const longAgo = new Date(Date.now() - 31 * 86_400_000)
    utimesSync(old, longAgo, longAgo)
    review(box)
    assert.equal(existsSync(old), false)
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('Ctrl-C stops an agent that ignores SIGTERM, within the 5 s escalation', async () => {
  const box = scratch({})
  try {
    const pidFile = join(box.dir, 'agent.pid')
    writeFileSync(join(box.bin, 'kiro-cli'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGTERM', () => {})
process.stdin.resume()
setInterval(() => {}, 1000)
`)
    chmodSync(join(box.bin, 'kiro-cli'), 0o755)
    const child = spawn(process.execPath, [join(ROOT, 'scripts/ai-review/review.mjs'), '--kind', 'tenets'], {
      cwd: box.repo, env: { PATH: box.bin, HOME: box.dir }, stdio: 'ignore',
    })
    // Up to 60 s for the fake agent to start: the gate runs this beside five busy lanes.
    for (let i = 0; i < 600 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100))
    const agentPid = Number(readFileSync(pidFile, 'utf8'))
    const started = Date.now()
    child.kill('SIGINT')
    const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode)))
    assert.equal(code, 130)
    // The escalation fires 5 s after the signal; 20 s leaves room for a loaded machine, and still fails when the
    // review waits for an agent that never closes.
    assert.ok(Date.now() - started < 20000, 'the review exited after the escalation')
    // The kill and the exit share a tick: give the system a moment to reap the agent before asserting it is gone.
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(agentPid, 0); await new Promise((r) => setTimeout(r, 100)) } catch { alive = false }
    }
    assert.equal(alive, false, 'the agent is gone')
  } finally {
    rmSync(box.dir, { recursive: true, force: true })
  }
})
