/**
 * @fileoverview Content of the `tool` message the SPA sends after an approval card resolves.
 *
 * The statuses are the stream Lambda's (`TOOL_OUTCOME_STATUSES` in `@stream/assistant/contract`, which
 * documents each shape); the schema of the message itself is the SPA's, because only the SPA writes it.
 *
 * @module assistant/toolOutcome
 */
import { z } from 'zod'

export const toolOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('executed'), summary: z.string(), data: z.unknown().optional() }),
  z.object({ status: z.literal('failed'), error: z.string() }),
  z.object({ status: z.literal('declined'), reason: z.string().optional() }),
])
export type ToolOutcome = z.infer<typeof toolOutcomeSchema>
