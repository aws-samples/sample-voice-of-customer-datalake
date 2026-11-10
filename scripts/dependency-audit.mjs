#!/usr/bin/env node
/**
 * Known-vulnerability audit of every dependency tree in the repo, run the same way locally and in
 * `.github/workflows/dependency-audit.yml`.
 *
 * Why it exists: Dependabot alerts only tell the repository admins, and only about the default branch.
 * This makes a known advisory a red check on the pull request that touches a lockfile or requirements
 * file, and (through the weekly scheduled run and scheduled-failure-watch.yml) an issue when a new
 * advisory lands against code nobody is changing.
 *
 * What it checks, and what fails:
 * - npm, each lockfile in NPM_DIRS, via `npm audit --json` (reads the lockfile; needs no node_modules).
 *   Production tree (`--omit=dev`): an advisory of severity high or critical fails.
 *   Development tree (the rest): critical fails; high is reported only. Dev tools (vite, eslint, vitest)
 *   never ship to a Lambda or to the SPA bundle, so a high one should not block unrelated pull requests,
 *   but a critical one runs on every contributor's machine and in CI.
 * - Python, each Lambda layer's requirements.txt: pip resolves it the way the layer build would (Lambda
 *   target: manylinux2014_aarch64, CPython 3.14, wheels only) into exact pins, then `pip-audit` checks
 *   those pins against the PyPI advisory database. Any known vulnerability fails: pip-audit reports no
 *   severity. requirements-dev.txt (test and lint tools, resolved for this host) is reported only.
 * - The reviewed-ignore file (.github/dependency-audit-ignore.json): every entry needs an advisory id,
 *   the package, a reason and an expiry date at most MAX_IGNORE_DAYS ahead. A malformed or expired entry
 *   fails; an entry that matched nothing is reported so it can be deleted. See docs/dependencies.md.
 * - An audit that could not run (no network, lockfile error, unresolvable requirements) fails: an
 *   empty result must mean "nothing known", never "nothing checked".
 *
 * Limits: it knows only PUBLISHED advisories (npm's registry database and PyPI's via pip-audit), so it
 * proves nothing about unreported flaws or malicious releases (Dependabot's cooldown and the license gate
 * are separate controls). Python resolution happens at audit time: an open range (`>=`) is audited at the
 * newest version pip picks today, which is what a fresh layer build installs, not what a past deploy
 * shipped. The Lambda target is emulated by pip's --platform flags, not by the build container.
 *
 * Usage: node scripts/dependency-audit.mjs [--skip-npm] [--skip-pip]
 *   PIP_AUDIT    pip-audit executable (default `pip-audit`; the workflow pins and installs it)
 *   AUDIT_PYTHON interpreter whose pip resolves the requirements (default `python3`)
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const IGNORE_FILE = '.github/dependency-audit-ignore.json'
export const MAX_IGNORE_DAYS = 90
export const NPM_DIRS = [
  '.',
  'voc-datalake',
  'voc-datalake/frontend',
  'voc-datalake/frontend/e2e',
  'voc-datalake/lambda/stream',
  'tools/kiro-acp-bridge',
]
const LAMBDA_TARGET = ['--platform', 'manylinux2014_aarch64', '--python-version', '3.14', '--implementation', 'cp', '--only-binary=:all:']
export const PIP_TARGETS = [
  ...['email-intake-deps', 'ingestion-deps', 'processing-deps', 'signing-deps'].map((layer) => ({
    file: `voc-datalake/lambda/layers/${layer}/requirements.txt`,
    gating: true,
    resolveArgs: LAMBDA_TARGET,
  })),
  { file: 'voc-datalake/requirements-dev.txt', gating: false, resolveArgs: [] },
]

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }
const ID_PATTERN = /^(GHSA(-[23456789cfghjmpqrvwx]{4}){3}|PYSEC-\d{4}-\d+|CVE-\d{4}-\d+)$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** True when an npm finding fails the audit: production high+, development critical. */
export function npmFindingGates(finding) {
  const floor = finding.scope === 'production' ? SEVERITY_RANK.high : SEVERITY_RANK.critical
  return (SEVERITY_RANK[finding.severity] ?? SEVERITY_RANK.critical) >= floor
}

/** The advisory id npm links to (`https://github.com/advisories/GHSA-…`), else npm's numeric source. */
function npmAdvisoryId(via) {
  const match = /\/(GHSA-[\w-]+)$/.exec(typeof via.url === 'string' ? via.url : '')
  return match === null ? `npm-${String(via.source)}` : match[1]
}

/**
 * Advisories in an `npm audit --json` report (auditReportVersion 2), one per advisory and package.
 * A vulnerability whose `via` holds only package names is vulnerable through another entry, which
 * carries the advisory itself, so only object `via` entries are read.
 */
export function parseNpmAudit(report) {
  if (report === null || typeof report !== 'object' || report.error !== undefined) {
    throw new Error(`npm audit failed: ${JSON.stringify(report?.error ?? report).slice(0, 300)}`)
  }
  if (report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object') {
    throw new Error('npm audit printed a report this script does not understand (expected auditReportVersion 2)')
  }
  const found = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (via === null || typeof via !== 'object') continue
      const id = npmAdvisoryId(via)
      found.set(`${id} ${via.name}`, { id, aliases: [], package: via.name, severity: via.severity, title: via.title ?? '', url: via.url ?? '' })
    }
  }
  return [...found.values()]
}

/** Findings of a `pip-audit -f json` report, one per advisory and package (pip-audit repeats some). */
export function parsePipAudit(report) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.dependencies)) {
    throw new Error('pip-audit printed a report this script does not understand (no "dependencies" list)')
  }
  const found = new Map()
  for (const dependency of report.dependencies) {
    for (const vuln of dependency.vulns ?? []) {
      found.set(`${vuln.id} ${dependency.name}`, {
        id: vuln.id,
        aliases: vuln.aliases ?? [],
        package: dependency.name,
        version: dependency.version,
        fixVersions: vuln.fix_versions ?? [],
      })
    }
  }
  return [...found.values()]
}

/** Problems with one ignore entry, judged on `today` (YYYY-MM-DD, UTC). */
function ignoreEntryProblems(entry, index, today) {
  const where = `${IGNORE_FILE} entry ${index + 1}`
  if (entry === null || typeof entry !== 'object') return [`${where} is not an object`]
  const problems = []
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) problems.push(`${where}: "id" must be a GHSA, PYSEC or CVE id`)
  if (typeof entry.package !== 'string' || entry.package.trim() === '') problems.push(`${where}: "package" is required`)
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) problems.push(`${where}: "reason" must explain the decision (20+ characters)`)
  if (typeof entry.expires !== 'string' || !DATE_PATTERN.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
    problems.push(`${where}: "expires" must be a date, YYYY-MM-DD`)
    return problems
  }
  const daysLeft = (Date.parse(entry.expires) - Date.parse(today)) / DAY_MS
  if (daysLeft < 0) problems.push(`${where} (${entry.id}) expired on ${entry.expires}: fix the dependency or review the ignore again`)
  if (daysLeft > MAX_IGNORE_DAYS) problems.push(`${where} (${entry.id}) expires more than ${MAX_IGNORE_DAYS} days ahead`)
  return problems
}

/** `{ignores, problems}` of the parsed ignore file. Only an entry without problems ignores anything. */
export function validateIgnores(file, today) {
  if (file === null || typeof file !== 'object' || !Array.isArray(file.ignores)) {
    return { ignores: [], problems: [`${IGNORE_FILE} must be an object with an "ignores" list`] }
  }
  const ignores = []
  const problems = []
  file.ignores.forEach((entry, index) => {
    const entryProblems = ignoreEntryProblems(entry, index, today)
    problems.push(...entryProblems)
    if (entryProblems.length === 0) ignores.push(entry)
  })
  return { ignores, problems }
}

const sameName = (a, b) => a.toLowerCase().replaceAll('_', '-') === b.toLowerCase().replaceAll('_', '-')

/** The ignore entry covering a finding (same package, id or alias), if any. */
export function matchIgnore(finding, ignores) {
  return ignores.find(
    (entry) => sameName(entry.package, finding.package) && (entry.id === finding.id || finding.aliases.includes(entry.id)),
  )
}

/** Splits findings into failing, reported-only and ignored, and marks which ignores were used. */
export function classify(findings, ignores, used) {
  const result = { failing: [], reported: [], ignored: [] }
  for (const finding of findings) {
    const entry = matchIgnore(finding, ignores)
    if (entry !== undefined) {
      used.add(entry)
      result.ignored.push({ ...finding, until: entry.expires })
    } else {
      result[finding.gates ? 'failing' : 'reported'].push(finding)
    }
  }
  return result
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`could not run ${command}: ${result.error.message}`)
  return result
}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} did not print JSON`)
  }
}

function npmReport(dir, extraArgs) {
  const result = run('npm', ['audit', '--json', ...extraArgs], join(ROOT, dir))
  return parseNpmAudit(parseJson(result.stdout, `npm audit in ${dir}`))
}

/** Findings for one npm directory: production advisories, then the ones only the dev tree has. */
function auditNpmDir(dir) {
  const production = npmReport(dir, ['--omit=dev'])
  const seen = new Set(production.map((f) => `${f.id} ${f.package}`))
  const development = npmReport(dir, []).filter((f) => !seen.has(`${f.id} ${f.package}`))
  return [
    ...production.map((f) => ({ ...f, scope: 'production' })),
    ...development.map((f) => ({ ...f, scope: 'development' })),
  ].map((f) => ({ ...f, where: dir, gates: npmFindingGates(f) }))
}

/** `name==version` lines pip would install for a requirements file (pip's --dry-run --report). */
function resolvePins(target, scratch) {
  const reportPath = join(scratch, 'resolved.json')
  const python = process.env.AUDIT_PYTHON || 'python3'
  const args = ['-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--quiet', '--disable-pip-version-check',
    ...target.resolveArgs, '--report', reportPath, '-r', join(ROOT, target.file)]
  const result = run(python, args, ROOT)
  if (result.status !== 0) throw new Error(`pip could not resolve ${target.file}: ${result.stderr.trim().slice(-500)}`)
  const install = parseJson(readFileSync(reportPath, 'utf8'), 'pip --report').install ?? []
  return install.map((item) => `${item.metadata.name}==${item.metadata.version}`)
}

function auditPipTarget(target) {
  const scratch = mkdtempSync(join(tmpdir(), 'dependency-audit-'))
  try {
    const pinned = join(scratch, 'pinned.txt')
    writeFileSync(pinned, `${resolvePins(target, scratch).join('\n')}\n`)
    const args = ['-r', pinned, '--no-deps', '--disable-pip', '--strict', '-f', 'json', '--progress-spinner', 'off', '--desc', 'off', '--aliases', 'on']
    const result = run(process.env.PIP_AUDIT || 'pip-audit', args, ROOT)
    if (result.status !== 0 && result.status !== 1) throw new Error(`pip-audit failed on ${target.file}: ${result.stderr.trim().slice(-500)}`)
    const findings = parsePipAudit(parseJson(result.stdout, `pip-audit on ${target.file}`))
    return findings.map((f) => ({ ...f, scope: target.gating ? 'production' : 'development', where: target.file, gates: target.gating }))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function describe(finding) {
  const version = finding.version === undefined ? '' : `@${finding.version}`
  const detail = finding.severity === undefined ? `fixed in ${finding.fixVersions.join(', ') || 'no release yet'}` : finding.severity
  return `${finding.where}: ${finding.package}${version} ${finding.id} (${finding.scope}, ${detail})`
}

function report(lines) {
  const text = lines.join('\n')
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Dependency audit\n\n\`\`\`\n${text}\n\`\`\`\n`)
}

function collect(options, errors) {
  const jobs = [
    ...(options.skipNpm ? [] : NPM_DIRS.map((dir) => () => auditNpmDir(dir))),
    ...(options.skipPip ? [] : PIP_TARGETS.map((target) => () => auditPipTarget(target))),
  ]
  return jobs.flatMap((job) => {
    try {
      return job()
    } catch (error) {
      errors.push(error.message)
      return []
    }
  })
}

function main(argv) {
  const options = { skipNpm: argv.includes('--skip-npm'), skipPip: argv.includes('--skip-pip') }
  const today = new Date().toISOString().slice(0, 10)
  const { ignores, problems } = validateIgnores(parseJson(readFileSync(join(ROOT, IGNORE_FILE), 'utf8'), IGNORE_FILE), today)
  const errors = [...problems]
  const used = new Set()
  const { failing, reported, ignored } = classify(collect(options, errors), ignores, used)
  const unused = ignores.filter((entry) => !used.has(entry))
  const lines = [
    ...errors.map((e) => `ERROR ${e}`),
    ...failing.map((f) => `FAIL ${describe(f)}`),
    ...reported.map((f) => `REPORT ${describe(f)} (not gating)`),
    ...ignored.map((f) => `IGNORED ${describe(f)} until ${f.until}`),
    ...unused.map((e) => `UNUSED ignore ${e.id} (${e.package}): it matched nothing, delete it`),
    `dependency audit: ${failing.length} failing, ${reported.length} reported, ${ignored.length} ignored, ${errors.length} errors`,
  ]
  report(lines)
  return failing.length + errors.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
