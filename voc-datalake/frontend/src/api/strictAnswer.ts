/**
 * @fileoverview A whole answer read strictly: what is not its schema's shape at all is an error ("The <what> answer was
 * unreadable"), where a bad entry inside it costs only itself (api/lenientFields). The engineering clients' reads
 * (the run workspace, the flow setup, the knowledge packs).
 *
 * @module api/strictAnswer
 */
import type { z } from 'zod'

export function parsedAnswer<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
  const result = schema.safeParse(raw)
  if (!result.success) throw new Error(`The ${what} answer was unreadable`)
  return result.data
}
