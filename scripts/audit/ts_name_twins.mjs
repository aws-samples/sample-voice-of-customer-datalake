#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_name_twins — one small helper declared under the same name in two or more production modules of a package.
 *
 * Pattern (hunt-typescript.md C, 5.34): six SPA copies of the one-line `isRecord` guard (one of them exported
 * from an approval-preview module with five importers), four in the stream Lambda, two `useDebouncedValue` hooks
 * (the DataExplorer page reached into another component's folder for one), `languageName`, `stripTrailingSlashes`,
 * `sameValue`, `optionalText`, `answerText`. Each copy sits under the clone detector's 60-node floor, so nothing
 * reported them; the shared NAME is the signal.
 *
 * How: per package (SPA `frontend/src`, stream `lambda/stream/src`) every top-level function declaration and
 * `const x = (…) => …` / `function` expression with a lowercase or `use*` name is collected (PascalCase components
 * collide by design and are skipped, as are `normalize*` boundary seams). A name declared in 2+ modules is
 *   - `identical`: every copy has the same renamed-token shape (clones_struct.mjs's normaliser);
 *   - `near`: some pair of copies shares >= 0.7 of its shape 4-grams (bodies of at least 8 nodes);
 *   - `same-name`: the bodies differ, but one copy is exported — two exported meanings of one name in one
 *     package invite the wrong import.
 *
 * Why the reference tools miss it: jscpd and clones_struct.mjs have size floors (a one-line guard is never a
 * clone), knip sees every copy used, tsc is happy with module-scoped names.
 *
 * Known false-positive classes (allowlist `scripts/audit/allowlists/ts_name_twins.json`, key `<pkg>:<name>`):
 * a module-private helper that happens to share a common verb with an unrelated exported one (`clip` of text vs
 * of a number) — say why they differ.
 *
 * Usage: node scripts/audit/ts_name_twins.mjs [--root <repo>] [--no-allowlist] [--min-functions N] [--json [PATH]] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync } from 'node:fs'
import {
  listFiles, loadTypeScript, runIfMain, scanDetectorMain, unwrapExpression,
} from './audit_common.mjs'
import { jaccard, shapeOf } from './clones_struct.mjs'

const TOOL = 'ts_name_twins'
export const PACKAGES = [
  { name: 'frontend', path: 'voc-datalake/frontend/src' },
  { name: 'stream', path: 'voc-datalake/lambda/stream/src' },
]
const NEAR = 0.7
const MIN_NODES = 8
const NAME = /^(?:[a-z_$]|use[A-Z])/
const SEAM = /^normalize/

const isExported = (ts, node) => Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export)

/** `[{name, exported, fn}]`: top-level helpers of one module. */
export function topLevelHelpers(ts, rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const exportedNames = new Set()
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text)
    }
  }
  const out = []
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.push({ name: stmt.name.text, exported: isExported(ts, stmt), fn: stmt })
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = unwrapExpression(ts, decl.initializer)
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name: decl.name.text, exported: isExported(ts, decl), fn: init })
        }
      }
    }
  }
  return out
    .filter((h) => NAME.test(h.name) && !SEAM.test(h.name))
    .map((h) => ({ ...h, exported: h.exported || exportedNames.has(h.name), line: sf.getLineAndCharacterOfPosition(h.fn.getStart(sf)).line + 1 }))
}

/** The strongest pairwise similarity of a name's copies (1 = identical shapes). */
function similarity(copies) {
  let best = 0
  for (let i = 0; i < copies.length; i += 1) {
    for (let j = i + 1; j < copies.length; j += 1) {
      const [a, b] = [copies[i].shape, copies[j].shape]
      if (a.nodes < MIN_NODES || b.nodes < MIN_NODES || a.path === b.path) continue
      best = Math.max(best, a.digest === b.digest ? 1 : jaccard(a.shingles, b.shingles))
    }
  }
  return best
}

/** `{findings, functions}` over the packages of `root`. */
export function scanNameTwins(root) {
  const ts = loadTypeScript(root)
  const findings = []
  let functions = 0
  for (const pkg of PACKAGES) {
    const byName = new Map()
    for (const { rel, file } of listFiles(root, [pkg.path], { suffixes: ['.ts', '.tsx'] })) {
      for (const h of topLevelHelpers(ts, rel, readFileSync(file, 'utf8'))) {
        functions += 1
        const s = shapeOf([...h.fn.parameters, h.fn.body])
        const shape = { nodes: s.nodes, digest: s.digest(), shingles: s.shingles(), path: rel }
        byName.set(h.name, [...(byName.get(h.name) ?? []), { rel, line: h.line, exported: h.exported, shape }])
      }
    }
    for (const [name, copies] of byName) {
      if (new Set(copies.map((c) => c.rel)).size < 2) continue
      const digests = new Set(copies.map((c) => c.shape.digest))
      const score = similarity(copies)
      const kind = digests.size === 1 ? 'identical' : (score >= NEAR ? 'near' : (copies.some((c) => c.exported) ? 'same-name' : ''))
      if (!kind) continue
      const where = copies.map((c) => `${c.rel}:${c.line}${c.exported ? ' (exported)' : ''}`).join(', ')
      findings.push({ key: `${pkg.name}:${name}`, kind, detail: `${copies.length} copies${kind === 'near' ? ` (similarity ${score.toFixed(2)})` : ''}: ${where}` })
    }
  }
  return { findings, functions }
}

export const main = scanDetectorMain(TOOL, {
  usage: 'Same-named small helpers declared in 2+ production modules of one package (identical, near, or exported twins).',
  minFlag: 'min-functions', min: 2000, what: 'top-level helpers',
}, (root) => {
  const { findings, functions } = scanNameTwins(root)
  return { findings, count: functions, summary: `${functions} top-level helpers in ${PACKAGES.length} packages` }
})

runIfMain(import.meta.url, main)
