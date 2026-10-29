#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * repo_contracts — the cheap repository contracts no compiler joins: CDK context keys, cdk.json feature flags,
 * npm scripts and the script files they and the docs name.
 *
 * Kinds (key in brackets):
 *   - `context-undocumented` [`context:<key>`]: a key the CDK app reads (`tryGetContext('<key>')`, or a
 *     `*_CONTEXT_KEY = '<key>'` constant it passes) that no doc (docs/, README.md, CONTRIBUTING.md,
 *     .kiro/steering/) names, so an operator cannot learn it exists.
 *   - `context-unread` [`context:<key>`]: a key `voc-datalake/cdk.context.json` sets that no production TypeScript
 *     of the CDK app (lib/, bin/, scripts/) names: a setting that does nothing.
 *   - `flag-module-unused` [`flag:<flag>`]: a `voc-datalake/cdk.json` feature flag for a module the app never
 *     imports (`@aws-cdk/aws-ecs:*` with no `aws-cdk-lib/aws-ecs`); 5.34 dropped six `cdk init` leftovers.
 *   - `script-missing-file` [`<package.json>::<script>`]: an npm script names a file that does not exist (after
 *     its `cd <dir> &&` prefixes).
 *   - `script-uncalled` [`<package.json>::<script>`]: no CI workflow, doc, hook, shell/JS script or other npm script
 *     runs it (`npm run <name>`, `npm --prefix <dir> run <name>`), and it is not an npm lifecycle script. A gate
 *     step's second spelling drifts from the gate (5.34 removed `dead-code*`, `duplication*`, `typecheck:python`,
 *     `test:acp-bridge`), and a bare `cdk deploy <Stack>` skips the API stage refresh. Documented shortcuts are
 *     allowlisted with a reason.
 *   - `script-file-orphan` [`<path>`]: a file under a scripts directory whose name no other file mentions.
 *
 * False positives: a flag for a module used only transitively (allowlist it, naming the construct); a dev
 * shortcut people type by hand (allowlist it, saying why it stays).
 *
 * Usage: node scripts/audit/repo_contracts.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { AuditError, REPO_ROOT, detectorMain, finishReport, isTestPath, listFiles, posixRel, runIfMain, walkFiles } from './audit_common.mjs'

const TOOL = 'repo_contracts'
export const PACKAGES = ['package.json', 'voc-datalake/package.json', 'voc-datalake/frontend/package.json', 'voc-datalake/lambda/stream/package.json']
const SCRIPT_DIRS = ['scripts', 'voc-datalake/scripts', 'voc-datalake/frontend/scripts', 'voc-datalake/lambda/stream/scripts']
const DOC_PATHS = ['docs', 'README.md', 'CONTRIBUTING.md', '.kiro/steering']
const CDK_TS = ['voc-datalake/lib', 'voc-datalake/bin', 'voc-datalake/scripts']
/** Where an npm script or a script file can be named from (CI, docs, hooks, scripts, configs, code). */
const CORPUS_SUFFIXES = ['.json', '.sh', '.yml', '.yaml', '.md', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.py', '.toml', '.txt']
const LIFECYCLE = new Set(['install', 'prepare', 'test', 'start', 'build', 'publish', 'pack', 'version'])
const SCRIPT_FILE = /\.(sh|mjs|cjs|js|ts|py)$/
const PATH_IN_SCRIPT = /(?<![\w@/.$-])((?:\.\.?\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:json|mjs|cjs|sh|js|ts|py|yml|toml))(?![\w.])/g

const read = (file) => readFileSync(file, 'utf8')
const words = (text) => new Set(text.match(/[\w-]+/g) ?? [])

/** The text a name can be mentioned in: every non-dependency file of the corpus (hooks have no suffix). */
function corpus(root) {
  const files = walkFiles(root, (name, full) => CORPUS_SUFFIXES.some((s) => name.endsWith(s)) || full.includes('/git-hooks/'))
    .filter((file) => !file.endsWith('package-lock.json') && !file.endsWith('CHANGELOG.md'))
  return files.map((file) => ({ rel: posixRel(root, file), text: read(file) }))
}

// ── CDK context keys and feature flags ────────────────────────────────

export function contextReads(root) {
  const keys = new Map()
  for (const { rel, file } of listFiles(root, CDK_TS, { suffixes: ['.ts'] })) {
    const text = read(file)
    const constants = new Map([...text.matchAll(/const (\w+_CONTEXT_KEY) = '(\w+)'/g)].map((m) => [m[1], m[2]]))
    for (const m of text.matchAll(/tryGetContext\(\s*(?:'([\w:-]+)'|(\w+))/g)) {
      const key = m[1] ?? constants.get(m[2])
      if (key) keys.set(key, [...(keys.get(key) ?? []), rel])
    }
  }
  return keys
}

function contextFindings(root, docs) {
  const reads = contextReads(root)
  const documented = words(docs)
  const findings = [...reads].filter(([key]) => !documented.has(key))
    .map(([key, where]) => ({ kind: 'context-undocumented', key: `context:${key}`, detail: `read in ${[...new Set(where)].join(', ')}; no doc names it` }))
  const contextFile = join(root, 'voc-datalake', 'cdk.context.json')
  const committed = existsSync(contextFile) ? Object.keys(JSON.parse(read(contextFile))) : []
  const cdkText = listFiles(root, CDK_TS, { suffixes: ['.ts'] }).map(({ file }) => read(file)).join('\n')
  const named = words(cdkText)
  for (const key of committed) {
    if (!reads.has(key) && !named.has(key)) findings.push({ kind: 'context-unread', key: `context:${key}`, detail: 'set in cdk.context.json; no CDK code names it' })
  }
  return { findings, reads: reads.size, committed: committed.length }
}

/** `@aws-cdk/aws-ecs:x` -> `aws-cdk-lib/aws-ecs`; `@aws-cdk/core:*` -> null (always used). */
export function flagModule(flag) {
  const [scope] = flag.split(':')
  if (scope === '@aws-cdk/core') return null
  if (scope === '@aws-cdk/customresources') return 'aws-cdk-lib/custom-resources'
  if (scope.startsWith('@aws-cdk/')) return `aws-cdk-lib/${scope.slice('@aws-cdk/'.length)}`
  return scope   // a separate package, e.g. `@aws-cdk-containers/ecs-service-extensions`
}

function flagFindings(root) {
  const cdkJson = join(root, 'voc-datalake', 'cdk.json')
  if (!existsSync(cdkJson)) return { findings: [], flags: 0 }
  const flags = Object.keys(JSON.parse(read(cdkJson)).context ?? {}).filter((key) => key.startsWith('@aws-cdk'))
  const code = listFiles(root, ['voc-datalake/lib', 'voc-datalake/bin'], { suffixes: ['.ts'] }).map(({ file }) => read(file)).join('\n')
  const findings = flags.filter((flag) => {
    const module = flagModule(flag)
    return module !== null && !code.includes(`'${module}'`) && !code.includes(`'${module}/`)
  }).map((flag) => ({ kind: 'flag-module-unused', key: `flag:${flag}`, detail: `nothing in lib/ or bin/ imports ${flagModule(flag)}` }))
  return { findings, flags: flags.length }
}

// ── npm scripts ───────────────────────────────────────────────────────

/** Files a script command names that do not exist, resolving `cd <dir>` steps. */
export function missingFiles(pkgDir, command) {
  let cwd = pkgDir
  const missing = []
  for (const part of command.split(/&&|;|\|\|/).map((p) => p.trim())) {
    const cd = /^cd\s+(\S+)$/.exec(part)
    if (cd) { cwd = normalize(join(cwd, cd[1])); continue }
    for (const m of part.matchAll(PATH_IN_SCRIPT)) {
      if (!existsSync(join(cwd, m[1])) && !existsSync(join(pkgDir, m[1]))) missing.push(m[1])
    }
  }
  return missing
}

/** Is `name` run from anywhere: `npm run <name>`, `npm --prefix <dir> run <name>`, `npm test` for `test`. */
export function isCalled(name, texts) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(`npm(?:\\s+--(?:prefix|silent)(?:\\s+[^\\s-]\\S*)?)*\\s+run(?:\\s+--silent)?\\s+${escaped}(?![\\w:-])`)
  return texts.some((text) => call.test(text))
}

function scriptFindings(root, texts) {
  const findings = []
  let count = 0
  for (const pkg of PACKAGES) {
    const file = join(root, pkg)
    if (!existsSync(file)) continue
    const scripts = JSON.parse(read(file)).scripts ?? {}
    for (const [name, command] of Object.entries(scripts)) {
      count += 1
      for (const path of missingFiles(dirname(file), command)) {
        findings.push({ kind: 'script-missing-file', key: `${pkg}::${name}`, detail: `names ${path}, which does not exist` })
      }
      const lifecycle = LIFECYCLE.has(name) || /^(pre|post)/.test(name)
      if (!lifecycle && !isCalled(name, texts)) {
        findings.push({ kind: 'script-uncalled', key: `${pkg}::${name}`, detail: `nothing runs \`npm run ${name}\`: ${command.slice(0, 80)}` })
      }
    }
  }
  return { findings, scripts: count }
}

/** Files under the scripts dirs whose basename (or extension-less import stem) no other file mentions. */
function orphanFindings(root, docs) {
  const files = SCRIPT_DIRS.flatMap((dir) => walkFiles(join(root, dir), (name) => SCRIPT_FILE.test(name)))
    .map((file) => posixRel(root, file))
    .filter((rel) => !rel.startsWith('scripts/audit/') && !isTestPath(rel))
  const findings = []
  for (const rel of files) {
    const base = rel.split('/').at(-1)
    const stem = base.replace(SCRIPT_FILE, '')
    const mentions = [base, `/${stem}'`, `/${stem}"`, `/${stem}.js`, `import ${stem}`, `from ${stem}`, `.${stem} import`]
    if (!docs.some(({ rel: other, text }) => other !== rel && mentions.some((m) => text.includes(m)))) {
      findings.push({ kind: 'script-file-orphan', key: rel, detail: 'no other file names it' })
    }
  }
  return { findings, files: files.length }
}

export function scan(root) {
  const all = corpus(root)
  const docText = all.filter(({ rel }) => DOC_PATHS.some((d) => rel === d || rel.startsWith(`${d}/`))).map(({ text }) => text).join('\n')
  const context = contextFindings(root, docText)
  const flags = flagFindings(root)
  const scripts = scriptFindings(root, all.map(({ text }) => text))
  const orphans = orphanFindings(root, all)
  return {
    findings: [...context.findings, ...flags.findings, ...scripts.findings, ...orphans.findings],
    counts: { contextReads: context.reads, flags: flags.flags, scripts: scripts.scripts, scriptFiles: orphans.files },
  }
}

export const main = detectorMain(TOOL, {
  usage: 'CDK context keys, cdk.json flags, npm scripts and script files that nothing documents, imports or runs.',
  spec: { root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const root = args.root ? resolve(args.root) : REPO_ROOT
  const { findings, counts } = scan(root)
  if (counts.contextReads < 10 || counts.scripts < 60 || counts.scriptFiles < 20) {
    throw new AuditError(`vacuous scan: ${JSON.stringify(counts)}`)
  }
  return finishReport(TOOL, args, findings, {
    summary: `${counts.contextReads} context keys, ${counts.flags} flags, ${counts.scripts} npm scripts, ${counts.scriptFiles} script files`,
    reportStale: !args.root,
  })
})

runIfMain(import.meta.url, main)
