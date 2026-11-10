#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_prop_usage — optional React component props no production call site passes.
 *
 * Pattern (hunt-typescript.md §G: `KiroGhost.title`, `ToneTile.size`, `AdminRoute.redirectTo`,
 * `FeedbackCard.showActions`): a prop added "for later", or whose last caller went away, keeps a dead
 * branch inside the component (`size === 'sm' ? … : …`, a `<title>` nobody sets) that every reader has
 * to understand and every test keeps alive.
 *
 * How: the SPA program (`tsconfig.test.json`) with its type checker. Components are the top-level
 * PascalCase functions of production `.tsx` files (a `function`, an arrow, or one wrapped in `memo` /
 * `forwardRef`) with a first parameter; their props are the properties of that parameter's type that are
 * declared in the repo (React's / a library's inherited attributes are not judged). Every JSX element of
 * the program whose tag resolves (through imports) to a component is a call site; its attributes and its
 * non-empty children (`children`) are what it passes. Kinds:
 *   - `never-passed`: an optional prop no call site, production or spec, passes;
 *   - `test-only-prop`: an optional prop only specs pass (its branch exists for the tests).
 * ADVISORY (printed and in the JSON `advisory`, never a finding, never fails the gate): `always-passed`,
 * an optional prop every one of at least 3 production call sites passes, so its fallback never runs. It is
 * a design hint, not dead code by itself: an optional prop with a sensible default is often right even
 * when today's callers all set it.
 *
 * Skipped (cannot be judged from call sites): a component with a `{...spread}` site; one used as a value
 * (`component={X}`, `createElement(X)`, an array of components), or whose element is handed to a library as
 * an attribute (`tick={<X />}`, which Recharts clones with injected props); a component whose module is
 * loaded with `import()` (React.lazy pages); a component no production site renders (ts_reachability's job).
 *
 * Why the reference tools miss it: tsc and eslint check that what is passed is allowed, never that what is
 * allowed is passed; knip and ts_reachability see the component used.
 *
 * Allowlist `scripts/audit/allowlists/ts_prop_usage.json`, key `<file>#<Component>.<prop>`
 * (`src/components/X/index.tsx#X.size`).
 *
 * Usage: node scripts/audit/ts_prop_usage.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { resolve } from 'node:path'
import {
  AuditError, applyAllowlist, createService, detectorMain, loadAllowlist, loadTypeScript, ownSourceFiles, posixRel,
  printReport, runIfMain, selectPrograms,
} from './audit_common.mjs'

const TOOL = 'ts_prop_usage'
const MIN = { components: 500, sites: 2000 }
const ALWAYS_MIN_SITES = 3
const WRAPPERS = new Set(['memo', 'forwardRef'])

/** The function node of a top-level component declaration (unwrapping memo / forwardRef), or undefined. */
function componentFunction(ts, init) {
  if (!init) return undefined
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
  if (ts.isCallExpression(init)) {
    const callee = init.expression
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
    if (WRAPPERS.has(name)) return componentFunction(ts, init.arguments[0])
  }
  return undefined
}

/** `[{name, decl, fn}]`: the top-level PascalCase function components of one file. */
export function componentsOf(ts, sf) {
  const out = []
  const add = (name, decl, fn) => { if (/^[A-Z]/.test(name) && fn?.parameters.length) out.push({ name, decl, fn }) }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) add(st.name.text, st, st)
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d, componentFunction(ts, d.initializer))
    }
  }
  return out
}

const isJsxTag = (ts, node) => {
  const p = node.parent
  return (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node
}
const inTypeOrModuleSyntax = (ts, node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeQueryNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n)) return true
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false
  }
  return false
}
const isExported = (ts, decl) => {
  const st = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl
  return Boolean(ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
}
/**
 * `<LibChart tick={<X />} />`: an element handed to a library attribute that clones it with injected props
 * (Recharts' `tick`, `content`, `shape`, `dot`, …). A repo component's attribute (`element={<X />}` on a
 * route wrapper, `icon={<X />}`) renders the element as written, so it stays a call site.
 */
const CLONING_ATTRS = new Set(['tick', 'content', 'shape', 'dot', 'activeDot', 'label', 'cursor', 'customized', 'labelLine'])
function clonedByLibrary(ts, el, compOf) {
  const holder = (ts.isJsxOpeningElement(el) ? el.parent : el).parent
  if (!ts.isJsxExpression(holder) || !ts.isJsxAttribute(holder.parent)) return false
  const attr = holder.parent
  const owner = attr.parent.parent
  return CLONING_ATTRS.has(attr.name.getText()) && !compOf(owner.tagName)
}
const hasChildren = (ts, el) => ts.isJsxOpeningElement(el)
  && el.parent.children.some((c) => !(ts.isJsxText(c) && !c.text.trim()))

/** The repo-declared props of a component: `[{name, optional}]`. */
function propsOf(ts, checker, comp, isRepoFile) {
  const param = comp.fn.parameters[0]
  const type = checker.getTypeAtLocation(param)
  return checker.getPropertiesOfType(type)
    .filter((p) => (p.declarations ?? []).some((d) => isRepoFile(d.getSourceFile().fileName)))
    .map((p) => ({ name: p.getName(), optional: Boolean(p.flags & ts.SymbolFlags.Optional) }))
}

/** Modules a dynamic `import('…')` loads, as resolved file names. */
function lazyModules(ts, checker, files) {
  const out = new Set()
  for (const sf of files) {
    const visit = (n) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0]) {
        const mod = checker.getSymbolAtLocation(n.arguments[0])
        for (const d of mod?.declarations ?? []) out.add(resolve(d.getSourceFile().fileName))
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

export function analyzePropUsage(def) {
  const ts = loadTypeScript()
  const { program, checker } = createService(ts, def)
  const rel = (f) => posixRel(def.base, resolve(f))
  const files = ownSourceFiles(program, def)
  const isRepoFile = (f) => !resolve(f).includes('/node_modules/') && !rel(f).startsWith('..')
  const comps = new Map() // declaration node -> component record
  for (const sf of files) {
    if (def.isTestFile(rel(sf.fileName)) || !sf.fileName.endsWith('.tsx')) continue
    for (const c of componentsOf(ts, sf)) {
      comps.set(c.decl, { ...c, rel: rel(sf.fileName), prod: [], test: [], skip: '' })
    }
  }
  const compOf = (node) => {
    let sym = checker.getSymbolAtLocation(node)
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    return (sym?.declarations ?? []).map((d) => comps.get(d)).find(Boolean)
  }
  const lazy = lazyModules(ts, checker, files)
  for (const c of comps.values()) {
    if (lazy.has(resolve(c.decl.getSourceFile().fileName)) && isExported(ts, c.decl)) c.skip = 'exported by a module loaded with import()'
  }
  let sites = 0
  for (const sf of files) {
    const test = def.isTestFile(rel(sf.fileName))
    const visit = (n) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const c = compOf(n.tagName)
        if (c) {
          sites += 1
          const attrs = new Set(n.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf)))
          if (hasChildren(ts, n)) attrs.add('children')
          if (!test && n.attributes.properties.some(ts.isJsxSpreadAttribute)) c.skip ||= 'spread call site'
          if (!test && clonedByLibrary(ts, n, compOf)) c.skip ||= 'element handed to a library that clones it'
          ;(test ? c.test : c.prod).push(attrs)
        }
      } else if (!test && ts.isIdentifier(n) && !isJsxTag(ts, n) && !inTypeOrModuleSyntax(ts, n)) {
        const c = compOf(n)
        if (c && n !== c.decl.name) c.skip ||= 'used as a value'
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  const findings = []
  const advisory = []
  let judged = 0
  for (const c of comps.values()) {
    if (c.skip || !c.prod.length) continue
    judged += 1
    for (const p of propsOf(ts, checker, c, isRepoFile)) {
      if (!p.optional) continue
      const key = `${c.rel}#${c.name}.${p.name}`
      const prodHits = c.prod.filter((a) => a.has(p.name)).length
      const testHits = c.test.filter((a) => a.has(p.name)).length
      const where = `${c.prod.length} production site(s), ${c.test.length} spec site(s)`
      if (!prodHits && !testHits) findings.push({ key, kind: 'never-passed', detail: `no call site passes it; ${where}` })
      else if (!prodHits) findings.push({ key, kind: 'test-only-prop', detail: `only specs pass it (${testHits}); ${where}` })
      else if (prodHits === c.prod.length && c.prod.length >= ALWAYS_MIN_SITES) {
        advisory.push({ key, kind: 'always-passed', detail: `every production site passes it (${prodHits}/${c.prod.length}): the fallback never runs` })
      }
    }
  }
  return { findings, advisory, components: comps.size, judged, sites }
}

export const main = detectorMain(TOOL, {
  usage: 'Optional React component props no production call site passes (never-passed, test-only-prop); always-passed is advisory.',
  spec: { root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const { defs: [def] } = selectPrograms({ root: args.root, program: 'frontend' })
  const { findings, advisory, components, judged, sites } = analyzePropUsage(def)
  if (components < MIN.components || sites < MIN.sites) {
    throw new AuditError(`vacuous scan: ${components} components, ${sites} JSX sites (expected at least ${MIN.components} / ${MIN.sites})`)
  }
  const entries = args['no-allowlist'] ? [] : loadAllowlist(TOOL)
  const { left, excused } = applyAllowlist(findings, entries, { reportStale: !args.root })
  const lines = [...left].sort((a, b) => a.key.localeCompare(b.key)).map((f) => `  ${f.kind}  ${f.key}  — ${f.detail}`)
  lines.push(`${TOOL}: advisory always-passed (${advisory.length}; not findings)`, ...advisory.map((f) => `  ${f.key}  — ${f.detail}`))
  return printReport(TOOL, left, {
    json: args.json, lines, extra: { advisory },
    summary: `${components} components (${judged} judged), ${sites} JSX sites; ${excused} allowlisted`,
  })
})

runIfMain(import.meta.url, main)
