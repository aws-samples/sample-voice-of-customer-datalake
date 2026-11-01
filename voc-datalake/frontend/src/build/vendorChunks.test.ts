/**
 * vendorChunks.json (vite.config.ts `codeSplitting.groups`): a package the app imports itself never rides
 * inside another vendor's chunk.
 *
 * The bundler puts an unlisted dependency of a listed package into that package's chunk. When the
 * app imports the same dependency, every page that uses it loads the whole chunk: `clsx`
 * inside `vendor-recharts` made the app shell import 389 KB of charts on every first load.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const FRONTEND = join(import.meta.dirname, '..', '..')
const VENDOR_CHUNKS = z.record(z.string(), z.array(z.string()))
  .parse(JSON.parse(readFileSync(join(FRONTEND, 'vendorChunks.json'), 'utf8')))
const IMPORT_RE = /from '((?:@[^'/]+\/)?[^'./][^'/]*)/gu
const SOURCE_RE = /\.tsx?$/u
const TEST_RE = /\.(?:test|spec)\.tsx?$/u

/** Every `src/` production file, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(path)
    return SOURCE_RE.test(entry.name) && !TEST_RE.test(entry.name) ? [path] : []
  })
}

/** The bare packages the app's production code imports. */
function appImports(): Set<string> {
  const names = sourceFiles(join(FRONTEND, 'src')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(IMPORT_RE)].map((match) => match[1] ?? ''))
  return new Set(names.filter((name) => name !== '' && !name.startsWith('@test')))
}

function dependenciesOf(pkg: string): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(FRONTEND, 'node_modules', pkg, 'package.json'), 'utf8'))
  const deps = typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest ? manifest.dependencies : undefined
  return typeof deps === 'object' && deps !== null ? Object.keys(deps) : []
}

describe('vendor chunks', () => {
  it('lists every dependency of a chunked vendor that the app imports itself', () => {
    const listed = new Set(Object.values(VENDOR_CHUNKS).flat())
    const imported = appImports()
    const riders = [...listed].flatMap((pkg) =>
      dependenciesOf(pkg).filter((dep) => imported.has(dep) && !listed.has(dep)).map((dep) => `${dep} (in ${pkg}'s chunk)`))
    expect(riders).toStrictEqual([])
  })

  it('keeps clsx, used by every page, out of the charts chunk', () => {
    expect(VENDOR_CHUNKS['vendor-recharts']).not.toContain('clsx')
    expect(Object.values(VENDOR_CHUNKS).flat()).toContain('clsx')
  })
})
