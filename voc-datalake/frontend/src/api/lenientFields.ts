/**
 * @fileoverview Field-level leniency shared by the api/ wire schemas.
 *
 * Every normalizer in api/ meets the same two wire quirks: a list that may carry
 * junk elements (keep the good ones, never drop the whole list), and a number
 * that DynamoDB round-tripped as a string, `null` or `''`. They were written per
 * schema — derivation, scrapers, feedback — which is how two readers
 * end up disagreeing about what `''` means while both look correct alone.
 *
 * @module api/lenientFields
 */
import { z } from 'zod'

/**
 * A list that keeps the elements `keep` accepts and drops the rest, and reads a
 * non-array as the empty list, so one malformed element costs exactly itself.
 */
export function lenientList<T>(keep: (item: unknown) => item is T) {
  return z
    .array(z.unknown())
    .catch(() => [])
    .transform((items) => items.filter(keep))
}

/** The guard for a list of ids: strings, and not the empty one. */
export function isNonEmptyString(item: unknown): item is string {
  return typeof item === 'string' && item !== ''
}

/**
 * Coerce an unknown value to a finite number, or `undefined` when absent or
 * invalid (`null`, `''`, NaN), so a field-level `.catch` can supply the default
 * instead of 0.
 */
export function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** A list of non-blank strings: other elements dropped, a non-list read as empty. */
export const nonBlankStringList = lenientList((item): item is string => typeof item === 'string' && item.trim() !== '')
