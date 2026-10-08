/**
 * LOCKSTEP: the `updates` allowlists of the SPA approval boundary (./schemas)
 * must equal the stream Lambda's (`lambda/stream/src/assistant/tools/client/
 * allowlists.ts`).
 *
 * The stream package cannot be imported (separate npm package, zod 3), so its
 * source is read as TEXT: the exported constant lists and the keys of each
 * nested persona section are extracted with patterns and compared with the
 * SPA's schema shapes. A key accepted by only one side would mean an approval
 * card the server proposes but the SPA refuses — or the reverse.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  FEEDBACK_FORM_UPDATABLE_FIELDS,
  LIFECYCLE_STATES,
  PERSONA_UPDATABLE_FIELDS,
  PRODUCT_CONTEXT_STRING_FIELDS,
  feedbackFormUpdatesSchema,
  personaUpdatesSchema,
  productContextUpdatesSchema,
} from './schemas'
import { at } from '@test/defined'

const SERVER_FILE = join(__dirname, '../../../../lambda/stream/src/assistant/tools/client/allowlists.ts')
const server = readFileSync(SERVER_FILE, 'utf8')

const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

/** The quoted strings of `export const NAME = [ ... ] as const`. */
function serverList(name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(server)
  if (match === null) throw new Error(`${name} array literal not found in the server allowlists`)
  return [...at(match, 1).matchAll(/'([^']+)'/g)].map((m) => at(m, 1))
}

const WORD_CHAR = /^\w$/

/** The identifier that ends `text` (`'  foo_bar'` → `'foo_bar'`). */
function trailingWord(text: string): string {
  const chars = [...text.trimEnd()].reverse()
  const end = chars.findIndex((c) => !WORD_CHAR.test(c))
  return chars.slice(0, end === -1 ? chars.length : end).reverse().join('')
}

/**
 * `key: value` pairs of an object-literal body, in order. A linear split on
 * `:` rather than a backtracking `(\w+):` pattern; the bodies read here hold
 * no `:` other than the property labels.
 */
function literalEntries(body: string): Array<[key: string, value: string]> {
  const parts = body.split(':')
  return parts.slice(1).map((value, i): [string, string] => [trailingWord(parts[i] ?? ''), value.trim()])
}

/** `export const NAME = { key: 123, ... } as const` → record. */
function serverNumberMap(name: string): Record<string, number> {
  const match = new RegExp(`export const ${name} = \\{([^}]*)\\} as const`).exec(server)
  if (match === null) throw new Error(`${name} object literal not found in the server allowlists`)
  return Object.fromEntries(literalEntries(at(match, 1)).map(([key, value]) => [key, Number(/^[\d_]+/.exec(value)?.[0].replaceAll('_', ''))]))
}

/** Keys of the `section: z.object({ ... })` literal inside the server persona schema. */
function serverSectionKeys(section: string): string[] {
  const match = new RegExp(`\\b${section}: (?:z\\.array\\()?z\\.object\\(\\{([^}]*)\\}`).exec(server)
  if (match === null) throw new Error(`persona section ${section} not found in the server allowlists`)
  return sorted(literalEntries(at(match, 1)).map(([key]) => key))
}

/** The object shape behind an optional (or optional array of) object schema. */
function sectionShapeKeys(schema: z.ZodType): string[] {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema
  const object = inner instanceof z.ZodArray ? inner.element : inner
  if (!(object instanceof z.ZodObject)) throw new Error('expected an object section')
  return sorted(Object.keys(object.shape))
}

const PERSONA_SECTIONS = [
  'identity', 'goals_motivations', 'pain_points', 'behaviors', 'context_environment', 'quotes', 'scenario',
] as const

describe('client-tool updates allowlists lockstep (server ⇄ SPA)', () => {
  it('persona: the same top-level keys', () => {
    expect(sorted(serverList('PERSONA_UPDATE_FIELDS'))).toStrictEqual(sorted(PERSONA_UPDATABLE_FIELDS))
    expect(sorted(Object.keys(personaUpdatesSchema.shape))).toStrictEqual(sorted(PERSONA_UPDATABLE_FIELDS))
  })

  it.each(PERSONA_SECTIONS)('persona: section %s has the same keys', (section) => {
    expect(serverSectionKeys(section)).toStrictEqual(sectionShapeKeys(personaUpdatesSchema.shape[section]))
  })

  it('product context: the same string fields with the same limits', () => {
    expect(serverNumberMap('PRODUCT_CONTEXT_STRING_FIELDS')).toStrictEqual({ ...PRODUCT_CONTEXT_STRING_FIELDS })
    expect(sorted(Object.keys(productContextUpdatesSchema.shape)))
      .toStrictEqual(sorted([...Object.keys(PRODUCT_CONTEXT_STRING_FIELDS), 'current_state']))
  })

  it('product context: the same lifecycle states', () => {
    expect(serverList('LIFECYCLE_STATES')).toStrictEqual([...LIFECYCLE_STATES])
  })

  it('feedback form: the same flat settings', () => {
    expect(sorted(serverList('FEEDBACK_FORM_UPDATE_FIELDS'))).toStrictEqual(sorted(FEEDBACK_FORM_UPDATABLE_FIELDS))
    expect(sorted(Object.keys(feedbackFormUpdatesSchema.shape))).toStrictEqual(sorted(FEEDBACK_FORM_UPDATABLE_FIELDS))
  })

  it('feedback form: routing and rating-scale keys stay excluded on the server too', () => {
    const serverFields = serverList('FEEDBACK_FORM_UPDATE_FIELDS')
    expect(serverFields.filter((f) => ['rating_max', 'category', 'subcategory', 'theme', 'custom_fields'].includes(f))).toStrictEqual([])
  })
})
