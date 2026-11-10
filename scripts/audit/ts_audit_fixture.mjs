/**
 * Spec helpers for the Node detector tests: a throw-away file tree (`tempTree`) and a TypeScript project
 * (`fixtureProject`, shaped like one program definition of `audit_common.realPrograms`) in a temp dir, never
 * the real tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isTestPath } from './audit_common.mjs'

const TSCONFIG = {
  compilerOptions: {
    strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'],
    skipLibCheck: true, noEmit: true, types: [], jsx: 'preserve',
  },
  include: ['src'],
}

/** Write `files` (`{relPath: text}`) under a fresh temp dir; returns the dir. */
export function tempTree(files, prefix = 'audit-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return dir
}

/** A TypeScript project of `files` in a temp dir; returns `{dir, def, cleanup}`. */
export function fixtureProject(files, { entries = [{ file: 'src/main.ts', module: true }], name = 'fx' } = {}) {
  const dir = tempTree({ 'tsconfig.json': JSON.stringify(TSCONFIG), ...files }, 'ts-audit-')
  const def = { name, base: dir, tsconfigs: [join(dir, 'tsconfig.json')], entries, isTestFile: isTestPath }
  return { dir, def, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** `key → kind` of a findings list, for compact assertions. */
export const kinds = (findings) => Object.fromEntries(findings.map((f) => [f.key, f.kind]))
