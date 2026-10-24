#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_reachability — TypeScript declarations and members nothing in production reads.
 *
 * Pattern (the 5.28 dead-TS audit, deadts.md "Method", made repeatable):
 *   - `dead`: a runtime declaration (function, var, class, enum, class member, object-table member such
 *     as `api.getPersonas`) or a type (interface, type alias) no live code references;
 *   - `test-only`: the same, but specs reference it (a seam only tests keep alive);
 *   - `write-only`: a member that live production code writes (object-literal key, JSX attribute,
 *     `x.p = …`, a returned field) but nothing ever reads (`BriefResult.isLoading`, an unused prop);
 *   - `unread-type-member` (only with `--all-members`): a type member neither read nor written in
 *     production (wire envelopes; zero runtime lines, so not reported by default).
 * How: one LanguageService per program (frontend `tsconfig.test.json`, stream `tsconfig.json`, CDK
 * `tsconfig.json` + `tsconfig.tools.json` scripts). `ts_reach_graph.mjs` resolves every identifier with
 * the checker into read/write/dynamic/escape edges from its enclosing declaration and records structural
 * flow (`ts_reach_flow.mjs`). Liveness is solved to a fixed point from the real entries — `src/main.tsx`,
 * every `import()` target (all `routes.tsx` lazy pages), the stream handlers and the plan-contract
 * generator, `bin/voc-datalake.ts` and the ts-node scripts — and the top-level code of every module those
 * load; then solved again with every spec module as an extra root, which separates `test-only` from
 * `dead`. A finding whose parent is itself a finding is folded into the parent.
 *
 * Why the reference tools miss it: knip and tsc see exports and locals, not members; `api.getPersonas`
 * is a property of an exported object that IS used, a returned `isLoading` is a property of a used
 * type, and a test import counts as a use for knip (its `--production` mode drops specs but still cannot
 * see members). `types.ts` is knip-ignored for types entirely.
 *
 * Known false-positive classes (silence one with scripts/audit/allowlists/ts_reachability.json,
 * `{"key": "<program>:<file>#<Qualified.name>", "reason": "…"}`, `*` allowed):
 *   - text-pinned lockstep exports (a spec reads the FILE as text: `contract.ts`, allowlists);
 *   - members read only through a string key typed `keyof T` (`get('a')` of a generic accessor);
 *   - members a framework reads by name outside the type system (a lifecycle hook on a non-class);
 *   - deliberate test seams (`resetXForTests`) and design-system tokens pinned by a CSS spec;
 *   - construct-API conventions (a public readonly CDK construct field nobody reads yet).
 *
 * Usage: node scripts/audit/ts_reachability.mjs [--program frontend|stream|cdk] [--root <repo>]
 *        [--json [PATH]] [--evidence] [--all-members] [--no-allowlist]
 * `--evidence` re-checks each finding with LanguageService.findReferences (prod/test reference counts).
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { resolve } from 'node:path'
import {
  checkVacuity, createService, detectorMain, entryFor, finishReport, loadTypeScript, ownSourceFiles, posixRel, runIfMain,
  selectPrograms,
} from './audit_common.mjs'
import { Graph } from './ts_reach_graph.mjs'

const TOOL = 'ts_reachability'

/** Fixed point: everything reachable from `roots` through read edges and activated flow edges. */
export function solve(graph, roots) {
  const live = new Uint8Array(graph.nodes.length)
  const waiting = new Map()
  const queue = []
  const mark = (id) => {
    if (!live[id]) {
      live[id] = 1
      queue.push(id)
    }
  }
  roots.forEach(mark)
  while (queue.length) {
    const id = queue.pop()
    for (const t of graph.read.get(id) ?? []) mark(t)
    for (const [from, to] of graph.flows.get(id) ?? []) {
      if (from.some((f) => live[f])) to.forEach(mark)
      else for (const f of from) waiting.set(f, [...(waiting.get(f) ?? []), to])
    }
    for (const to of waiting.get(id) ?? []) to.forEach(mark)
    waiting.delete(id)
  }
  return live
}

/**
 * The platform pseudo-node: always live. Entry exports are read by it, and what an entry function
 * returns escapes to it (the Lambda runtime / Step Functions read the handler's result).
 */
export function addPlatform(graph) {
  const platform = graph.addNode({ kind: 'module', name: '<platform>', qualified: '<platform>', rel: '', line: 0, isTest: false, key: '<platform>' })
  for (const [sf] of graph.moduleId) {
    const entry = entryFor(graph.def, graph.relOf(sf))
    if (!entry?.exports) continue
    const sym = graph.checker.getSymbolAtLocation(sf)
    for (const exp of sym ? graph.checker.getExportsOfModule(sym) : []) {
      graph.addRead(platform, graph.idsOf(exp))
      const resolved = exp.flags & graph.ts.SymbolFlags.Alias ? graph.checker.getAliasedSymbol(exp) : exp
      const decl = resolved.valueDeclaration
      if (!decl) continue
      for (const sig of graph.checker.getTypeOfSymbolAtLocation(resolved, decl).getCallSignatures()) {
        const ret = sig.getReturnType()
        graph.flow.escape(graph.checker.getPromisedTypeOfPromise(ret) ?? ret, platform)
      }
    }
  }
  graph.platform = platform
  return platform
}

/** Roots: the platform, entry modules' code; with `withTests`, every spec module too. */
export function rootsOf(graph, withTests) {
  const roots = [graph.platform]
  for (const [sf, id] of graph.moduleId) {
    const entry = entryFor(graph.def, graph.relOf(sf))
    if ((entry?.module) || (withTests && graph.nodes[id].isTest)) roots.push(id)
  }
  return roots
}

const RUNTIME_KINDS = new Set(['function', 'var', 'class', 'enum'])
const isRuntime = (n) => RUNTIME_KINDS.has(n.kind) || (n.kind === 'local' && n.runtime) || (n.kind === 'member' && n.member !== 'type')

/** Findings of one analysed program (`{key, kind, detail, node}`), parents before children folded. */
export function findingsOf(graph, { allMembers = false } = {}) {
  const prod = solve(graph, rootsOf(graph, false))
  const all = solve(graph, rootsOf(graph, true))
  const writtenLive = new Set()
  for (const [c, targets] of graph.write) if (prod[c]) for (const t of targets) writtenLive.add(t)
  const out = []
  const reported = new Set()
  for (const n of graph.nodes) {
    if (n.kind === 'module' || n.isTest || prod[n.id]) continue
    if (n.parent !== undefined && reported.has(n.parent)) {
      reported.add(n.id)
      continue
    }
    const refs = graph.refs.get(n.id) ?? { prod: 0, test: 0, write: 0 }
    let kind
    if (n.kind === 'member' && writtenLive.has(n.id)) kind = 'write-only'
    else if (n.kind === 'member' && n.member === 'type') kind = 'unread-type-member'
    else if (all[n.id]) kind = isRuntime(n) ? 'test-only' : 'test-only-type'
    else kind = isRuntime(n) ? 'dead' : 'dead-type'
    reported.add(n.id)
    if (kind === 'unread-type-member' && !allMembers) continue
    out.push({ key: n.key, kind, detail: `${n.rel}:${n.line} (${n.kind}${n.member ? `/${n.member}` : ''}; refs prod ${refs.prod}, test ${refs.test}, writes ${refs.write})`, node: n })
  }
  return { findings: out, counts: { files: graph.sourceFiles.length, declarations: graph.nodes.length - graph.moduleId.size } }
}

/** LanguageService.findReferences for one finding: prod/test reference counts (declaration excluded). */
export function referenceEvidence(service, graph, n) {
  const decl = n.node
  const nameNode = decl.name ?? decl
  const refs = service.findReferences(decl.getSourceFile().fileName, nameNode.getStart()) ?? []
  let prod = 0
  let test = 0
  for (const group of refs) {
    for (const r of group.references) {
      if (r.isDefinition) continue
      const rel = posixRel(graph.def.base, resolve(r.fileName))
      if (graph.def.isTestFile(rel)) test += 1
      else prod += 1
    }
  }
  return { prod, test }
}

/** Analyse one program definition (real or fixture). */
export function analyzeProgram(def, options = {}) {
  const ts = loadTypeScript()
  const { service, program } = createService(ts, def)
  const graph = new Graph(ts, program, def, ownSourceFiles(program, def))
  graph.collectAll()
  addPlatform(graph)
  const result = findingsOf(graph, options)
  if (options.evidence) {
    for (const f of result.findings) {
      const ev = referenceEvidence(service, graph, f.node)
      f.detail += `; findReferences prod ${ev.prod}, test ${ev.test}`
    }
  }
  return { ...result, graph }
}

export const main = detectorMain(TOOL, {
  usage: 'TypeScript declarations and members nothing live reads (dead, test-only, write-only, dead-type).',
  spec: { program: 'string', root: 'string', evidence: 'boolean', 'all-members': 'boolean', 'no-allowlist': 'boolean' },
}, (args) => {
  const { defs } = selectPrograms(args)
  const findings = []
  const notes = []
  for (const def of defs) {
    const started = Date.now()
    const { findings: f, counts } = analyzeProgram(def, { evidence: args.evidence, allMembers: args['all-members'] })
    checkVacuity(def, counts)
    notes.push(`${def.name} ${counts.files} files / ${counts.declarations} declarations in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    findings.push(...f.map(({ node: _node, ...rest }) => rest))
  }
  return finishReport(TOOL, args, findings, { summary: notes.join('; '), reportStale: !args.program && !args.root && !args['all-members'] })
})

runIfMain(import.meta.url, main)
