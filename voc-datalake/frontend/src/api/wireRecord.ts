/**
 * @fileoverview Reading an untrusted wire value as a bag of fields.
 *
 * Every lenient boundary in api/ needs the same two primitives before it can
 * normalize anything: "is this even an object I can read keys off", and "give me
 * this key as a displayable string or nothing". They were written twice, in
 * api/derivation.ts and api/documentLineage.ts, under two names — which is how a
 * pair of readers ends up disagreeing about what `null` means while both look
 * correct in isolation.
 *
 * Parsed rather than asserted, per the repository's no-`as` rule: `typeof x ===
 * 'object'` accepts arrays and null, and a type assertion accepts everything.
 *
 * @module api/wireRecord
 */
import { z } from 'zod'

const recordSchema = z.record(z.string(), z.unknown())

/**
 * A wire value as a readable bag of fields, or null when it is not one.
 *
 * Rejects the arrays and primitives an API can deliver in place of an object, so
 * a caller's field reads cannot silently yield undefined off a string.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * A displayable string, or '' for a field the wire did not supply as one.
 *
 * '' rather than null on purpose: it collapses absent, null and wrong-typed into
 * one value, so a consumer needs one check instead of three. Where the
 * difference between "not supplied" and "supplied empty" matters, a caller must
 * read the raw field itself.
 */
export function displayString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
