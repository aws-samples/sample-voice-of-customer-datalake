/**
 * @fileoverview The modules a source file reaches through STATIC imports, for the build specs (bootGraph: the app
 * shell; readEngineImports: the light reader and the Agents route). A lazy `import()` starts a chunk of its own and
 * is never followed; type-only imports vanish from the bundle and are skipped too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SRC = join(import.meta.dirname, '..')
/** Type-only imports and re-exports vanish from the bundle. */
const TYPE_ONLY_RE = /(?:import|export)\s+type\s[^;]*?from\s*'[^']*'/gu
const FROM_RE = /\bfrom\s*'([^']+)'/gu
const SIDE_EFFECT_RE = /^import\s*'([^']+)'/gmu
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/** The specifiers one file imports statically (`import()` never matches: it has no `from`). */
export function staticSpecifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8').replace(TYPE_ONLY_RE, '')
  return [...code.matchAll(FROM_RE), ...code.matchAll(SIDE_EFFECT_RE)].map((match) => match[1] ?? '')
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec)
  return [base, ...EXTENSIONS.map((ext) => `${base}${ext}`)].find((path) => /\.tsx?$/u.test(path) && existsSync(path))
}

export interface ImportGraph { readonly files: Set<string>; readonly packages: Set<string> }

function visit(file: string, graph: ImportGraph): void {
  if (graph.files.has(file)) return
  graph.files.add(file)
  for (const spec of staticSpecifiers(file)) {
    const next = spec.startsWith('.') ? resolveLocal(file, spec) : undefined
    if (next !== undefined) visit(next, graph)
    else if (!spec.startsWith('.')) graph.packages.add(spec)
  }
}

/** Every source file and bare package the `entries` (paths under src/) reach through static imports. */
export function importGraph(...entries: readonly string[]): ImportGraph {
  const graph: ImportGraph = { files: new Set(), packages: new Set() }
  for (const entry of entries) visit(join(SRC, entry), graph)
  return graph
}
