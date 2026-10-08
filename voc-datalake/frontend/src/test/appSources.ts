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
