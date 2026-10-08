/**
 * LOCKSTEP: the SPA mirror (`./contract.ts`) must equal the stream Lambda's wire
 * contract (`lambda/stream/src/assistant/contract.ts`).
 *
 * The stream module is imported directly: it is a self-contained TypeScript
 * module whose only import is `zod`, and both packages are on the same zod
 * major. Its `zod` resolves from the stream package's own node_modules, so its
 * schemas are a DIFFERENT zod instance from this package's — they are therefore
 * recognised structurally (every zod 4 schema carries `_zod.def`), never by
 * `instanceof`. Every export is then compared: plain values deep-equal, zod
 * schemas by their JSON Schema, functions by their output over every input they
 * accept.
 */
import { describe, it, expect } from 'vitest'
import * as zod from 'zod'
import * as serverContract from '../../../lambda/stream/src/assistant/contract'
import * as mirror from './contract'
import type { PageKind } from './contract'

const server: Record<string, unknown> = { ...serverContract }
const mirrorExports: Record<string, unknown> = { ...mirror }

/**
 * A zod 4 schema from either zod instance. `toJSONSchema` reads only `_zod`, so
 * this package's converter handles the stream package's schemas too.
 */
function isZodSchema(value: unknown): value is zod.ZodType {
  if (typeof value !== 'object' || value === null || !('_zod' in value)) return false
  const internals: unknown = value._zod
  return typeof internals === 'object' && internals !== null && 'def' in internals
}

/** JSON Schema of a zod export, or null when the value is not a schema. */
function jsonSchemaOf(value: unknown): unknown {
  return isZodSchema(value) ? zod.toJSONSchema(value) : null
}

const SERVER_NAMES = Object.keys(server)
const SCHEMA_NAMES = SERVER_NAMES.filter((name) => isZodSchema(server[name]))
const FUNCTION_NAMES = SERVER_NAMES.filter((name) => typeof server[name] === 'function')
const VALUE_NAMES = SERVER_NAMES.filter((name) => !SCHEMA_NAMES.includes(name) && !FUNCTION_NAMES.includes(name))
const PACK_CASES = mirror.PAGE_KINDS.flatMap((kind) => [true, false].map((isAdmin): [PageKind, boolean] => [kind, isAdmin]))

describe('assistant contract lockstep', () => {
  it('reads the server contract (positive control)', () => {
    expect(SERVER_NAMES.length).toBeGreaterThan(10)
    expect(server.AGUI_PROTOCOL_VERSION).toBe('1.0')
  })

  it('recognises the server schemas across zod instances (positive control)', () => {
    expect(SCHEMA_NAMES).toContain('forwardedPropsSchema')
    expect(jsonSchemaOf(serverContract.pageContextSchema)).toHaveProperty('type', 'object')
  })

  it('exports the same names on both sides', () => {
    // The mirror may add SPA-only helpers, but must cover every server export.
    expect(SERVER_NAMES.filter((name) => !(name in mirrorExports))).toStrictEqual([])
  })

  it.each(SCHEMA_NAMES)('schema %s matches (JSON Schema)', (name) => {
    expect(jsonSchemaOf(mirrorExports[name])).toStrictEqual(jsonSchemaOf(server[name]))
  })

  it.each(FUNCTION_NAMES)('function %s exists on both sides', (name) => {
    expect(typeof mirrorExports[name]).toBe('function')
  })

  it.each(VALUE_NAMES)('value %s matches', (name) => {
    expect(mirrorExports[name]).toStrictEqual(server[name])
  })

  it.each(PACK_CASES)('packsForPage(%s, isAdmin=%s) agrees', (kind, isAdmin) => {
    expect(mirror.packsForPage(kind, isAdmin)).toStrictEqual(serverContract.packsForPage(kind, isAdmin))
  })
})
