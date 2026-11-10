#!/usr/bin/env node
/**
 * How far behind the newest releases is everything this repo builds with? A REPORT, not a gate: run it
 * once a week, or before starting a feature, and upgrade what it lists first (docs/dependencies.md →
 * Freshness check). dependency-audit.mjs answers a different question (known vulnerabilities).
 *
 * What it compares with the newest release:
 * - npm: every package of the six lockfiles (`npm outdated --json`, needs each directory's node_modules).
 * - pip: every `==` pin and `>=` / `~=` floor in the four Lambda layers and requirements-dev.txt (PyPI).
 *   A floor is listed apart: a fresh layer build already installs the newest version it allows.
 * - Lambda runtimes: each `Runtime.PYTHON_3_x` / `Runtime.NODEJS_x_X` the CDK app uses, against the
 *   newest one the installed aws-cdk-lib knows (CDK adds a runtime once Lambda launches it).
 * - Toolchains: Node (engines, workflow `node-version`) against the newest LTS line, Python
 *   (.python-version, workflow `python-version`) against the newest release line (endoflife.date).
 * - GitHub Actions (`uses: owner/repo@sha # vX`) and the binaries pinned in the workflows (gitleaks,
 *   actionlint, zizmor) against their newest GitHub release (GITHUB_TOKEN or `gh auth token` if set).
 *
 * Every finding is classed `major`, `minor` or `patch`. Majors are upgraded deliberately (the owner's
 * rule, .github/dependabot.yml), so they are listed for planning, not to be bumped blindly.
 *
 * Usage: node scripts/dependency-freshness.mjs [--json] [--fail-on major|minor|patch]
 *   exit 0 = report printed; 1 = a finding at or above --fail-on; 2 = some check could not run (it is
 *   listed under "Not checked", so a quiet report never means "nothing was checked").
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const NPM_DIRS = [
  '.', 'voc-datalake', 'voc-datalake/frontend', 'voc-datalake/frontend/e2e', 'voc-datalake/lambda/stream',
  'tools/kiro-acp-bridge',
]
export const PIP_FILES = [
  ...['email-intake-deps', 'ingestion-deps', 'processing-deps', 'signing-deps']
    .map((layer) => `voc-datalake/lambda/layers/${layer}/requirements.txt`),
  'voc-datalake/requirements-dev.txt',
]
/** Workflow env pins → the GitHub repository whose releases they follow. */
export const PINNED_TOOLS = { GITLEAKS_VERSION: 'gitleaks/gitleaks', ACTIONLINT_VERSION: 'rhysd/actionlint',
  ZIZMOR_VERSION: 'zizmorcore/zizmor' }
const KIND_RANK = { patch: 1, minor: 2, major: 3 }
const FETCH_TIMEOUT_MS = 15_000
const FETCH_BATCH = 8

/** `v1.2.3`, `1.2`, `3.14` → [1, 2, 3]; null when it does not start with a number. */
export function versionParts(version) {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(String(version).trim())
  return match ? match[1].split('.').map(Number) : null
}

/** 'current' when `current` is at or past `latest`, else the highest part that differs. */
export function bumpKind(current, latest) {
  const a = versionParts(current)
  const b = versionParts(latest)
  if (!a || !b) return 'unknown'
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y ? 'current' : (['major', 'minor'][i] ?? 'patch')
  }
  return 'current'
}

/** `name[extra]==1.2` / `>=` / `~=` lines of a requirements file; comments and blank lines skipped. */
export function parseRequirements(text) {
  return text.split('\n').flatMap((raw) => {
    const line = raw.replace(/#.*/, '').trim()
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(==|>=|~=)\s*([0-9][^,;\s]*)/.exec(line)
    return match ? [{ name: match[1], op: match[2], version: match[3] }] : []
  })
}

/** `npm outdated --json` → findings against the newest release (`latest`), never the in-range `wanted`. */
export function parseNpmOutdated(report, where) {
  return Object.entries(report).flatMap(([name, info]) => {
    const rows = Array.isArray(info) ? info : [info]
    return rows.flatMap((row) => {
      if (!row?.current || !row.latest) return []
      const kind = bumpKind(row.current, row.latest)
      return kind === 'current' ? [] : [{ area: 'npm', where, name, current: row.current, latest: row.latest, kind }]
    })
  })
}

/** Every pinned `uses: owner/repo[/path]@<sha> # vX.Y.Z` of a workflow. */
export function parseActionUses(text) {
  const found = []
  for (const match of text.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{7,40})\s*#\s*(v?[\d.]+)/g)) {
    found.push({ repo: match[1], sha: match[2], version: match[3] })
  }
  return found
}

/** The PINNED_TOOLS versions set in a workflow (`NAME: 1.2.3`). */
export function parsePinnedTools(text) {
  return Object.entries(PINNED_TOOLS).flatMap(([key, repo]) => {
    const match = new RegExp(`${key}:\\s*['"]?([\\d.]+)`).exec(text)
    return match ? [{ name: key.replace('_VERSION', '').toLowerCase(), repo, version: match[1] }] : []
  })
}

/** `Runtime.PYTHON_3_14` → {family: 'python', version: '3.14'}; `Runtime.NODEJS_22_X` → nodejs 22. */
export function runtimeOf(constant) {
  const python = /^PYTHON_(\d+)_(\d+)$/.exec(constant)
  if (python) return { family: 'python', version: `${python[1]}.${python[2]}` }
  const node = /^NODEJS_(\d+)_X$/.exec(constant)
  return node ? { family: 'nodejs', version: node[1] } : null
}

/** The newest runtime per family among `constants`. */
export function newestRuntimes(constants) {
  const newest = {}
  for (const runtime of constants.map(runtimeOf).filter(Boolean)) {
    const seen = newest[runtime.family]
    if (!seen || bumpKind(seen, runtime.version) !== 'current') newest[runtime.family] = runtime.version
  }
  return newest
}

/** endoflife.date cycles → the newest cycle (`lts` only: truthy `lts`), as its `latest` release line. */
export function newestCycle(cycles, { lts = false } = {}) {
  const usable = cycles.filter((cycle) => !lts || cycle.lts)
  return usable.reduce((best, cycle) => (!best || bumpKind(best.cycle, cycle.cycle) !== 'current' ? cycle : best), null)
}

/** Findings at or above `failOn` (null = never fail). */
export function failing(findings, failOn) {
  if (!failOn) return []
  return findings.filter((finding) => (KIND_RANK[finding.kind] ?? 0) >= KIND_RANK[failOn])
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────────────

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  return gh.status === 0 ? gh.stdout.trim() : ''
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

/** Run `jobs` (async thunks) FETCH_BATCH at a time; settled results in order. */
async function batched(jobs) {
  const settled = []
  for (let i = 0; i < jobs.length; i += FETCH_BATCH) {
    settled.push(...await Promise.allSettled(jobs.slice(i, i + FETCH_BATCH).map((job) => job())))
  }
  return settled
}

function checkNpm(report) {
  for (const dir of NPM_DIRS) {
    const run = spawnSync('npm', ['outdated', '--json'], { cwd: join(ROOT, dir), encoding: 'utf8' })
    // npm outdated exits 1 when anything is outdated: only unparsable output is a failure.
    try {
      report.findings.push(...parseNpmOutdated(JSON.parse(run.stdout || '{}'), dir))
    } catch {
      report.unchecked.push(`npm ${dir}: ${(run.stderr || 'no JSON output').trim().split('\n')[0]}`)
    }
  }
}

async function checkPip(report) {
  const entries = PIP_FILES.flatMap((file) => parseRequirements(read(file)).map((entry) => ({ ...entry, file })))
  const names = [...new Set(entries.map((entry) => entry.name.toLowerCase()))]
  const results = await batched(names.map((name) => () => getJson(`https://pypi.org/pypi/${name}/json`)))
  const latest = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') latest[names[i]] = result.value.info.version
    else report.unchecked.push(`pip ${names[i]}: ${result.reason.message}`)
  })
  for (const entry of entries) {
    const newest = latest[entry.name.toLowerCase()]
    const kind = newest ? bumpKind(entry.version, newest) : 'current'
    if (kind === 'current') continue
    const area = entry.op === '==' ? 'pip' : 'pip floor'
    report.findings.push({ area, where: entry.file, name: entry.name, current: `${entry.op}${entry.version}`,
      latest: newest, kind })
  }
}

function libSources(dir = join(ROOT, 'voc-datalake/lib')) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return libSources(path)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : []
  })
}

function checkRuntimes(report) {
  let known
  try {
    const cdkRequire = createRequire(join(ROOT, 'voc-datalake/package.json'))
    known = Object.getOwnPropertyNames(cdkRequire('aws-cdk-lib/aws-lambda').Runtime)
  } catch (error) {
    report.unchecked.push(`Lambda runtimes: aws-cdk-lib not installed in voc-datalake (${error.message})`)
    return
  }
  const newest = newestRuntimes(known)
  const used = new Map()
  for (const file of libSources()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/Runtime\.((?:PYTHON|NODEJS)_\w+)/g)) {
      const runtime = runtimeOf(match[1])
      if (runtime) used.set(match[1], { ...runtime, file: relative(ROOT, file) })
    }
  }
  for (const [constant, runtime] of used) {
    const kind = bumpKind(runtime.version, newest[runtime.family])
    if (kind !== 'current') {
      report.findings.push({ area: 'Lambda runtime', where: runtime.file, name: constant, current: runtime.version,
        latest: newest[runtime.family], kind })
    }
  }
}

function workflowTexts() {
  const dir = join(ROOT, '.github/workflows')
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ file: `.github/workflows/${name}`, text: readFileSync(join(dir, name), 'utf8') }))
}

async function checkToolchains(report, workflows) {
  const pins = [
    { name: 'node (engines)', family: 'nodejs', where: 'package.json', version: JSON.parse(read('package.json')).engines?.node?.replace(/^[^\d]*/, '') },
    { name: 'python (.python-version)', family: 'python', where: '.python-version', version: read('.python-version').trim() },
    ...workflows.flatMap(({ file, text }) => [...text.matchAll(/(node|python)-version:\s*['"]?([\d.]+)/g)]
      .map((match) => ({ name: `${match[1]}-version`, family: match[1] === 'node' ? 'nodejs' : 'python', where: file, version: match[2] }))),
  ].filter((pin) => pin.version)
  for (const family of ['nodejs', 'python']) {
    let newest
    try {
      newest = newestCycle(await getJson(`https://endoflife.date/api/${family}.json`), { lts: family === 'nodejs' })
    } catch (error) {
      report.unchecked.push(`${family} release lines: ${error.message}`)
      continue
    }
    for (const pin of pins.filter((candidate) => candidate.family === family)) {
      // Compare the release LINE (22 vs 24, 3.12 vs 3.14), not the patch a range floor names.
      const line = family === 'nodejs' ? String(versionParts(pin.version)[0]) : versionParts(pin.version).slice(0, 2).join('.')
      const kind = bumpKind(line, newest.cycle)
      if (kind !== 'current') {
        report.findings.push({ area: 'toolchain', where: pin.where, name: pin.name, current: pin.version,
          latest: `${newest.cycle} (${newest.latest})`, kind })
      }
    }
  }
}

async function checkGithubReleases(report, workflows) {
  const token = githubToken()
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const pins = workflows.flatMap(({ file, text }) => [
    ...parseActionUses(text).map((use) => ({ area: 'GitHub Action', where: file, name: use.repo, repo: use.repo, version: use.version })),
    ...parsePinnedTools(text).map((tool) => ({ area: 'workflow tool', where: file, ...tool })),
  ])
  const repos = [...new Set(pins.map((pin) => pin.repo))]
  const results = await batched(repos.map((repo) => () => getJson(`https://api.github.com/repos/${repo}/releases/latest`, headers)))
  const latest = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') latest[repos[i]] = result.value.tag_name
    else report.unchecked.push(`GitHub release ${repos[i]}: ${result.reason.message}`)
  })
  const seen = new Set()
  for (const pin of pins) {
    const newest = latest[pin.repo]
    const key = `${pin.where} ${pin.name} ${pin.version}`
    if (!newest || seen.has(key)) continue
    seen.add(key)
    const kind = bumpKind(pin.version, newest)
    if (kind !== 'current') {
      report.findings.push({ area: pin.area, where: pin.where, name: pin.name, current: pin.version, latest: newest, kind })
    }
  }
}

function print(report) {
  const order = (finding) => -(KIND_RANK[finding.kind] ?? 0)
  const rows = [...report.findings].sort((a, b) => order(a) - order(b) || a.area.localeCompare(b.area) || a.name.localeCompare(b.name))
  const counts = Object.fromEntries(['major', 'minor', 'patch'].map((kind) => [kind, rows.filter((row) => row.kind === kind).length]))
  console.log(`Dependency freshness: ${counts.major} major, ${counts.minor} minor, ${counts.patch} patch behind the newest release`)
  for (const row of rows) {
    console.log(`  ${row.kind.padEnd(6)} ${row.area.padEnd(15)} ${row.name.padEnd(36)} ${String(row.current).padEnd(16)} → ${String(row.latest).padEnd(18)} ${row.where}`)
  }
  if (report.unchecked.length) {
    console.log(`Not checked (${report.unchecked.length}):`)
    for (const line of report.unchecked) console.log(`  ${line}`)
  }
}

async function main(args) {
  const failOnAt = args.indexOf('--fail-on')
  const failOn = failOnAt >= 0 ? args[failOnAt + 1] : null
  if (failOn !== null && !(failOn in KIND_RANK)) {
    console.error('--fail-on takes major, minor or patch')
    return 2
  }
  const report = { findings: [], unchecked: [] }
  const workflows = workflowTexts()
  checkNpm(report)
  checkRuntimes(report)
  await checkPip(report)
  await checkToolchains(report, workflows)
  await checkGithubReleases(report, workflows)
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else print(report)
  if (report.unchecked.length) return 2
  return failing(report.findings, failOn).length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
