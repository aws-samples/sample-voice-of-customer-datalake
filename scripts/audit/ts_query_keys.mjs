#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_query_keys — TanStack Query keys spelled inline where another file spells the same key.
 *
 * Pattern (hunt-typescript.md F, 5.34): `['users']` was written inline at 9 sites in 4 files, `['scrapers']` at 6,
 * `['model-settings']` at 4 — next to 201 keys read through key constants (`api/projectQueryKeys.ts` is the
 * precedent). A typo or a rename in one copy silently stops an invalidation: the page keeps working on stale data
 * and nothing fails.
 *
 * How: in SPA production code, an array literal whose first element is a string is a query-key SITE when it is
 *   - the value of a `queryKey:` property, or
 *   - the first argument of a QueryClient call (`invalidateQueries`, `setQueryData`, `getQueryData`,
 *     `removeQueries`, `cancelQueries`, `refetchQueries`, `fetchQuery`, `prefetchQuery`, `ensureQueryData`,
 *     `setQueriesData`, `getQueriesData`, `resetQueries`, `isFetching`);
 * and a key CONSTANT when it is returned or held by a declaration whose name ends in `Key` / `Keys` / `KEY`
 * (`export const usersKey = () => ['users'] as const`). It reports a head string
 *   - `inline-shared`: written inline in 2+ files;
 *   - `inline-beside-constant`: written inline while a key constant with that head exists.
 * One file repeating its own private key is the precedent's rule ("a key stays private to its page until a second
 * feature reads it") and is not reported.
 *
 * Why the reference tools miss it: a query key is a plain array of strings to tsc and eslint; the TanStack eslint
 * plugin checks dependencies, not cross-file spelling.
 *
 * Allowlist `scripts/audit/allowlists/ts_query_keys.json`, key `qk:<head>`.
 *
 * Usage: node scripts/audit/ts_query_keys.mjs [--root <repo>] [--no-allowlist] [--min-sites N] [--json [PATH]] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync } from 'node:fs'
import {
  listFiles, loadTypeScript, runIfMain, scanDetectorMain, unwrapExpression,
} from './audit_common.mjs'

const TOOL = 'ts_query_keys'
const SPA = 'voc-datalake/frontend/src'
const CLIENT_CALLS = new Set(['invalidateQueries', 'setQueryData', 'getQueryData', 'removeQueries', 'cancelQueries',
  'refetchQueries', 'fetchQuery', 'prefetchQuery', 'ensureQueryData', 'setQueriesData', 'getQueriesData',
  'resetQueries', 'isFetching'])
const KEY_NAME = /(Key|Keys|KEY|KEYS)$/

/**
 * The head of a key array literal: its first element when that is a string, joined with the second when that is
 * a string too (`['assistant', 'brand-preview']` → `assistant/brand-preview`), so distinct keys under one namespace
 * word stay distinct; else ''.
 */
function headOf(ts, node) {
  const arr = unwrapExpression(ts, node)
  if (!arr || !ts.isArrayLiteralExpression(arr) || !arr.elements.length) return ''
  const [first, second] = arr.elements
  if (!ts.isStringLiteralLike(first)) return ''
  return second && ts.isStringLiteralLike(second) ? `${first.text}/${second.text}` : first.text
}

/** The name of the declaration an expression is the value (or arrow body) of, if any. */
function holderName(ts, node) {
  let cur = node
  for (let hops = 0; cur && hops < 6; hops += 1) {
    const parent = cur.parent
    if (!parent) return ''
    if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name && ts.isIdentifier(parent.name)) return parent.name.text
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) return parent.name.getText()
    if (!(ts.isArrowFunction(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
      || ts.isSatisfiesExpression(parent) || ts.isReturnStatement(parent) || ts.isBlock(parent))) return ''
    cur = parent
  }
  return ''
}

/** `{sites: [{head, rel, line}], constants: Set<head>, all}` of one module (`all` = every key site, inline or not). */
export function keySites(ts, rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const sites = []
  const constants = new Set()
  let all = 0
  const site = (node) => {
    all += 1
    const head = headOf(ts, node)
    if (head) sites.push({ head, rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
  }
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'queryKey') site(node.initializer)
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && CLIENT_CALLS.has(node.expression.name.text) && node.arguments[0]
      && !ts.isObjectLiteralExpression(node.arguments[0])) {
      site(node.arguments[0])
    } else if (ts.isArrayLiteralExpression(node)) {
      const head = headOf(ts, node)
      const holder = holderName(ts, node)
      if (head && holder !== 'queryKey' && KEY_NAME.test(holder)) constants.add(head)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { sites, constants, all }
}

/** `{findings, sites}` over the SPA of `root`. */
export function scanQueryKeys(root) {
  const ts = loadTypeScript(root)
  const byHead = new Map()
  const constants = new Set()
  let total = 0
  for (const { rel, file } of listFiles(root, [SPA], { suffixes: ['.ts', '.tsx'] })) {
    const out = keySites(ts, rel, readFileSync(file, 'utf8'))
    out.constants.forEach((h) => constants.add(h))
    total += out.all
    for (const s of out.sites) byHead.set(s.head, [...(byHead.get(s.head) ?? []), s])
  }
  const findings = []
  for (const [head, list] of byHead) {
    const files = new Set(list.map((s) => s.rel))
    const kind = constants.has(head) ? 'inline-beside-constant' : (files.size > 1 ? 'inline-shared' : '')
    if (!kind) continue
    findings.push({ key: `qk:${head}`, kind, detail: `${list.length} inline site(s) in ${files.size} file(s): ${list.map((s) => `${s.rel}:${s.line}`).join(', ')}` })
  }
  return { findings, sites: total }
}

export const main = scanDetectorMain(TOOL, {
  usage: 'Inline TanStack Query keys whose head another file also spells inline, or a key constant already owns.',
  minFlag: 'min-sites', min: 150, what: 'query-key sites',
}, (root) => {
  const { findings, sites } = scanQueryKeys(root)
  return { findings, count: sites, summary: `${sites} query-key sites` }
})

runIfMain(import.meta.url, main)
