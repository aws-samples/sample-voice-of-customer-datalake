/**
 * @fileoverview Lenient list parsing shared by the assistant's boundary schemas:
 * entries that fail the schema are dropped instead of failing the whole list.
 *
 * @module assistant/lenient
 */
import type { z } from 'zod'

export function lenientList<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry: unknown) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
