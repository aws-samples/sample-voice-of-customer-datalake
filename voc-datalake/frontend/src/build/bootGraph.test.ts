/**
 * What the app shell loads before any page: the modules `main.tsx` reaches through STATIC
 * imports (a lazy `import()` starts a chunk of its own). The 5.34 live test measured 8-10 s
 * first loads; 1.7 MB of shell JS was part of it, including the charts library (for `clsx`,
 * vendorChunks.test.ts), the assistant panel and the markdown renderer, none of which a page
 * needs before it renders. This pins them out of the shell.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..')
/** Type-only imports and re-exports vanish from the bundle. */
const TYPE_ONLY_RE = /(?:import|export)\s+type\s[^;]*?from\s*'[^']*'/gu
const FROM_RE = /\bfrom\s*'([^']+)'/gu
const SIDE_EFFECT_RE = /^import\s*'([^']+)'/gmu
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/** The specifiers one file imports statically (`import()` never matches: it has no `from`). */
function staticSpecifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8').replace(TYPE_ONLY_RE, '')
  return [...code.matchAll(FROM_RE), ...code.matchAll(SIDE_EFFECT_RE)].map((match) => match[1] ?? '')
}

function resolveLocal(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec)
  return [base, ...EXTENSIONS.map((ext) => `${base}${ext}`)].find((path) => /\.tsx?$/u.test(path) && existsSync(path))
}

interface ShellGraph { readonly files: Set<string>; readonly packages: Set<string> }

function visit(file: string, graph: ShellGraph): void {
  if (graph.files.has(file)) return
  graph.files.add(file)
  for (const spec of staticSpecifiers(file)) {
    const next = spec.startsWith('.') ? resolveLocal(file, spec) : undefined
    if (next !== undefined) visit(next, graph)
    else if (!spec.startsWith('.')) graph.packages.add(spec)
  }
}

/** Every source file and bare package `main.tsx` reaches through static imports. */
function shellGraph(): ShellGraph {
  const graph: ShellGraph = { files: new Set(), packages: new Set() }
  visit(join(SRC, 'main.tsx'), graph)
  return graph
}

describe('the app shell', () => {
  const { files, packages } = shellGraph()

  it('reaches the layout through static imports (the walk itself works)', () => {
    expect([...files].some((file) => file.endsWith('components/Layout/Layout.tsx'))).toBe(true)
  })

  it('loads no chart and no markdown library before a page asks for one', () => {
    expect([...packages].filter((name) => name === 'recharts' || name.startsWith('react-markdown') || name === 'remark-gfm'))
      .toStrictEqual([])
  })

  it('loads the assistant panel only when it first opens', () => {
    expect([...files].filter((file) => file.endsWith('assistant/components/AssistantPanel.tsx'))).toStrictEqual([])
  })
})
