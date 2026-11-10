#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_stale_refs — comments in the SPA, the stream Lambda and the dev mocks that name a file, a test or an
 * identifier that no longer exists.
 *
 * Pattern (hunt-typescript.md A + B, 5.34): `API_AGENT_LIMITS` was "pinned by agentsApi.lockstep.test.ts", a test
 * that never existed, so 17 numbers drifted unguarded; `runtime/input.ts` still pointed at a removed `convert.ts`;
 * comments sent readers to `sortPRFAQs` and `_walk_dates` long after both were renamed. A comment is the one place
 * no compiler checks, and a false "pinned by" claim is worse than none.
 *
 * How: every comment range (`getLeadingCommentRanges` / `getTrailingCommentRanges` over every node and token of
 * the repo's own `typescript` AST) is read sentence by sentence:
 *   - `missing-file`: a path-shaped token (`x/y.ts`, `handler.py`, `deploy.md`, …) that resolves neither from the
 *     file's directory, from the repo root or a package root, nor as a suffix of a repo file (`git ls-files`);
 *     a `.js` ESM specifier resolves to its `.ts` / `.tsx`;
 *   - `missing-test`: the same, when the token is a test (`*.test.ts`, `test_*.py`) or the sentence claims a pin
 *     (`pinned by`, `lockstep`, `fails when`, `reads … test`) — a guard someone believes in that does not exist;
 *   - `missing-identifier` (production files only): a backticked camelCase / PascalCase-with-a-hump / snake_case
 *     identifier of 5+ characters that appears in no code of the repo (identifiers and string literals of
 *     comment-free TS/JS, Python without its comments, JSON, shell, YAML — locale catalogues included, so a key
 *     leaf counts as present).
 * Skipped: URLs, globs and templates, runtime artefacts (`config.json`, `mcp.json`), and history sentences
 * (`was`, `old`, `once`, `formerly`, `removed`, `deleted`, `ported from`, `renamed`, `retired`, `previously`,
 * `no longer`) — a comment may say what used to be.
 *
 * Why the reference tools miss it: tsc, eslint and knip never read comment text; jscpd sees only duplication.
 *
 * Known false-positive classes (allowlist `scripts/audit/allowlists/ts_stale_refs.json`, key `<path>::<token>`,
 * `*` allowed): a file of another repository or a generated artefact named in prose; sample data in a comment.
 *
 * Usage: node scripts/audit/ts_stale_refs.mjs [--root <repo>] [--no-allowlist] [--min-paths N] [--min-idents N]
 *        [--json [PATH]] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import {
  AuditError, REPO_ROOT, detectorMain, finishReport, isTestPath, listFiles, loadTypeScript, posixRel, runIfMain, walkFiles,
} from './audit_common.mjs'

const TOOL = 'ts_stale_refs'
export const SCAN = ['voc-datalake/frontend/src', 'voc-datalake/lambda/stream/src']
const MOCK_DIR = 'voc-datalake/frontend'
const MOCK_FILE = /^mock-[^/]*\.js$/
/** Directories a bare or rooted path in a comment is read from (besides the file's own directory). */
const ROOTS = ['', 'voc-datalake', 'voc-datalake/frontend', 'voc-datalake/frontend/src', 'voc-datalake/lambda',
  'voc-datalake/lambda/stream', 'voc-datalake/lambda/stream/src']
/** Files that exist only at run time or in a deployment, never in the repo. */
const RUNTIME_ARTEFACTS = new Set(['config.json', 'mcp.json'])
const EXT = 'tsx?|py|mjs|cjs|jsx?|json|md|sh|css|ya?ml|toml|html'
const PATH_TOKEN = new RegExp(`(?<![\\w/.@*{}$<>\\\\-])((?:\\.{1,2}/|[\\w@-][\\w@.-]*/)*[\\w-][\\w.-]*\\.(?:${EXT}))(?![\\w/*{-])`, 'g')
const TEST_TOKEN = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$/
const PIN_CLAIM = /\bpinned by\b|\blockstep\b|\bfails when\b|\breads\b.*\btest\b/i
const HISTORY = /\b(was|were|old|once|formerly|removed|deleted|ported from|extracted from|renamed|retired|previously|no longer|used to|before this)\b/i
const HISTORY_BEFORE = 60
const HISTORY_AFTER = 40
/** A product name, not a file (`Node.js`). */
const PRODUCT = /^[A-Z][a-z]+\.js$/
/** `no \`X\``, `without \`X\``: a comment saying a name deliberately does not exist. */
const ABSENCE = /\b(no|not|without|never|rather than|instead of)\s+(an?\s+)?$/i
/** i18next plural forms (`rowCount_zero`): judged by their base. */
const PLURAL_FORM = /_(zero|one|two|few|many|other)$/
const BACKTICK = /`([A-Za-z_$][\w$]*)(?:\(\))?`/g
const IDENT_SHAPE = /[a-z0-9][A-Z]|_/
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const INDEX_SUFFIX = /\.(?:[cm]?[jt]sx?|py|json|sh|ya?ml|toml)$/
const INDEX_DIRS = ['voc-datalake/', 'scripts/', 'eslint-rules/', 'tools/', '.github/']
/** The audit's own files name findings (allowlists, planted test cases): never evidence that a name exists. */
const NOT_INDEXED = 'scripts/audit/'

/** Every repo file (repo-relative POSIX): `git ls-files`, else a walk (a temp fixture has no git). */
export function repoFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const files = out.split('\0').filter(Boolean)
    if (files.length) return files.filter((rel) => existsSync(join(root, rel)))
  } catch {
    // not a git checkout: walk it
  }
  return walkFiles(root).map((file) => posixRel(root, file))
}

/** `exists(token, fromDir)`: does a path token of a comment resolve to a repo file? */
export function pathResolver(files) {
  const all = new Set(files)
  const names = new Set()
  for (const rel of files) {
    const parts = rel.split('/')
    for (let i = 0; i < parts.length; i += 1) names.add(parts.slice(i).join('/'))
  }
  const candidates = (token) => {
    const out = [token]
    const js = /\.(m|c)?jsx?$/.exec(token)
    if (js) out.push(token.replace(/\.[cm]?jsx?$/, '.ts'), token.replace(/\.[cm]?jsx?$/, '.tsx'))
    return out
  }
  return (token, fromDir) => candidates(token).some((cand) => {
    for (const base of [fromDir, ...ROOTS]) {
      const joined = normalize(join(base, cand)).split('\\').join('/')
      if (!joined.startsWith('..') && all.has(joined)) return true
    }
    const stripped = cand.replace(/^(\.{1,2}\/)+/, '')
    return names.has(stripped)
  })
}

const kindOf = (ts, rel) => (rel.endsWith('x') ? ts.ScriptKind.TSX : (/\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS))
const parse = (ts, rel, text) => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kindOf(ts, rel))

/** Identifiers and string-literal words of one TS/JS file (its AST: comments and JSX prose never count). */
function astWords(ts, rel, text, words) {
  const add = (s) => { for (const w of s.match(/[A-Za-z_$][\w$]*/g) ?? []) words.add(w) }
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) words.add(node.text)
    else if (ts.isStringLiteralLike(node)) add(node.text)
    // Template heads/middles/tails are not forEachChild children: read them off the expression.
    else if (ts.isTemplateExpression(node)) for (const part of [node.head, ...node.templateSpans.map((s) => s.literal)]) add(part.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(ts, rel, text))
}

/** Words of code: identifiers and string-literal words of comment-free source (no comments, no prose). */
export function codeWords(ts, root, files) {
  const words = new Set()
  const add = (text) => { for (const w of text.match(/[A-Za-z_$][\w$]*/g) ?? []) words.add(w) }
  for (const rel of files) {
    if (!INDEX_SUFFIX.test(rel) || !INDEX_DIRS.some((d) => rel.startsWith(d)) || rel.startsWith(NOT_INDEXED) || rel.endsWith('.d.ts')) continue
    let text
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    if (/\.[cm]?[jt]sx?$/.test(rel)) {
      astWords(ts, rel, text, words)
    } else if (rel.endsWith('.py') || rel.endsWith('.sh') || /\.ya?ml$|\.toml$/.test(rel)) {
      add(text.replace(/(^|\s)#.*$/gm, '$1'))
    } else {
      add(text)
    }
  }
  return words
}

/** Comment ranges of one source file: `[{text, line}]`, each comment once. */
export function commentsOf(ts, rel, text) {
  const sf = parse(ts, rel, text)
  const seen = new Map()
  const take = (ranges) => {
    for (const r of ranges ?? []) {
      if (!seen.has(r.pos)) seen.set(r.pos, { text: text.slice(r.pos, r.end), line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 })
    }
  }
  const visit = (node) => {
    take(ts.getLeadingCommentRanges(text, node.pos))
    take(ts.getTrailingCommentRanges(text, node.end))
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return [...seen.values()].sort((a, b) => a.line - b.line)
}

/** A comment's sentences, comment markers stripped, URLs blanked; each with its first line. */
export function sentences(comment) {
  const lines = comment.text.split('\n').map((l) => l.replace(/^\s*(\/\/+|\/\*+|\*+(?!\/))?/, '').replace(/\*+\/\s*$/, ''))
  let joined = ''
  const starts = []
  for (const text of lines) {
    starts.push(joined.length)
    joined += text.trim() ? `${text.replace(URL, ' ')} ` : '\n'
  }
  const lineAt = (offset) => comment.line + starts.findLastIndex((start) => start <= offset)
  const out = []
  const push = (from, to) => {
    const text = joined.slice(from, to).replace(/\s+/g, ' ').trim()
    if (text) out.push({ text, line: lineAt(from) })
  }
  let last = 0
  for (const m of joined.matchAll(/(?<=[.!?])\s+(?=[A-Z`(])|\n\s*/g)) {
    push(last, m.index)
    last = m.index + m[0].length
  }
  push(last, joined.length)
  return out
}

/** Findings of one file's comments. */
export function fileFindings(rel, comments, { exists, words, counts }) {
  const out = []
  const dir = dirname(rel)
  const prod = !isTestPath(rel)
  for (const comment of comments) {
    for (const s of sentences(comment)) {
      // History is judged near the token (the clause around it), not over a whole long sentence.
      const history = (at, length) => HISTORY.test(s.text.slice(Math.max(0, at - HISTORY_BEFORE), at + length + HISTORY_AFTER))
      for (const m of s.text.matchAll(PATH_TOKEN)) {
        const token = m[1]
        counts.paths += 1
        const name = token.split('/').at(-1)
        if (history(m.index, token.length) || RUNTIME_ARTEFACTS.has(name) || PRODUCT.test(token)) continue
        if (exists(token, dir)) continue
        const kind = TEST_TOKEN.test(token) || PIN_CLAIM.test(s.text) ? 'missing-test' : 'missing-file'
        out.push({ key: `${rel}::${token}`, kind, detail: `line ${s.line}: ${s.text.slice(0, 140)}` })
      }
      for (const m of s.text.matchAll(BACKTICK)) {
        const ident = m[1]
        if (ident.length < 5 || !IDENT_SHAPE.test(ident)) continue
        counts.idents += 1
        if (!prod || history(m.index, m[0].length) || words.has(ident) || words.has(ident.replace(PLURAL_FORM, ''))) continue
        if (ABSENCE.test(s.text.slice(0, m.index))) continue
        out.push({ key: `${rel}::${ident}`, kind: 'missing-identifier', detail: `line ${s.line}: ${s.text.slice(0, 140)}` })
      }
    }
  }
  // One finding per key (a comment repeating a stale name says it once).
  return [...new Map(out.map((f) => [f.key, f])).values()]
}

/** `{findings, counts}` over the scanned packages of `root`. */
export function scanStaleRefs(root) {
  const ts = loadTypeScript(root)
  const files = repoFiles(root)
  const exists = pathResolver(files)
  const words = codeWords(ts, root, files)
  const counts = { files: 0, paths: 0, idents: 0 }
  const sources = [
    ...listFiles(root, SCAN, { suffixes: ['.ts', '.tsx'], includeTests: true }),
    ...walkFiles(join(root, MOCK_DIR), (name) => MOCK_FILE.test(name)).filter((f) => dirname(f) === join(root, MOCK_DIR))
      .map((file) => ({ rel: posixRel(root, file), file })),
  ]
  const findings = []
  for (const { rel, file } of sources) {
    counts.files += 1
    findings.push(...fileFindings(rel, commentsOf(ts, rel, readFileSync(file, 'utf8')), { exists, words, counts }))
  }
  return { findings, counts }
}

export const main = detectorMain(TOOL, {
  usage: 'Comments naming a file, a test (a claimed pin) or a backticked identifier that does not exist.',
  spec: { root: 'string', 'no-allowlist': 'boolean', 'min-paths': 'number', 'min-idents': 'number' },
}, (args) => {
  const root = args.root ? resolve(args.root) : REPO_ROOT
  const { findings, counts } = scanStaleRefs(root)
  const minPaths = args['min-paths'] ?? 1000
  const minIdents = args['min-idents'] ?? 2500
  if (counts.paths < minPaths || counts.idents < minIdents) {
    throw new AuditError(`vacuous scan: ${counts.paths} path tokens, ${counts.idents} identifiers in ${counts.files} files (expected at least ${minPaths} / ${minIdents})`)
  }
  return finishReport(TOOL, args, findings, {
    summary: `${counts.files} files, ${counts.paths} path tokens, ${counts.idents} identifiers`, reportStale: !args.root,
  })
})

runIfMain(import.meta.url, main)
