#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_mock_routes — dev-mock routes no SPA call reaches, and mock exports nothing imports.
 *
 * Pattern (hunt-typescript.md §H/I: `POST /projects/{id}/prototypes/{doc}/pins/addressed|resolve` and their
 * `batchPins` helpers; `mock-design-extract.js` `mergeDesignDraft`): the dev mock (`frontend/mock-server.js`
 * + its `mock-*.js` domain modules) serves ONLY the SPA in `npm run dev`. A route whose SPA call was removed,
 * or one copied from a backend route the SPA never calls (the agent runtime's batch pin routes), is code the
 * mock carries for nobody; `check:mock` proves the reverse direction only (every SPA call is mocked).
 *
 * How (two kinds):
 *   - `mock-only`: the routes of every `frontend/mock-*.js` are read with the TypeScript parser: route keys and
 *     literals `'METHOD /path'`, `{method, pattern}` objects, `['METHOD', /re/]` table rows, `pathname === '/x'`
 *     and every other `/^\/…/` regex literal (method unknown = any). They are matched against the probes of
 *     `frontend/mock-coverage.json`, which name every SPA call site (the `check:mock` gate keeps that list
 *     complete and live). A domain module matches paths relative to its mount (`/projects/{id}` + `/research`),
 *     so a route matches a probe when it matches the probe path or any `/`-suffix of it. A route no probe of a
 *     compatible method reaches is reported.
 *   - `mock-export-unused`: an `export` of a `mock-*.js` file that no other file of the frontend (mocks, the
 *     coverage script, tests, e2e) imports. knip's project excludes the mocks, so nothing else sees it; drop the
 *     `export` (or the code, when its own module does not use it either).
 *
 * Never judged: the presigned-upload fakes the mock hands out as upload URLs (`/mock-*`) and its own dev
 * controls (`/__mock/*`). Allowlist `scripts/audit/allowlists/ts_mock_routes.json`, key
 * `<mock file>::<METHOD> <route>` (`mock-server.js::GET /^\/x$/`) or `<mock file>::export <name>`.
 *
 * Usage: node scripts/audit/ts_mock_routes.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  AuditError, REPO_ROOT, detectorMain, finishReport, loadTypeScript, posixRel, runIfMain, walkFiles,
} from './audit_common.mjs'

const TOOL = 'ts_mock_routes'
const FRONTEND = 'voc-datalake/frontend'
const MIN = { files: 20, routes: 150, probes: 200 }
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const NEVER_JUDGED = [/^\/mock-/, /^\/__mock\//, /^\^\\\/mock-/, /^\^\\\/__mock/]

const stringOf = (ts, node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined)
const regexOf = (ts, node) => {
  if (!node || !ts.isRegularExpressionLiteral(node)) return undefined
  const text = node.text
  const end = text.lastIndexOf('/')
  return { source: text.slice(1, end), flags: text.slice(end + 1) }
}

/** `[{method, path?, regex?, label}]`: the routes one mock module declares. */
export function mockRoutes(ts, text, file = 'mock.js') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const out = []
  const claimed = new Set()
  const addRegex = (method, node) => {
    const re = regexOf(ts, node)
    if (!re || !re.source.startsWith('^\\/')) return
    claimed.add(node)
    out.push({ method, regex: new RegExp(re.source, re.flags.replace(/[gy]/g, '')), label: `${method} /${re.source}/` })
  }
  const visit = (n) => {
    // {method: 'X', pattern: /re/}
    if (ts.isObjectLiteralExpression(n)) {
      const prop = (name) => n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === name)?.initializer
      const method = stringOf(ts, prop('method'))
      if (method && METHODS.has(method)) addRegex(method, prop('pattern'))
    }
    // ['X', /re/, …]
    if (ts.isArrayLiteralExpression(n) && n.elements.length >= 2) {
      const method = stringOf(ts, n.elements[0])
      if (method && METHODS.has(method)) addRegex(method, n.elements[1])
    }
    // 'X /path' as a key or a compared literal
    const literal = stringOf(ts, n)
    const m = literal && /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(literal)
    if (m) out.push({ method: m[1], path: m[2], label: `${m[1]} ${m[2]}` })
    // pathname === '/x'
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const [l, r] = [n.left, n.right]
      const path = stringOf(ts, r) ?? stringOf(ts, l)
      const other = stringOf(ts, r) === undefined ? r : l
      if (path?.startsWith('/') && /pathname$/.test(other.getText(sf))) out.push({ method: '*', path, label: `* ${path}` })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  // Remaining `/^\/…/` regexes (a `url.pathname.match(…)` next to a method check): any method.
  const rest = (n) => {
    if (ts.isRegularExpressionLiteral(n) && !claimed.has(n)) addRegex('*', n)
    ts.forEachChild(n, rest)
  }
  rest(sf)
  return out.filter((r) => !NEVER_JUDGED.some((re) => re.test(r.path ?? r.regex.source)))
}

/** The path and every `/`-suffix of it (a domain module matches below its mount). */
const suffixes = (path) => [...path.matchAll(/\//g)].map((m) => path.slice(m.index))

/** Is `route` reached by one of the probes (`[{method, path}]`)? */
export function routeReached(route, probes) {
  return probes.some((p) => {
    if (route.method !== '*' && route.method !== p.method) return false
    return suffixes(p.path).some((s) => (route.regex ? route.regex.test(s) : route.path === s))
  })
}

/** `[{name, local}]`: the names a mock module exports, and whether its own code uses each one. */
export function mockExports(ts, text, file = 'mock.js') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = []
  for (const st of sf.statements) {
    const exported = ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.push(st.name.text)
    if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text)
    }
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const e of st.exportClause.elements) names.push(e.name.text)
    }
  }
  const count = (name) => [...text.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g'))].length
  return names.map((name) => ({ name, local: count(name) > 1 }))
}

/** `Map<absolute mock file, Set<name> | '*'>`: what the other files import from each mock module. */
export function mockImports(files) {
  const used = new Map()
  const add = (target, names) => {
    if (names === '*') used.set(target, '*')
    else if (used.get(target) !== '*') used.set(target, new Set([...(used.get(target) ?? []), ...names]))
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/import\s+([^'"]*?)\s+from\s+['"]([^'"]*mock-[\w-]+\.js)['"]/g)) {
      const target = resolve(dirname(file), m[2])
      const clause = m[1]
      if (/\*\s+as\s/.test(clause)) { add(target, '*'); continue }
      const braces = /\{([^}]*)\}/.exec(clause)
      add(target, braces ? braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [])
    }
    for (const m of text.matchAll(/import\(\s*['"]([^'"]*mock-[\w-]+\.js)['"]\s*\)/g)) add(resolve(dirname(file), m[1]), '*')
  }
  return used
}

export function analyzeMockRoutes({ mocks, probes, importers }) {
  const ts = loadTypeScript()
  const findings = []
  let routes = 0
  const imports = mockImports(importers)
  for (const { file, rel } of mocks) {
    const text = readFileSync(file, 'utf8')
    const seen = new Set()
    for (const route of mockRoutes(ts, text, file)) {
      routes += 1
      if (seen.has(route.label) || routeReached(route, probes)) continue
      seen.add(route.label)
      findings.push({ key: `${rel}::${route.label}`, kind: 'mock-only', detail: 'no mock-coverage.json probe (no SPA call) reaches this route' })
    }
    const used = imports.get(file)
    for (const { name, local } of mockExports(ts, text, file)) {
      if (used === '*' || used?.has(name)) continue
      findings.push({ key: `${rel}::export ${name}`, kind: 'mock-export-unused', detail: local ? 'only its own module uses it: drop the export' : 'nothing uses it' })
    }
  }
  return { findings, routes }
}

/** The real tree's mock modules, coverage probes and the files that may import a mock. */
export function realInputs(root = REPO_ROOT) {
  const fe = join(root, FRONTEND)
  const mocks = walkFiles(fe, (name, full) => /^mock-[\w-]+\.js$/.test(name) && dirname(full) === fe)
    .map((file) => ({ file, rel: posixRel(fe, file) }))
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(fe, 'mock-coverage.json'), 'utf8'))
  } catch (error) {
    throw new AuditError(`mock-coverage.json: ${error.message}`)
  }
  if (!Array.isArray(manifest)) throw new AuditError('mock-coverage.json must be an array')
  const probes = manifest.flatMap((e) => (e.probes ?? []).map((p) => ({ method: e.method, path: String(p.path).split('?')[0] })))
  const importers = walkFiles(fe, (name) => /\.(m?js|tsx?)$/.test(name) && !name.endsWith('.d.ts'))
  return { mocks, probes, importers }
}

export const main = detectorMain(TOOL, {
  usage: 'Dev-mock routes no SPA call (mock-coverage.json probe) reaches, and mock-*.js exports nothing imports.',
  spec: { root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const inputs = realInputs(args.root ? resolve(args.root) : undefined)
  const { findings, routes } = analyzeMockRoutes(inputs)
  const counts = { files: inputs.mocks.length, routes, probes: inputs.probes.length }
  for (const [what, min] of Object.entries(MIN)) {
    if (counts[what] < min) throw new AuditError(`vacuous scan: ${counts[what]} mock ${what} (expected at least ${min})`)
  }
  return finishReport(TOOL, args, findings, {
    summary: `${counts.files} mock modules, ${routes} routes, ${counts.probes} probes`, reportStale: !args.root,
  })
})

runIfMain(import.meta.url, main)
