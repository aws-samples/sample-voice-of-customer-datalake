#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_api_callers — SPA API client functions (`frontend/src/api/*.ts`) only tests call.
 *
 * Pattern (deadts.md §1a: `api.getPersonas`, 18 `api.*` project delegates, `scrapersApi.getScraperRuns`,
 * `memoryApi.update`, `reprocessApi.get`, `workflowsApi.importDefinition`): a request function whose
 * product caller was removed lives on because its spec still calls it, and it keeps a backend route,
 * a dev-mock route and a `mock-coverage.json` entry alive with it. This is the SPA side of the route
 * audit (e1's `py_*` route callers start from the backend): every function here names the route it
 * requests, so a `test-only` row is also a candidate dead route.
 *
 * How: the frontend program (`tsconfig.test.json`) through a LanguageService. Targets are the
 * function-valued exports and object-table members (`api.x`, `projectsApi.x`, nested tables too) of
 * the non-spec files in `src/api/` that issue a request — call `fetch`/`fetchApi`, or (transitively)
 * another function of `src/api/` that does. Each target's `findReferences` is split into spec
 * references, references from inside another target (a delegate: `api.getProjects` →
 * `projectsApi.getProjects`), and production references. A target is live when a production
 * reference outside the targets exists or a live target delegates to it (fixed point). Reported:
 * `test-only` (specs call it, or only test-only delegates do) and `uncalled` (nothing references it).
 *
 * Why the reference tools miss it: knip counts a spec import as a use (and cannot see object members);
 * `knip --production` drops specs but still sees `api` itself used; `ts_reachability.mjs` reports the
 * same symbols among everything else, without the route.
 *
 * Known false-positive classes (allowlist `scripts/audit/allowlists/ts_api_callers.json`, key
 * `frontend:<file>#<name>`):
 *   - a function pinned by a backend lockstep test (`api.generateDocument`, test_doc_type_lockstep.py);
 *   - a call reached only through a computed member (`api[name]()`), which findReferences cannot see.
 *
 * Usage: node scripts/audit/ts_api_callers.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { resolve } from 'node:path'
import {
  AuditError, createService, detectorMain, finishReport, loadTypeScript, ownSourceFiles, posixRel, realPrograms, runIfMain,
} from './audit_common.mjs'
import { unwrapTable } from './ts_reach_graph.mjs'

const TOOL = 'ts_api_callers'
const MIN_TARGETS = 100

/** `[{name, node, body}]`: function-valued exports and table members of one api file. */
export function apiTargets(ts, sf) {
  const out = []
  const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
  const table = (lit, prefix) => {
    for (const p of lit.properties) {
      const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined
      if (!name) continue
      if (ts.isMethodDeclaration(p)) out.push({ name: `${prefix}.${name}`, node: p, body: p })
      else if (ts.isPropertyAssignment(p) && isFn(p.initializer)) out.push({ name: `${prefix}.${name}`, node: p, body: p.initializer })
      else if (ts.isPropertyAssignment(p) && unwrapTable(ts, p.initializer)) table(unwrapTable(ts, p.initializer), `${prefix}.${name}`)
    }
  }
  for (const st of sf.statements) {
    const exported = ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isFunctionDeclaration(st) && st.name) out.push({ name: st.name.text, node: st, body: st })
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      if (isFn(d.initializer)) out.push({ name: d.name.text, node: d, body: d.initializer })
      const lit = unwrapTable(ts, d.initializer)
      if (lit) table(lit, d.name.text)
    }
  }
  return out
}

/** The route a body requests: the first fetch/fetchApi URL, or `→ target (its route)` for a delegate. */
function routeOf(ts, t, targetOf, seen = new Set()) {
  if (seen.has(t)) return '?'
  seen.add(t)
  let found
  const visit = (n) => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const name = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''
      const callee = targetOf(n.expression)
      if (name === 'fetch' || name === 'fetchApi') found = n.arguments[0]?.getText() ?? '(no url)'
      else if (callee?.requests) found = `→ ${callee.name} (${routeOf(ts, callee, targetOf, seen)})`
    }
    ts.forEachChild(n, visit)
  }
  visit(t.body)
  return found ?? '?'
}

export function analyzeApiCallers(def) {
  const ts = loadTypeScript()
  const { service, program, checker } = createService(ts, def)
  const rel = (f) => posixRel(def.base, resolve(f))
  const apiFiles = ownSourceFiles(program, def).filter((sf) => /^src\/api\/[^/]+\.tsx?$/.test(rel(sf.fileName)) && !def.isTestFile(rel(sf.fileName)))
  const targets = apiFiles.flatMap((sf) => apiTargets(ts, sf).map((t) => ({ ...t, rel: rel(sf.fileName) })))
  const declOf = (expr) => {
    const node = ts.isPropertyAccessExpression(expr) ? expr.name : expr
    let sym = checker.getSymbolAtLocation(node)
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    return sym?.declarations ?? []
  }
  // Which targets issue a request: fetch/fetchApi, or a call to a target that does (fixed point).
  const byNode = new Map(targets.map((t) => [t.node, t]))
  const calls = new Map(targets.map((t) => [t, []]))
  for (const t of targets) {
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const name = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ''
        if (name === 'fetch' || name === 'fetchApi') t.requests = true
        for (const d of declOf(n.expression)) if (byNode.has(d)) calls.get(t).push(byNode.get(d))
      }
      ts.forEachChild(n, visit)
    }
    visit(t.body)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const t of targets) {
      if (!t.requests && calls.get(t).some((c) => c.requests)) t.requests = changed = true
    }
  }
  const requesting = targets.filter((t) => t.requests)
  const targetOf = (e) => declOf(e).map((d) => byNode.get(d)).find(Boolean)
  // References → spec / delegate / production.
  const within = (file, pos) => targets.find((t) => t.body.getSourceFile().fileName === file && pos >= t.body.getStart() && pos < t.body.getEnd())
  for (const t of requesting) {
    t.test = 0
    t.prod = 0
    t.from = new Set()
    const nameNode = t.node.name ?? t.node
    for (const group of service.findReferences(t.node.getSourceFile().fileName, nameNode.getStart()) ?? []) {
      for (const r of group.references) {
        if (r.isDefinition) continue
        if (def.isTestFile(rel(r.fileName))) t.test += 1
        else {
          const owner = within(resolve(r.fileName), r.textSpan.start)
          if (owner && owner !== t) t.from.add(owner)
          else if (!owner) t.prod += 1
        }
      }
    }
  }
  const live = new Set(requesting.filter((t) => t.prod > 0))
  for (let changed = true; changed;) {
    changed = false
    for (const t of requesting) {
      if (!live.has(t) && [...t.from].some((f) => live.has(f))) {
        live.add(t)
        changed = true
      }
    }
  }
  const findings = requesting.filter((t) => !live.has(t)).map((t) => ({
    key: `${def.name}:${t.rel}#${t.name}`,
    kind: t.test || t.from.size ? 'test-only' : 'uncalled',
    detail: `${t.rel}:${t.node.getSourceFile().getLineAndCharacterOfPosition(t.node.getStart()).line + 1} route ${routeOf(ts, t, targetOf)}; spec refs ${t.test}${t.from.size ? `; via ${[...t.from].map((f) => f.name).join(', ')}` : ''}`,
  }))
  return { findings, targets: requesting.length }
}

export const main = detectorMain(TOOL, {
  usage: 'SPA API client functions (frontend/src/api) only specs call, with the route each one requests.',
  spec: { root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const def = realPrograms(args.root ? resolve(args.root) : undefined).find((d) => d.name === 'frontend')
  if (!def) throw new AuditError('no frontend program')
  const { findings, targets } = analyzeApiCallers(def)
  if (targets < MIN_TARGETS) throw new AuditError(`vacuous scan: ${targets} request functions in src/api (expected at least ${MIN_TARGETS})`)
  return finishReport(TOOL, args, findings, { summary: `${targets} request functions`, reportStale: !args.root })
})

runIfMain(import.meta.url, main)
