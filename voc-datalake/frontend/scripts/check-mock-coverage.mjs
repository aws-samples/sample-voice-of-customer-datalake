#!/usr/bin/env node

/**
 * @fileoverview Gate: every API call the frontend can make has a dev-mock route.
 *
 * `npm run dev` serves the UI against `mock-server.js` (plus its `mock-*.js`
 * domain modules). A feature whose routes were never mocked renders empty or
 * broken locally, and nothing else notices. This script makes that a failure:
 *
 *   1. Every `fetchApi(...)` call site under `src/` (specs and fixtures excluded)
 *      is read with the TypeScript compiler API as `{file, method, call}`.
 *   2. Each must have an entry in `mock-coverage.json`, and every entry must
 *      still name a real call site (no stale entries).
 *   3. The mock is started on a free port and every entry's probe requests are
 *      sent. A probe FAILS on the mock's generic fallback `{"error":"Not found"}`,
 *      on 405, on any 5xx and on a dropped connection. A route-specific 4xx
 *      (validation, "Project not found") passes: the route exists.
 *
 * New feature? Add the mock route (see mock-server.js `handleDomainModules`),
 * then add the call site printed by this script to mock-coverage.json with a
 * concrete probe (real fixture ids, a minimal valid body).
 *
 * Usage: node scripts/check-mock-coverage.mjs        Exit: 0 covered, 1 not.
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(FRONTEND, 'src')
const MANIFEST = join(FRONTEND, 'mock-coverage.json')
const ts = createRequire(join(FRONTEND, 'package.json'))('typescript')

const EXCLUDED = /\.test\.|-fixtures\.|[/\\]test[/\\]|test-utils/
const OPTION_HELPERS = { post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' }
const STARTUP_TIMEOUT_MS = 10_000
/** A route that never answers (e.g. a handler that forgets to end the response) fails instead of hanging CI. */
const PROBE_TIMEOUT_MS = 10_000

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !EXCLUDED.test(full) ? [full] : []
  })
}

/** The HTTP method of a fetchApi options argument: `{method: 'X'}`, a `post(...)`-style helper, or GET. */
function methodOf(options, source) {
  if (!options) return 'GET'
  const text = options.getText(source)
  const literal = /method:\s*['"](\w+)['"]/.exec(text)
  if (literal) return literal[1]
  const helper = /^(\w+)\(/.exec(text)
  return (helper && OPTION_HELPERS[helper[1]]) ?? `UNKNOWN(${text.slice(0, 40)})`
}

/** `file\tmethod\tcall` for every fetchApi call site under `srcDir`, de-duplicated. */
export function collectCallSites(srcDir = SRC) {
  const sites = new Map()
  for (const file of sourceFiles(srcDir)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetchApi' && node.arguments.length > 0) {
        const site = {
          file: relative(srcDir, file).split('\\').join('/'),
          method: methodOf(node.arguments[1], source),
          call: node.arguments[0].getText(source).replace(/\s+/g, ' '),
        }
        sites.set(siteKey(site), site)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

export const siteKey = ({ file, method, call }) => `${file}\t${method}\t${call}`

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

function startMock(port) {
  const child = spawn(process.execPath, ['mock-server.js'], { cwd: FRONTEND, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mock-server.js did not start within ${STARTUP_TIMEOUT_MS} ms`))
    }, STARTUP_TIMEOUT_MS)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Mock API server running')) {
        clearTimeout(timer)
        resolveStart(child)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock-server.js exited (${code}) before listening:\n${stderr}`))
    })
  })
}

/** null when the mock serves the probe, else the reason it does not. */
export async function probeFailure(base, method, { path, body }) {
  let response
  try {
    response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    return `request failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const text = (await response.text()).trim()
  if (response.status === 404 && text === '{"error":"Not found"}') return 'no mock route (generic 404)'
  if (response.status === 405) return 'method not mocked (405)'
  if (response.status >= 500) return `mock error ${response.status}: ${text.slice(0, 120)}`
  return null
}

function readManifest() {
  const entries = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (!Array.isArray(entries)) throw new Error('mock-coverage.json must be an array')
  return new Map(entries.map((entry) => [siteKey(entry), entry]))
}

/** Sites missing from the manifest, stale entries, and entries without probes. */
export function manifestProblems(sites, manifest) {
  const problems = []
  for (const [key, site] of sites) {
    if (site.method.startsWith('UNKNOWN')) problems.push(`cannot tell the HTTP method of ${site.file}: fetchApi(${site.call}, ${site.method})`)
    else if (!manifest.has(key)) problems.push(`not in mock-coverage.json: ${JSON.stringify({ file: site.file, method: site.method, call: site.call })}`)
  }
  for (const [key, entry] of manifest) {
    if (!sites.has(key)) problems.push(`stale mock-coverage.json entry (no such call site any more): ${entry.file} ${entry.method} ${entry.call}`)
    if (!Array.isArray(entry.probes) || entry.probes.length === 0) problems.push(`entry without probes: ${entry.file} ${entry.method} ${entry.call}`)
  }
  return problems
}

/** Start the mock, send every probe, stop the mock; the failures. */
async function probeProblems(manifest) {
  const port = await freePort()
  const mock = await startMock(port)
  const problems = []
  try {
    const base = `http://127.0.0.1:${port}`
    for (const entry of manifest.values()) {
      for (const probe of entry.probes ?? []) {
        const failure = await probeFailure(base, entry.method, probe)
        if (failure) problems.push(`${entry.method} ${probe.path} (${entry.file}): ${failure}`)
      }
    }
  } finally {
    mock.kill()
  }
  return problems
}

async function main() {
  const sites = collectCallSites()
  const manifest = readManifest()
  const problems = [...manifestProblems(sites, manifest), ...await probeProblems(manifest)]
  if (problems.length > 0) {
    console.error(`mock coverage: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
    console.error('\nEvery frontend API call needs a dev-mock route: mock it (mock-server.js / mock-<domain>.js), then add the')
    console.error('call site above to mock-coverage.json with a probe. Rule: "Every frontend API call must be mocked" in .kiro/steering/tech.md.')
    process.exit(1)
  }
  console.log(`mock coverage: ${sites.size} call sites, ${[...manifest.values()].reduce((n, e) => n + e.probes.length, 0)} probes, all mocked`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
