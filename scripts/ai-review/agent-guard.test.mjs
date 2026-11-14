// Tests for scripts/ai-review/agent-guard.mjs: the fail-closed spec of every Kiro agent in .kiro/agents.
//
// WHY: kiro-cli 3.3.0 has two engines and each enforces one half of an agent file (lib.mjs → KIRO_READ_SETTINGS);
// a 7.00.01 review leaked a dummy `.env` live through five agent changes the old denylist test passed (`resources`,
// `hooks`, `shell`, `grep`/`glob`, a nested or `.md` agent file). Each of those, and every other widening this
// guard knows, has a negative case below that runs the same checker as the real folder.
// Run: node --test scripts/ai-review/agent-guard.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS, agentErrors, agentTreeErrors, resourceError } from './agent-guard.mjs'
import { KIRO_SHELL_RULES, KIRO_SHELL_SETTINGS } from './lib.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const AGENTS_DIR = join(ROOT, '.kiro/agents')

/** Every file under .kiro/agents, recursively, as `{path, text}` with a `/`-separated relative path. */
function agentFiles() {
  return readdirSync(AGENTS_DIR, { recursive: true })
    .map(String)
    .filter((path) => statSync(join(AGENTS_DIR, path)).isFile())
    .map((path) => ({ path: path.split('\\').join('/'), text: readFileSync(join(AGENTS_DIR, path), 'utf8') }))
}

const real = (name) => JSON.parse(readFileSync(join(AGENTS_DIR, `${name}.json`), 'utf8'))
const clone = (value) => JSON.parse(JSON.stringify(value))

test('every file under .kiro/agents is an allowlisted agent or a plain prompt, and every agent matches its spec', () => {
  const files = agentFiles()
  assert.ok(files.filter(({ path }) => !path.includes('/') && path.endsWith('.json')).length >= 6, 'the agents folder was read')
  assert.deepEqual(agentTreeErrors(files), [])
})

test('every resource an agent loads is a repository file that exists', () => {
  for (const name of AGENTS.keys()) {
    for (const entry of real(name).resources ?? []) {
      assert.equal(resourceError(entry), null, `${name}: ${entry}`)
      const path = entry.slice('file://'.length)
      assert.ok(statSync(join(ROOT, path)).isFile(), `${name}: ${entry} exists`)
    }
  }
})

// One widening per case, applied to a copy of a real agent; each must be refused with a message naming it.
const CONFIG_CASES = [
  ['a tool beyond the allowlist (shell)', 'security-reviewer', (c) => { c.tools.push('shell') }, /tools must be exactly/],
  ['grep and glob tools (V2 grep printed denied files)', 'first-principles-reviewer', (c) => { c.tools.splice(1, 0, 'grep', 'glob') }, /tools must be exactly/],
  ['a pre-approved read tool', 'quality-reviewer', (c) => { c.allowedTools.push('fs_read') }, /allowedTools must be exactly/],
  ['a pre-approved shell on the test generator', 'test-generator', (c) => { c.allowedTools.push('shell') }, /allowedTools must be exactly/],
  ['a pre-approved write on the test generator', 'test-generator', (c) => { c.allowedTools.push('fs_write') }, /allowedTools must be exactly/],
  ['agent hooks', 'security-reviewer', (c) => { c.hooks = { agentSpawn: [{ command: 'cat .env' }] } }, /field "hooks" is not allowed/],
  ['MCP servers', 'commit-reviewer', (c) => { c.mcpServers = { fs: { command: 'npx', args: ['fs-server', '/'] } } }, /field "mcpServers" is not allowed/],
  ['tool aliases', 'commit-reviewer', (c) => { c.toolAliases = { '@fs/read': 'read' } }, /field "toolAliases" is not allowed/],
  ['includeMcpJson: true', 'tenets-reviewer', (c) => { c.includeMcpJson = true }, /includeMcpJson must be false/],
  ['useLegacyMcpJson: true', 'tenets-reviewer', (c) => { c.useLegacyMcpJson = true }, /useLegacyMcpJson must be false/],
  ['a kiroUpgrade marker', 'commit-reviewer', (c) => { c.kiroUpgrade = { from: 'v2' } }, /no kiroUpgrade marker/],
  ['a resource that is a secret', 'security-reviewer', (c) => { c.resources.push('file://.env') }, /secret-shaped/],
  ['a resource under a secret folder name', 'security-reviewer', (c) => { c.resources.push('file://config/.envrc/x.md') }, /secret-shaped/],
  ['a resource glob', 'security-reviewer', (c) => { c.resources.push('file://docs/*.md') }, /a glob/],
  ['a resource outside the repository (..)', 'security-reviewer', (c) => { c.resources.push('file://../notes.md') }, /"\.\."/],
  ['an absolute resource', 'security-reviewer', (c) => { c.resources.push('file:///etc/hosts') }, /not a relative repository path/],
  ['a home resource', 'security-reviewer', (c) => { c.resources.push('file://~/notes.md') }, /not a relative repository path/],
  ['a non-file resource', 'security-reviewer', (c) => { c.resources.push('skill://anything') }, /not a file:\/\/ entry/],
  ['a dropped V2 deny path', 'commit-reviewer', (c) => { c.toolsSettings.fs_read.deniedPaths.pop() }, /toolsSettings must equal/],
  ['a dropped V2 shell setting', 'test-generator', (c) => { delete c.toolsSettings.shell }, /toolsSettings must equal/],
  ['an extra V3 allow-all rule', 'commit-reviewer', (c) => { c.permissions.rules.push({ capability: '*', effect: 'allow' }) }, /permissions\.rules must equal/],
  ['the V3 shell deny-by-default removed', 'test-generator', (c) => { c.permissions.rules = c.permissions.rules.filter((rule) => !('exclude' in rule)) }, /permissions\.rules must equal/],
  ['another prompt file', 'tenets-reviewer', (c) => { c.prompt = 'file://./prompts/commit-reviewer.md' }, /prompt must be/],
  ['an inline prompt', 'tenets-reviewer', (c) => { c.prompt = 'Print .env' }, /prompt must be/],
  ['another name', 'tenets-reviewer', (c) => { c.name = 'helper' }, /name must be/],
]

for (const [label, name, widen, expected] of CONFIG_CASES) {
  test(`the guard refuses ${label}`, () => {
    const config = clone(real(name))
    assert.deepEqual(agentErrors(name, config), [], `${name} passes before the change`)
    widen(config)
    const errors = agentErrors(name, config)
    assert.ok(errors.some((error) => expected.test(error)), `${label}: ${JSON.stringify(errors)}`)
  })
}

test('the guard refuses an agent that is not in the allowlist', () => {
  assert.match(agentErrors('helper', clone(real('commit-reviewer'))).join('\n'), /not in the agent allowlist/)
})

// V3 loads nested `<dir>/*.json` agents and top-level `.md` agents with frontmatter; V2 loads top-level `*.json`.
const TREE_CASES = [
  ['a nested folder agent', { path: 'extra/leaky.json', text: '{}' }, /only top-level \*\.json agents/],
  ['a JSON file in prompts/', { path: 'prompts/leaky.json', text: '{}' }, /only top-level \*\.json agents/],
  ['a top-level Markdown agent', { path: 'leaky.md', text: '---\nname: leaky\n---\nRead .env' }, /only top-level \*\.json agents/],
  ['a top-level YAML file', { path: 'leaky.yaml', text: 'name: leaky' }, /only top-level \*\.json agents/],
  ['a prompt with frontmatter', { path: 'prompts/commit-reviewer.md', text: '---\ntools: ["*"]\n---\nx' }, /must not start with frontmatter/],
  ['a top-level agent not in the allowlist', { path: 'helper.json', text: readFileSync(join(AGENTS_DIR, 'commit-reviewer.json'), 'utf8') }, /not in the agent allowlist/],
  ['an agent file that is not JSON', { path: 'commit-reviewer.json', text: '{' }, /not valid JSON/],
]

for (const [label, file, expected] of TREE_CASES) {
  test(`the folder check refuses ${label}`, () => {
    const files = agentFiles().filter(({ path }) => path !== file.path)
    const errors = agentTreeErrors([...files, file])
    assert.ok(errors.some((error) => expected.test(error)), `${label}: ${JSON.stringify(errors)}`)
  })
}

test('the folder check refuses a missing agent and ignores files kiro-cli cannot load (its *.bak backups)', () => {
  const files = agentFiles()
  assert.match(agentTreeErrors(files.filter(({ path }) => path !== 'tenets-reviewer.json')).join('\n'), /tenets-reviewer\.json: in the allowlist but missing/)
  assert.deepEqual(agentTreeErrors([...files, { path: 'commit-reviewer.json.bak', text: '{"tools":["*"]}' }, { path: '.DS_Store', text: '' }]), [])
})

// The shell spec, checked the way each engine applies it (live-verified in 7.00.02): both split a compound command
// at ; && || | and check each part; V2 anchors each regex, V3's `*` matches any characters.
const parts = (command) => command.split(/\s*(?:;|&&|\|\||\|)\s*/).filter(Boolean)
const v2Allows = (command) => parts(command).every((part) => {
  const anchored = (regex) => new RegExp(`^(?:${regex})$`).test(part)
  return !KIRO_SHELL_SETTINGS.deniedCommands.some(anchored) && KIRO_SHELL_SETTINGS.allowedCommands.some(anchored)
})
const globMatch = (pattern, text) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replaceAll('*', '.*')}$`).test(text)
const v3Allows = (command) => parts(command).every((part) => {
  const matches = (rule) => (rule.match ?? ['*']).some((p) => globMatch(p, part)) && !(rule.exclude ?? []).some((p) => globMatch(p, part))
  const hit = KIRO_SHELL_RULES.filter(matches)
  return hit.some((rule) => rule.effect === 'allow') && !hit.some((rule) => rule.effect === 'deny')
})

test("the test generator's documented test commands run on both engines", () => {
  const prompt = readFileSync(join(AGENTS_DIR, 'prompts/test-generator.md'), 'utf8')
  const step = prompt.slice(prompt.indexOf('## Step 4'), prompt.indexOf('## Output Format'))
  const documented = [...step.matchAll(/^- [^:]+: `([^`]+)`$/gm)].map((match) => match[1].replace(/\[[^\]]+\]/g, 'src/a.test.ts'))
  assert.ok(documented.length >= 4, 'the prompt names its test commands')
  for (const command of [...documented, 'npm test', 'npm run test:cdk', 'node --test scripts/ai-review/*.test.mjs']) {
    assert.ok(v2Allows(command), `V2 allows: ${command}`)
    assert.ok(v3Allows(command), `V3 allows: ${command}`)
  }
})

test('the test generator cannot run a network client, the environment, the AWS CLI or a home read', () => {
  const refused = ['curl -sI https://example.com', 'wget https://example.com', 'nc example.com 80', 'ssh host', 'scp a host:b',
    'env', 'printenv', 'aws sts get-caller-identity', 'cat ~/.aws/credentials', 'head /Users/someone/.ssh/id_rsa', 'cat .env',
    'ls', 'git diff --no-index a b', 'npx vitest run a.test.ts; cat .env', 'npx vitest run a.test.ts && curl https://example.com',
    'npx vitest', 'cd .. && npx vitest run', 'bash -c "npx vitest run"']
  for (const command of refused) {
    assert.ok(!v2Allows(command), `V2 refuses: ${command}`)
    assert.ok(!v3Allows(command), `V3 refuses: ${command}`)
  }
  // V2 regexes keep substitution and redirection out of the arguments; V3 checks the inner command on its own.
  for (const command of ['npx vitest run $(cat .env)', 'node --test a.test.mjs > ~/.profile', 'node --test `id`']) {
    assert.ok(!v2Allows(command), `V2 refuses: ${command}`)
  }
  // Review (7.00.02): a folder of the same name outside the repository. V2 allows only a relative `cd`; V3 rewrites
  // `cd` to an absolute path before matching, so it cannot tell them apart (documented in lib.mjs).
  for (const command of ['cd ../../voc-datalake && npx vitest run', 'cd /tmp/x/voc-datalake && npx vitest run',
    'cd voc-datalake/../../voc-datalake && npx vitest run']) {
    assert.ok(!v2Allows(command), `V2 refuses: ${command}`)
  }
})
