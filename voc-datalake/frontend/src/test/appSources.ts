/**
 * App UI sources for the design-system residue tests (theme/*.test.ts): every
 * non-test `.tsx` under src/, minus what docs/kiro-design-system.md puts out of
 * scope (print/PDF renderers, the embeddable form themes, generated prototypes).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC_ROOT = resolve(__dirname, '..')

const OUT_OF_SCOPE = ['PDF', 'printUtils', 'formTemplates', 'PrototypeRenderer']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    const inScope = name.endsWith('.tsx') && !name.includes('.test.') && !OUT_OF_SCOPE.some((part) => name.includes(part))
    return inScope ? [path] : []
  })
}

const SOURCE_FILE = /\.(ts|tsx)$/

/**
 * Every production `.ts` / `.tsx` path under `dir`: what `spec` matches (the caller's specs, fixtures and test
 * helpers) and `.d.ts` files left out. The source scans' walk (importCycles.test.ts, locationParams.test.ts).
 */
export function productionSourcePaths(dir: string, spec: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return productionSourcePaths(path, spec)
    return SOURCE_FILE.test(path) && !spec.test(path) && !path.endsWith('.d.ts') ? [path] : []
  })
}

/** Every in-scope app `.tsx` file, as `{ at: path/from/src.tsx, source }`. */
export function appTsxFiles(): Array<{ at: string; source: string }> {
  return walk(SRC_ROOT).map((file) => ({ at: relative(SRC_ROOT, file), source: readFileSync(file, 'utf8') }))
}

/** One entry per source line: `at` is `path/from/src.tsx:line`. */
export function appTsxLines(): Array<{ at: string; line: string }> {
  return walk(SRC_ROOT).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ at: `${relative(SRC_ROOT, file)}:${i + 1}`, line })))
}

/** The string literals on a source line (odd segments between quotes/backticks). */
export function stringLiterals(line: string): string[] {
  return line.split(/["'`]/).filter((_, i) => i % 2 === 1)
}

/** A line that is only a comment (`//`, `*`, `/*`, `{/*`). */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return ['//', '*', '/*', '{/*'].some((prefix) => trimmed.startsWith(prefix))
}
