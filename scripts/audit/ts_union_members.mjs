#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_union_members — string-literal union members nothing ever produces.
 *
 * Pattern (deadts.md §1c: `OverviewStep 'remix'` as a next step, `Tone 'aim'`): a union such as
 * `type Tone = 'ok' | 'warn' | 'aim'` keeps a member alive in the type system long after the last code
 * path that could produce it is gone. The `switch` cases, `=== 'aim'` branches, `Record<Tone, …>`
 * table rows, CSS classes and locale strings for it are then dead too, and nothing complains.
 *
 * How: every string-literal union of production code in the three programs (type aliases, and inline
 * unions of interface/type-literal members) is collected. Every string literal of production code is
 * classified by where it sits:
 *   - `compare`: an operand of `===`/`!==`/`==`/`!=`, a `case`, the argument of `.includes`/`.has`/
 *     `.indexOf`/`.startsWith`/`.endsWith`, or an element of an array literal those are called on;
 *   - `key`: an object-literal key (identifiers too) or `x['v']`;
 *   - `decoder`: inside `z.enum(…)`/`z.literal(…)`;
 *   - `table-read`: `steps.remix` on a mapped type (`Record<U, X>`): the member is a key of a table
 *     typed by the union. Listed, not counted as a producer: the table being keyed by U says nothing
 *     about whether a VALUE of U is ever 'remix' (the 5.28 `nextStep === 'remix'` branch);
 *   - `produce`: anything else in value position (returned, assigned, passed, a JSX attribute, a
 *     property value, an array element).
 * A produce site counts for union U when its contextual type contains every member of U (it is U, or a
 * superset) or only members of U (a narrower union that flows into U: `useState<'pending'|'declining'>`),
 * or when it has no literal contextual type at all (`const s = 'v'`, a widened `string`):
 * the latter is conservative, so a common word produced anywhere hides a dead member (the recall
 * caveat of the 5.28 audit). Computed producers count as wildcards: a TS template literal in value
 * position with at least 3 static characters (`\`generate_${kind}\``) and a Python f-string
 * (`f'generate_{doc_type}'`) produce every member they match. Backend producers count too: every quoted string in non-test Python under
 * `voc-datalake/lambda` and `voc-datalake/plugins`, and their JSON (a wire union is produced by the
 * API). A member with no produce site is reported as `never-produced` (with its compare/key/decoder
 * counts: those are the dead branches) or `unused-member` (no site at all).
 *
 * Why the reference tools miss it: tsc only checks that produced values are members, never that every
 * member is produced; knip/vulture work on names, not values.
 *
 * Known false-positive classes (allowlist `scripts/audit/allowlists/ts_union_members.json`, key
 * `<program>:<file>#<Union>.'<member>'`):
 *   - values a platform API produces (`Notification.permission` → `'granted'`);
 *   - members produced from a value typed `string` that the checker cannot narrow (read from storage,
 *     a URL parameter) and then cast;
 *   - forward-compatible wire members the backend will send (say so in the reason).
 *
 * Usage: node scripts/audit/ts_union_members.mjs [--program frontend|stream|cdk] [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  AuditError, createService, detectorMain, finishReport, isTestPath, loadTypeScript, ownSourceFiles, posixRel, runIfMain,
  selectPrograms, walkFiles,
} from './audit_common.mjs'

const TOOL = 'ts_union_members'
const COMPARE_OPS = new Set(['EqualsEqualsEqualsToken', 'ExclamationEqualsEqualsToken', 'EqualsEqualsToken', 'ExclamationEqualsToken'])
const COMPARE_METHODS = new Set(['includes', 'has', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith'])
const MIN_UNIONS = { frontend: 40, stream: 10, cdk: 1 }

/** `{name, values, file, line}` for every union of ≥2 string literals with no open `string` member. */
export function collectUnions(ts, sf, rel) {
  const unions = []
  const literalsOf = (typeNode) => {
    let t = typeNode
    while (t && ts.isParenthesizedTypeNode(t)) t = t.type
    if (!t || !ts.isUnionTypeNode(t)) return null
    const values = []
    for (const member of t.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) values.push(member.literal.text)
      else if (member.kind === ts.SyntaxKind.StringKeyword) return null // open union
    }
    return values.length >= 2 ? values : null
  }
  const add = (name, typeNode, node) => {
    const values = literalsOf(typeNode)
    if (!values) return
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    unions.push({ name, values, rel, line })
  }
  const visit = (node, owner) => {
    let next = owner
    if (ts.isTypeAliasDeclaration(node)) {
      add(node.name.text, node.type, node)
      next = node.name.text
    } else if (ts.isInterfaceDeclaration(node)) {
      next = node.name.text
    } else if (ts.isPropertySignature(node) && node.type && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      add(`${owner ?? '<anon>'}.${node.name.text}`, node.type, node)
    }
    ts.forEachChild(node, (child) => visit(child, next))
  }
  visit(sf, undefined)
  return unions
}

function calleeMethod(ts, call) {
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined
}

function isZodCall(ts, call) {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  const { expression, name } = call.expression
  return ts.isIdentifier(expression) && expression.text === 'z' && ['enum', 'literal'].includes(name.text)
}

/** `compare` | `key` | `decoder` | `produce` | `type` for one string literal (or identifier key). */
export function classifyLiteral(ts, node) {
  if (ts.isLiteralTypeNode(node.parent) || ts.isPartOfTypeNode(node)) return 'type'
  let e = node
  while (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isSatisfiesExpression(e.parent)) e = e.parent
  const p = e.parent
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === node) return 'key'
  if (ts.isElementAccessExpression(p) && p.argumentExpression === e) return 'key'
  if (ts.isBinaryExpression(p) && COMPARE_OPS.has(ts.SyntaxKind[p.operatorToken.kind])) return 'compare'
  if (ts.isCaseClause(p)) return 'compare'
  if (ts.isCallExpression(p) && p.arguments.includes(e)) {
    if (COMPARE_METHODS.has(calleeMethod(ts, p))) return 'compare'
    if (isZodCall(ts, p)) return 'decoder'
  }
  if (ts.isArrayLiteralExpression(p)) {
    let arr = p
    while (ts.isParenthesizedExpression(arr.parent) || ts.isAsExpression(arr.parent)) arr = arr.parent
    const ap = arr.parent
    if (ts.isPropertyAccessExpression(ap) && ap.expression === arr && COMPARE_METHODS.has(ap.name.text)) return 'compare'
    if (ts.isCallExpression(ap) && isZodCall(ts, ap)) return 'decoder'
  }
  return 'produce'
}

/** The string-literal values a contextual type admits, or null when it admits any string / none known. */
function literalSet(ts, checker, type) {
  if (!type) return null
  const out = new Set()
  for (const t of type.flags & ts.TypeFlags.Union ? type.types : [type]) {
    if (t.flags & ts.TypeFlags.StringLiteral) out.add(t.value)
    else if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TemplateLiteral)) return null
  }
  return out.size ? out : null
}

/** The key names of a mapped type (`Record<U, X>`, `Readonly<Record<U, X>>`), else undefined. */
function mappedKeys(ts, checker, type) {
  for (const t of type.flags & ts.TypeFlags.Union ? type.types : [type]) {
    if (t.flags & ts.TypeFlags.Object && t.objectFlags & ts.ObjectFlags.Mapped) {
      return new Set(checker.getPropertiesOfType(t).map((p) => p.name))
    }
  }
  return undefined
}

/** Per value: `[{kind, admits: Set|null}]` over the program's production files. */
export function collectSites(ts, checker, files) {
  const sites = new Map()
  sites.patterns = []
  const add = (value, site) => {
    if (!sites.has(value)) sites.set(value, [])
    sites.get(value).push(site)
  }
  for (const sf of files) {
    const visit = (node) => {
      if (ts.isTemplateExpression(node) && classifyLiteral(ts, node) === 'produce') {
        // `\`badge-${tone}\`` is not a Tone; `\`generate_${kind}\`` may be: a wildcard producer.
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]
        if (parts.join('').length >= 3) sites.patterns.push(wildcard(parts))
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const kind = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isExternalModuleReference(node.parent)
          ? 'type' : classifyLiteral(ts, node)
        if (kind !== 'type') {
          const admits = kind === 'produce' ? literalSet(ts, checker, checker.getContextualType(node)) : null
          add(node.text, { kind, admits })
        }
      } else if (ts.isIdentifier(node) && (ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent))
        && node.parent.name === node && ts.isObjectLiteralExpression(node.parent.parent)) {
        add(node.text, { kind: 'key', admits: null })
      } else if (ts.isPropertyAccessExpression(node) && !ts.isPartOfTypeNode(node)) {
        // `steps.remix` on a `Record<OverviewStep, …>`: reading the entry keyed by the member uses it.
        const keys = mappedKeys(ts, checker, checker.getTypeAtLocation(node.expression))
        if (keys?.has(node.name.text)) add(node.name.text, { kind: 'table-read', admits: keys })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return sites
}

/**
 * Every quoted string in the backend's non-test Python and JSON (the API produces wire unions), and
 * every f-string as a wildcard (`f'generate_{doc_type}'` produces `generate_prd`).
 */
export function backendStrings(root) {
  const out = new Set()
  out.patterns = []
  const dirs = ['voc-datalake/lambda', 'voc-datalake/plugins'].map((d) => join(root, d))
  const isTest = (full) => isTestPath(posixRel(root, full)) || full.includes('/lambda/stream/')
  for (const dir of dirs) {
    for (const file of walkFiles(dir, (name, full) => /\.(py|json)$/.test(name) && !isTest(full))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(\bf)?'([^'\\\n]{1,80})'|(\bf)?"([^"\\\n]{1,80})"/g)) {
        const isF = Boolean(m[1] ?? m[3])
        const body = m[2] ?? m[4]
        if (isF && /\{[^}]+\}/.test(body)) {
          const parts = body.split(/\{[^}]+\}/)
          if (parts.join('').length >= 3) out.patterns.push(wildcard(parts))
        } else out.add(body)
      }
    }
  }
  return out
}

/** `['generate_', '']` (the static parts around substitutions) → /^generate_.+$/. */
export function wildcard(parts) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${parts.map(esc).join('.+')}$`)
}

/** Findings for one program: members with no produce site for their union. */
export function unionFindings(unions, sites, backend, programName) {
  const findings = []
  for (const u of unions) {
    const members = new Set(u.values)
    for (const v of u.values) {
      const list = sites.get(v) ?? []
      const produced = backend.has(v) || [...backend.patterns ?? [], ...sites.patterns ?? []].some((re) => re.test(v))
        || list.some((s) => s.kind === 'produce'
        && (s.admits === null || [...members].every((m) => s.admits.has(m)) || [...s.admits].every((m) => members.has(m))))
      if (produced) continue
      const n = (k) => list.filter((s) => s.kind === k).length
      const counts = `compare ${n('compare')}, key ${n('key')}, table-read ${n('table-read')}, decoder ${n('decoder')}, other-union produce ${n('produce')}`
      findings.push({
        key: `${programName}:${u.rel}#${u.name}.'${v}'`,
        kind: list.length ? 'never-produced' : 'unused-member',
        detail: `${u.rel}:${u.line} (${counts})`,
      })
    }
  }
  return findings
}

export function analyzeUnions(def, root) {
  const ts = loadTypeScript()
  const { program, checker } = createService(ts, def)
  const files = ownSourceFiles(program, def).filter((sf) => !def.isTestFile(posixRel(def.base, resolve(sf.fileName))) && !sf.isDeclarationFile)
  const unions = files.flatMap((sf) => collectUnions(ts, sf, posixRel(def.base, resolve(sf.fileName))))
  const sites = collectSites(ts, checker, files)
  return { unions, findings: unionFindings(unions, sites, backendStrings(root), def.name) }
}

export const main = detectorMain(TOOL, {
  usage: 'String-literal union members nothing produces (never-produced, unused-member).',
  spec: { program: 'string', root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const { root, defs } = selectPrograms(args)
  const findings = []
  const notes = []
  for (const def of defs) {
    const { unions, findings: f } = analyzeUnions(def, root)
    if (unions.length < MIN_UNIONS[def.name]) throw new AuditError(`${def.name}: vacuous scan, saw ${unions.length} unions (expected at least ${MIN_UNIONS[def.name]})`)
    notes.push(`${def.name} ${unions.length} unions`)
    findings.push(...f)
  }
  return finishReport(TOOL, args, findings, { summary: notes.join('; '), reportStale: !args.program && !args.root })
})

runIfMain(import.meta.url, main)
