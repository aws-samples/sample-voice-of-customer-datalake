/**
 * @fileoverview Fails when production source (`src/`, specs excluded) has a runtime import cycle.
 *
 * Why: 5.36.01 added `api/boardFields.ts` → `services/boardAuth.ts` → `api/boardFields.ts`. Vitest and the
 * dev server evaluate modules lazily and never noticed, but the Rollup bundle hoisted both into one chunk in
 * an order that read a `const` before it was initialised ("Cannot access 'LA' before initialization"), so
 * the deployed app stayed blank. Type-only imports (`import type`, `export type`) are erased by the compiler
 * and cannot cause this, so they are ignored; dynamic `import()` is lazy and ignored too.
 *
 * @module importCycles.test
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname)
const SOURCE_FILE = /\.(ts|tsx)$/
const SPEC_FILE = /\.(test|spec)\.(ts|tsx)$|\/test\/|\/__tests__\//
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']
const STATEMENT_START = /^(?:import|export)\s/
const TYPE_ONLY_START = /^(?:import|export)\s+type\s/
// The relative specifier of `… from './y'` (possibly on the closing line of a multi-line import) or `import './y'`.
const FROM_SPECIFIER = /(?:\bfrom|^import)\s+['"](\.{1,2}\/[^'"]+)['"]/

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listSources(path)
    return SOURCE_FILE.test(path) && !SPEC_FILE.test(path) && !path.endsWith('.d.ts') ? [path] : []
  })
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  if (SOURCE_FILE.test(base) && existsSync(base)) return base
  return EXTENSIONS.map((ext) => base + ext).find((candidate) => existsSync(candidate))
}

/** Whether each line belongs to a type-only `import type` / `export type` statement (it continues until the next statement). */
function typeOnlyFlags(lines: readonly string[]): boolean[] {
  return lines.reduce<boolean[]>((flags, line) => {
    const previous = flags.at(-1) ?? false
    return [...flags, STATEMENT_START.test(line) ? TYPE_ONLY_START.test(line) : previous]
  }, [])
}

/** Every value import a file makes (inline `{ type X }` specifiers still count: the module is still loaded). */
function runtimeImports(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n').map((line) => line.trim())
  const typeOnly = typeOnlyFlags(lines)
  return lines
    .flatMap((line, index) => {
      const isComment = line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')
      const specifier = typeOnly[index] === true || isComment ? undefined : FROM_SPECIFIER.exec(line)?.[1]
      return specifier === undefined ? [] : [specifier]
    })
    .map((specifier) => resolveImport(file, specifier))
    .filter((target): target is string => target !== undefined && !SPEC_FILE.test(target))
}

/** Depth-first search; returns each cycle once, as the list of files from its first member back to it. */
function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): void => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 'open') cycles.push([...stack.slice(stack.indexOf(next)), next])
      else if (!state.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const node of graph.keys()) if (!state.has(node)) visit(node)
  return cycles
}

describe('findCycles', () => {
  it('reports a two-module cycle and ignores an acyclic chain', () => {
    expect(findCycles(new Map([['a', ['b']], ['b', ['a']]]))).toStrictEqual([['a', 'b', 'a']])
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toStrictEqual([])
  })
})

describe('production source', () => {
  it('has no runtime import cycle', () => {
    const files = listSources(SRC)
    const graph = new Map(files.map((file) => [file, runtimeImports(file)]))
    const cycles = findCycles(graph).map((cycle) => cycle.map((file) => relative(SRC, file)).join(' -> '))
    expect(cycles).toStrictEqual([])
  })
})
