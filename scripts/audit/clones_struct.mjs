#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
// Structural near-duplicates in the TypeScript / JavaScript source: the renamed clones jscpd cannot see.
//
// PATTERN. Code with the same shape — the same statements, expressions, JSX and types in the same order — but
// other identifiers, property names and literal values: the copy-to-clipboard handlers, local date formatters
// and repeated stat chips the 5.28 audit found by hand.
//
// HOW. Each file is parsed with the repo's own `typescript` (voc-datalake/node_modules). A fragment is a
// function-like body (parameters included) or a window of `--window` consecutive statements. Its token stream
// is the SyntaxKind of every node, identifiers renamed consistently per fragment (i0, i1…; property names
// a0, a1…), literals reduced to their kind. Equal streams = an exact clone. Functions whose BLINDED streams (every
// renamed name replaced by `_`) share >= `--similarity` of their 4-grams (Jaccard, sizes within 30 %) are near
// clones, clustered. Fragments below `--min-nodes` nodes are ignored, adjacent matching windows merge, a group
// inside a bigger group is dropped, and only groups spanning two files are reported (`--same-file` adds more).
//
// WHY THE REFERENCE TOOLS MISS IT. jscpd matches token TEXT, so one renamed identifier breaks a match; knip and
// tsc do not look for duplication. The same algorithm for Python is scripts/audit/clones_struct.py.
//
// KNOWN FALSE POSITIVES. (1) The SPA ↔ stream Lambda mirrors pinned by *.lockstep.test.ts (separate packages,
// must not import each other). (2) CDK builders that repeat a construct shape per Lambda on purpose (the 20 KB
// IAM split). (3) Small React components equal by shape but unrelated in meaning. Raise --min-nodes to coarsen.
//
// SILENCING. scripts/audit/allowlists/clones_struct_ts.json: {"entries": [{"files": [globs], "reason": "..."}]};
// a group is silenced when EVERY copy's file matches one of the entry's globs (optional "name": one copy must be
// a function of that name). Every entry needs a reason.
//
// Exit 0 = none, 1 = clone groups (or stale allowlist entries) reported, 2 = error (incl. a vacuous scan below
// --min-files on the default scope). --json prints the JSON report instead of the text one, --json PATH also
// writes it there.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AuditError, REPO_ROOT, detectorMain, listFiles, loadTypeScript, matchesAny, printReport, readAllowlist, runIfMain,
  splitAllowlisted,
} from './audit_common.mjs'

const TOOL = 'clones_struct.mjs'
const ts = loadTypeScript()

export const DEFAULTS = Object.freeze({
  paths: ['voc-datalake/frontend/src', 'voc-datalake/lambda/stream/src', 'voc-datalake/lib', 'voc-datalake/bin',
    'voc-datalake/scripts', 'voc-datalake/frontend/scripts', 'scripts', 'eslint-rules'],
  minNodes: 60, window: 3, similarity: 0.8, minFiles: 800,
  allowlist: join(REPO_ROOT, 'scripts', 'audit', 'allowlists', 'clones_struct_ts.json'),
})
const SUFFIXES = ['.ts', '.tsx', '.mts', '.mjs', '.js']
const SHINGLE = 4
const MAX_SIZE_RATIO = 1.3
const K = ts.SyntaxKind
const LITERALS = new Set([K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.NoSubstitutionTemplateLiteral,
  K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.RegularExpressionLiteral, K.JsxText])
/** Parents whose `name` child is a property / member name, not a variable. */
const MEMBER_NAME_PARENTS = new Set([K.PropertyAccessExpression, K.PropertyAssignment, K.PropertySignature,
  K.PropertyDeclaration, K.MethodDeclaration, K.MethodSignature, K.JsxAttribute, K.GetAccessor, K.SetAccessor,
  K.EnumMember, K.PropertyAccessChain])
const WINDOW_BREAKERS = new Set([K.ImportDeclaration, K.ExportDeclaration, K.FunctionDeclaration,
  K.ClassDeclaration, K.InterfaceDeclaration, K.TypeAliasDeclaration, K.ModuleDeclaration])
const RENAMED = /^[ia]\d+$/
/** JSX attribute names and intrinsic tags (`div`, `onClick`) are vocabulary, not names a copy would rename. */
const KEEP_VERBATIM = (node) => node.kind === K.Identifier && node.parent
  && ((node.parent.kind === K.JsxAttribute && node.parent.name === node)
    || ((node.parent.kind === K.JsxOpeningElement || node.parent.kind === K.JsxSelfClosingElement
      || node.parent.kind === K.JsxClosingElement) && node.parent.tagName === node && /^[a-z]/.test(node.text)))

class Shape {
  constructor() { this.tokens = []; this.nodes = 0; this.names = new Map(); this.counts = { i: 0, a: 0 } }

  rename(space, text) {
    const key = `${space}:${text}`
    if (!this.names.has(key)) this.names.set(key, `${space}${this.counts[space]++}`)
    return this.names.get(key)
  }

  visit(node) {
    if (node.kind === K.JsxText && node.containsOnlyTriviaWhiteSpaces) return
    this.nodes += 1
    this.tokens.push(K[node.kind])
    if (KEEP_VERBATIM(node)) {
      this.tokens.push(`=${node.text}`)
    } else if (node.kind === K.Identifier || node.kind === K.PrivateIdentifier) {
      const member = node.parent && MEMBER_NAME_PARENTS.has(node.parent.kind) && node.parent.name === node
      this.tokens.push(this.rename(member ? 'a' : 'i', node.text))
    } else if (!LITERALS.has(node.kind)) {
      ts.forEachChild(node, (child) => this.visit(child))
    }
    this.tokens.push(')')
  }

  digest() { return createHash('sha1').update(this.tokens.join('\u001f')).digest('hex') }

  shingles() {
    const blind = this.tokens.map((t) => (RENAMED.test(t) ? '_' : t))
    const out = new Set()
    for (let i = 0; i + SHINGLE <= blind.length; i += 1) out.add(blind.slice(i, i + SHINGLE).join(' '))
    return out
  }
}

const shapeOf = (nodes) => { const s = new Shape(); for (const n of nodes) s.visit(n); return s }
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
const copyOf = (sf, rel, first, last, name = '') => ({ path: rel, start: lineOf(sf, first.getStart(sf)), end: lineOf(sf, last.end), name })

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text
  return ''
}

/** Index every fragment of one source file into `index` ({functions, windows, listIds}). */
export function indexSource(index, rel, text, { minNodes, window }) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : undefined)
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const shape = shapeOf([...node.parameters, node.body])
      if (shape.nodes >= minNodes) {
        const copy = copyOf(sf, rel, node, node, functionName(node))
        index.functions.push({ copy, nodes: shape.nodes, digest: shape.digest(), shingles: shape.shingles() })
      }
    }
    if (node.statements && Array.isArray(node.statements)) indexWindows(index, sf, rel, [...node.statements], { minNodes, window })
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

function indexWindows(index, sf, rel, stmts, { minNodes, window }) {
  index.listIds += 1
  for (let i = 0; i + window <= stmts.length; i += 1) {
    const chunk = stmts.slice(i, i + window)
    if (chunk.some((s) => WINDOW_BREAKERS.has(s.kind))) continue
    const shape = shapeOf(chunk)
    if (shape.nodes < minNodes) continue
    index.windows.set(`${rel}\u0000${index.listIds}\u0000${i}`, {
      digest: shape.digest(), copy: copyOf(sf, rel, chunk[0], chunk.at(-1)), nodes: shape.nodes,
      lastNodes: shapeOf([chunk.at(-1)]).nodes,
    })
  }
}

const spansFiles = (copies, sameFile) => copies.length > 1 && (sameFile || new Set(copies.map((c) => c.path)).size > 1)

const shiftKey = (key, by) => { const [p, l, i] = key.split('\u0000'); return `${p}\u0000${l}\u0000${Number(i) + by}` }

function windowGroups(index, sameFile) {
  const byHash = new Map()
  for (const key of [...index.windows.keys()].sort()) {
    const { digest } = index.windows.get(key)
    if (!byHash.has(digest)) byHash.set(digest, [])
    byHash.get(digest).push(key)
  }
  const isGroup = (keys) => keys.every((k) => index.windows.has(k))
    && JSON.stringify(byHash.get(index.windows.get(keys[0]).digest)) === JSON.stringify(keys)
  const groups = []
  for (const keys of byHash.values()) {
    if (!spansFiles(keys.map((k) => index.windows.get(k).copy), sameFile)) continue
    if (isGroup(keys.map((k) => shiftKey(k, -1)))) continue // continuation of an earlier run
    let ends = keys.map((k) => index.windows.get(k).copy.end)
    let nodes = index.windows.get(keys[0]).nodes
    for (let run = keys.map((k) => shiftKey(k, 1)); isGroup(run); run = run.map((k) => shiftKey(k, 1))) {
      ends = run.map((k) => index.windows.get(k).copy.end)
      nodes += index.windows.get(run[0]).lastNodes
    }
    const copies = keys.map((k, i) => ({ ...index.windows.get(k).copy, end: ends[i] }))
    groups.push({ kind: 'statements', nodes, similarity: 1, copies })
  }
  return groups
}

function jaccard(a, b) {
  let shared = 0
  for (const x of a) if (b.has(x)) shared += 1
  return shared / (a.size + b.size - shared || 1)
}

/** Functions clustered by similarity; a cluster of identical shapes is an exact `function` group. */
function functionGroups(index, similarity, sameFile) {
  const fns = [...index.functions].sort((a, b) => a.nodes - b.nodes)
  const parent = fns.map((_, i) => i)
  const weakest = new Map()
  const root = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let i = 0; i < fns.length; i += 1) {
    for (let j = i + 1; j < fns.length && fns[j].nodes <= fns[i].nodes * MAX_SIZE_RATIO; j += 1) {
      const [a, b] = [fns[i], fns[j]]
      if (!sameFile && a.copy.path === b.copy.path) continue
      const score = a.digest === b.digest ? 1 : jaccard(a.shingles, b.shingles)
      if (score < similarity && a.digest !== b.digest) continue
      const [ra, rb] = [root(i), root(j)]
      weakest.set(ra, Math.min(score, weakest.get(ra) ?? 1, weakest.get(rb) ?? 1))
      parent[rb] = ra
    }
  }
  const clusters = new Map()
  fns.forEach((fn, i) => { const r = root(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(fn) })
  const groups = []
  for (const [key, members] of clusters) {
    const copies = members.map((m) => m.copy).sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
    if (spansFiles(copies, sameFile)) {
      const kind = new Set(members.map((m) => m.digest)).size === 1 ? 'function' : 'near-function'
      groups.push({ kind, nodes: Math.max(...members.map((m) => m.nodes)), similarity: Math.round((weakest.get(key) ?? 1) * 100) / 100, copies })
    }
  }
  return groups
}

const contains = (outer, inner) => outer.path === inner.path && outer.start <= inner.start && inner.end <= outer.end

function dropNested(groups) {
  const kept = []
  const ordered = [...groups].sort((a, b) => b.nodes - a.nodes || a.copies[0].path.localeCompare(b.copies[0].path))
  for (const group of ordered) {
    if (!group.copies.every((c) => kept.some((k) => k.copies.some((o) => contains(o, c))))) kept.push(group)
  }
  return kept
}

/** {groups, files} for `paths` under `root`. */
export function scan(root, paths, opts) {
  const index = { functions: [], windows: new Map(), listIds: 0 }
  const files = listFiles(root, paths, { suffixes: SUFFIXES, includeTests: opts.includeTests, exclude: opts.exclude ?? [] })
  for (const { rel, file } of files) indexSource(index, rel, readFileSync(file, 'utf8'), opts)
  const found = [...functionGroups(index, opts.similarity, opts.sameFile), ...windowGroups(index, opts.sameFile)]
  return { groups: dropNested(found), files: files.length }
}

const allows = (entry, group) => (!entry.name || group.copies.some((c) => c.name === entry.name))
  && group.copies.every((c) => matchesAny(c.path, entry.files))

function reportLines(groups) {
  return groups.flatMap((g, n) => [
    `[${n + 1}] ${g.kind}, ~${g.nodes} nodes, ${g.copies.length} copies${g.kind === 'near-function' ? `, similarity >= ${g.similarity}` : ''}`,
    ...g.copies.map((c) => `    ${c.path}:${c.start}-${c.end}${c.name ? `  ${c.name}` : ''}`),
  ])
}

export const main = detectorMain(TOOL, {
  usage: '[paths…]  structural (renamed) clones in TS/JS; paths default to the whole source tree.',
  spec: { root: 'string', 'include-tests': 'boolean', 'min-nodes': 'number', window: 'number', similarity: 'number',
    'same-file': 'boolean', allowlist: 'string', 'min-files': 'number' },
}, (opts) => {
  const partial = opts._.length > 0
  const minFiles = opts['min-files'] ?? (partial ? 1 : DEFAULTS.minFiles)
  const scanOpts = { includeTests: Boolean(opts['include-tests']), minNodes: opts['min-nodes'] ?? DEFAULTS.minNodes,
    window: opts.window ?? DEFAULTS.window, similarity: opts.similarity ?? DEFAULTS.similarity, sameFile: Boolean(opts['same-file']) }
  const entries = readAllowlist(opts.allowlist ?? DEFAULTS.allowlist, ['files'])
  const result = scan(opts.root ?? REPO_ROOT, partial ? opts._ : DEFAULTS.paths, scanOpts)
  if (result.files < minFiles) throw new AuditError(`only ${result.files} TS/JS file(s) parsed (expected >= ${minFiles}); wrong scope?`)
  const { kept, excused, stale: unused } = splitAllowlisted(result.groups, entries, allows)
  const stale = partial ? [] : unused // a partial scan cannot judge the allowlist
  const findings = [...kept, ...stale.map((entry) => ({ kind: 'stale-allowlist', entry }))]
  const lines = [...reportLines(kept), ...stale.map((e) => `stale-allowlist  ${e.reason.slice(0, 80)}`)]
  const summary = `clone groups in ${result.files} TS/JS files (>= ${scanOpts.minNodes} nodes, window ${scanOpts.window}, `
    + `${excused.length} allowlisted${scanOpts.includeTests ? ', tests included' : ''})`
  return printReport(TOOL, findings, { json: opts.json, summary, lines, extra: { files: result.files, allowlisted: excused.length } })
})

runIfMain(import.meta.url, main)
