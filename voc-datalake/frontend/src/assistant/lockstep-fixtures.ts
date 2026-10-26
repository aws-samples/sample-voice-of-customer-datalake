/**
 * Shared by the lockstep specs that compare an SPA mirror with a stream Lambda
 * module (`contract.lockstep.test.ts`, `plan/plan.lockstep.test.ts`). The stream
 * modules resolve `zod` from the stream package, a DIFFERENT zod instance, so
 * schemas are recognised structurally (every zod 4 schema carries `_zod.def`) and
 * compared by JSON Schema, never by `instanceof`.
 */
import * as zod from 'zod'

/** A zod 4 schema from either zod instance. */
export function isZodSchema(value: unknown): value is zod.ZodType {
  if (typeof value !== 'object' || value === null || !('_zod' in value)) return false
  const internals: unknown = value._zod
  return typeof internals === 'object' && internals !== null && 'def' in internals
}

/** JSON Schema of a zod export, or null when the value is not a schema. */
export function jsonSchemaOf(value: unknown): unknown {
  return isZodSchema(value) ? zod.toJSONSchema(value) : null
}
