/**
 * The fail-closed spec of the repository's Kiro agents (.kiro/agents/), checked by review.test.mjs.
 *
 * WHY: an agent file decides what a coding agent may read, write and run on a developer's machine, and the pre-push
 * reviews feed it untrusted diffs. A denylist of tool names lets every name or field it does not know through, so
 * this module is an ALLOWLIST: each agent is named in AGENTS with its exact `tools` and `allowedTools`, its rule
 * blocks must equal the lib.mjs constants exactly (both engines' formats, see KIRO_READ_SETTINGS), and every other
 * field, folder or file that could widen it fails. A new agent or field is added here on purpose, never by default.
 *
 * Pure functions over plain values: the test runs them on the real folder AND on in-memory configs that prove each
 * rejection.
 */
import { KIRO_READ_SETTINGS, KIRO_SHELL_RULES, KIRO_SHELL_SETTINGS, KIRO_WRITE_RULES, KIRO_WRITE_SETTINGS, SECRET_PATHS } from './lib.mjs'

/** `{capability: 'skill', effect: 'allow'}`: lets the agent activate skills; no file, write or shell access. */
const SKILL_RULE = Object.freeze({ capability: 'skill', effect: 'allow' })
const READER = Object.freeze({ tools: ['read', 'thinking'], allowedTools: ['thinking'], writes: false, shell: false })

/** Every agent the repository ships, and exactly what it may use. */
export const AGENTS = new Map([
  ['commit-reviewer', { ...READER, extraRules: [] }],
  ['tenets-reviewer', { ...READER, extraRules: [] }],
  ['first-principles-reviewer', { ...READER, extraRules: [] }],
  ['quality-reviewer', { ...READER, extraRules: [SKILL_RULE] }],
  ['security-reviewer', { ...READER, extraRules: [SKILL_RULE] }],
  // Writes tests inside the repository and runs the test runners its prompt names; nothing pre-approved but thinking.
  ['test-generator', { tools: ['read', 'shell', 'thinking', 'write'], allowedTools: ['thinking'], writes: true, shell: true, extraRules: [SKILL_RULE] }],
])

/** The top-level fields an agent file may carry. `hooks`, `mcpServers`, `toolAliases` and anything new are refused. */
const FIELDS = new Set(['name', 'description', 'model', 'prompt', 'tools', 'allowedTools', 'resources',
  'useLegacyMcpJson', 'includeMcpJson', 'toolsSettings', 'permissions'])

/** The exact `permissions.rules` of an agent in AGENTS (V3 format). */
export function expectedRules(spec) {
  return [
    ...KIRO_READ_SETTINGS.permissions.rules,
    ...(spec.writes ? KIRO_WRITE_RULES : []),
    ...(spec.shell ? KIRO_SHELL_RULES : []),
    ...spec.extraRules,
  ]
}

/** The exact `toolsSettings` of an agent in AGENTS (V2 format). */
export function expectedToolsSettings(spec) {
  return {
    fs_read: KIRO_READ_SETTINGS.toolsSettings.fs_read,
    ...(spec.writes ? { fs_write: KIRO_WRITE_SETTINGS } : {}),
    ...(spec.shell ? { shell: KIRO_SHELL_SETTINGS } : {}),
  }
}

const globRegex = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`)
const SECRET_REGEXES = SECRET_PATHS.map(globRegex)

/** Why a `resources` entry is refused, or null: only a literal repository file that is not secret-shaped. */
export function resourceError(entry) {
  if (typeof entry !== 'string' || !entry.startsWith('file://')) return 'not a file:// entry'
  const path = entry.slice('file://'.length).replace(/^\.\//, '')
  if (path === '' || path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return 'not a relative repository path'
  if (/[*?[\]{}]/.test(path)) return 'a glob, not a literal path'
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) return 'a path with ".." or an empty segment'
  if (segments.some((segment) => SECRET_REGEXES.some((regex) => regex.test(segment)))) return 'a secret-shaped path (SECRET_PATHS)'
  return null
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Every way the agent file `config` (named `name`, from `<name>.json`) differs from its spec; [] = allowed. */
export function agentErrors(name, config) {
  const spec = AGENTS.get(name)
  if (spec === undefined) return [`${name}: not in the agent allowlist (scripts/ai-review/agent-guard.mjs AGENTS)`]
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [`${name}: not a JSON object`]
  const errors = []
  const fail = (message) => errors.push(`${name}: ${message}`)
  // A machine-specific upgrade marker invites kiro-cli to regenerate the file (and drop the deny): never committed.
  if ('kiroUpgrade' in config) fail('no kiroUpgrade marker is committed')
  for (const field of Object.keys(config)) {
    if (field !== 'kiroUpgrade' && !FIELDS.has(field)) fail(`field "${field}" is not allowed`)
  }
  if (config.name !== name) fail(`name must be "${name}"`)
  if (config.prompt !== `file://./prompts/${name}.md`) fail(`prompt must be file://./prompts/${name}.md`)
  if (!same(config.tools, spec.tools)) fail(`tools must be exactly ${JSON.stringify(spec.tools)}`)
  if (!same(config.allowedTools, spec.allowedTools)) fail(`allowedTools must be exactly ${JSON.stringify(spec.allowedTools)}`)
  if (config.includeMcpJson !== undefined && config.includeMcpJson !== false) fail('includeMcpJson must be false or absent')
  if (config.useLegacyMcpJson !== undefined && config.useLegacyMcpJson !== false) fail('useLegacyMcpJson must be false or absent')
  const resources = config.resources ?? []
  if (!Array.isArray(resources)) fail('resources must be a list')
  else for (const entry of resources) {
    const why = resourceError(entry)
    if (why !== null) fail(`resource ${JSON.stringify(entry)}: ${why}`)
  }
  if (!same(config.toolsSettings, expectedToolsSettings(spec))) fail('toolsSettings must equal the lib.mjs constants (V2 format)')
  if (!same(config.permissions, { rules: expectedRules(spec) })) fail('permissions.rules must equal the lib.mjs constants (V3 format)')
  return errors
}

/** File extensions kiro-cli could load as an agent (V3 loads `.md` with frontmatter and nested `<dir>/*.json`). */
const AGENT_SHAPED = /\.(json|jsonc|json5|md|markdown|ya?ml)$/i
const FRONTMATTER = /^\uFEFF?\s*---/

/**
 * Every problem with the files under .kiro/agents: `files` is `[{path, text}]`, `path` relative and `/`-separated.
 * Allowed: a top-level `<name>.json` for each agent in AGENTS (and nothing else that looks like an agent) and
 * `prompts/<name>.md` without frontmatter. Files that cannot be agents (`*.bak` backups kiro-cli writes) are ignored.
 */
export function agentTreeErrors(files) {
  const errors = []
  const found = new Set()
  for (const { path, text } of files) {
    const parts = path.split('/')
    if (parts.length === 1 && path.endsWith('.json')) {
      found.add(path.slice(0, -'.json'.length))
      let config
      try { config = JSON.parse(text) } catch { errors.push(`${path}: not valid JSON`); continue }
      errors.push(...agentErrors(path.slice(0, -'.json'.length), config))
    } else if (parts.length === 2 && parts[0] === 'prompts' && path.endsWith('.md')) {
      if (FRONTMATTER.test(text)) errors.push(`${path}: a prompt must not start with frontmatter (kiro-cli would load it as an agent)`)
    } else if (AGENT_SHAPED.test(path)) {
      errors.push(`${path}: only top-level *.json agents and prompts/*.md are allowed in .kiro/agents`)
    }
  }
  for (const name of AGENTS.keys()) if (!found.has(name)) errors.push(`${name}.json: in the allowlist but missing`)
  return errors
}
