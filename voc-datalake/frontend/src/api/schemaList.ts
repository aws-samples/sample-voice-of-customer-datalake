/**
 * @fileoverview A lenient list of schema-parsed elements.
 *
 * `lenientList` (./lenientFields) keeps the elements a type GUARD accepts, which
 * suits primitives. Object lists also need the schema's per-field `.catch`
 * defaults and transforms applied to each survivor, so this parses every element
 * and keeps the successes: one malformed row costs exactly itself, a non-array
 * reads as the empty list, and nothing is asserted.
 *
 * @module api/schemaList
 */
import { z } from 'zod'

export function parsedList<S extends z.ZodType>(schema: S) {
  return z
    .array(z.unknown())
    .catch(() => [])
    .transform((items) => items.flatMap((item): Array<z.output<S>> => {
      const parsed = schema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    }))
}

/** A client-side id for a row the user just added (objectives, KPIs). */
export function newClientId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/** A string field that reads anything else as ''. */
export const lenientText = z.string().catch('')

/** A non-empty string field, or undefined when absent / empty / wrong-typed. */
export const optionalText = z.string().min(1).optional().catch(undefined)
