/**
 * LOCKSTEP: the SPA plan mirror (`./schema`, `./validate`, `./placeholders`,
 * `./graph`, `./canonical`) must equal the stream Lambda's
 * (`lambda/stream/src/assistant/plan/*`), and both must agree on the shared
 * fixtures in `lambda/shared/test/fixtures/plans/` (loaded through the stream's
 * own `plan-fixtures.ts`, which the Python tests read too).
 *
 * Same comparison rules as `../contract.lockstep.test.ts`: the stream modules
 * use a different zod instance, so schemas compare by JSON Schema; plain values
 * deep-equal; functions are compared by their outputs on the fixtures.
 */
import { describe, it, expect } from 'vitest'
import * as serverCanonical from '../../../../lambda/stream/src/assistant/plan/canonical'
import * as serverGraph from '../../../../lambda/stream/src/assistant/plan/graph'
import * as serverPlaceholders from '../../../../lambda/stream/src/assistant/plan/placeholders'
import * as serverSchema from '../../../../lambda/stream/src/assistant/plan/schema'
import * as serverValidate from '../../../../lambda/stream/src/assistant/plan/validate'
import { errorKeys, FINGERPRINT_CASES, PLAN_FIXTURES } from '../../../../lambda/stream/src/assistant/plan/plan-fixtures'
import { getWriteTool } from '../approvals/registry'
import { isZodSchema, jsonSchemaOf } from '../lockstep-fixtures'
import * as canonical from './canonical'
import * as graph from './graph'
import * as placeholders from './placeholders'
import * as schema from './schema'
import * as validate from './validate'

const PAIRS = [
  ['schema', serverSchema, schema],
  ['validate', serverValidate, validate],
  ['placeholders', serverPlaceholders, placeholders],
  ['graph', serverGraph, graph],
  ['canonical', serverCanonical, canonical],
] as const

const EXPORTS = PAIRS.flatMap(([module, server, mirror]) => {
  const serverExports: Record<string, unknown> = { ...server }
  const mirrorExports: Record<string, unknown> = { ...mirror }
  return Object.keys(serverExports).map((name) => [`${module}.${name}`, serverExports[name], mirrorExports[name]] as const)
})
const SCHEMAS = EXPORTS.filter(([, server]) => isZodSchema(server))
const FUNCTIONS = EXPORTS.filter(([, server]) => typeof server === 'function')
const VALUES = EXPORTS.filter(([, server]) => !isZodSchema(server) && typeof server !== 'function')

const argsSchemaFor = (tool: string) => getWriteTool(tool)?.argsSchema
const FIXTURE_CASES = PLAN_FIXTURES.map((fixture) => [fixture.name, fixture] as const)

describe('plan mirror exports', () => {
  it('reads the server modules (positive control)', () => {
    expect(EXPORTS.length).toBeGreaterThan(20)
    expect(serverSchema.PLAN_SCHEMA).toBe('voc-plan/1')
  })

  it.each(EXPORTS)('%s exists in the mirror', (_name, _server, mirror) => {
    expect(mirror).toBeDefined()
  })

  it.each(SCHEMAS)('schema %s matches (JSON Schema)', (_name, server, mirror) => {
    expect(jsonSchemaOf(mirror)).toStrictEqual(jsonSchemaOf(server))
  })

  it.each(FUNCTIONS)('function %s exists on both sides', (_name, _server, mirror) => {
    expect(typeof mirror).toBe('function')
  })

  it.each(VALUES)('value %s matches', (_name, server, mirror) => {
    expect(mirror).toStrictEqual(server)
  })
})

describe('plan validation agrees on the shared fixtures', () => {
  it('loads the shared fixture set (positive control)', () => {
    expect(PLAN_FIXTURES.filter((fixture) => !fixture.valid).length).toBeGreaterThanOrEqual(10)
  })

  it.each(FIXTURE_CASES)('%s: the mirror reports the same errors as the server without tool schemas', (_name, fixture) => {
    expect(validate.validatePlan(fixture.plan, fixture.ctx)).toStrictEqual(serverValidate.validatePlan(fixture.plan, fixture.ctx))
  })

  it.each(FIXTURE_CASES)('%s: the mirror with the SPA tool schemas gives the expected outcome', (_name, fixture) => {
    const result = validate.validatePlan(fixture.plan, { ...fixture.ctx, argsSchemaFor })
    expect(result.ok).toBe(fixture.valid)
    expect(result.ok ? [] : errorKeys(result.errors)).toStrictEqual(expect.arrayContaining(fixture.errors))
  })
})

describe('plan fingerprints agree on the shared cases', () => {
  it.each(FINGERPRINT_CASES.map((entry) => [entry.tool, entry] as const))('%s: same canonical text and sha256', async (_tool, entry) => {
    expect(canonical.canonicalWriteText(entry.tool, entry.args)).toBe(entry.canonical)
    await expect(canonical.canonicalWriteFingerprint(entry.tool, entry.args)).resolves.toBe(entry.sha256)
  })
})
