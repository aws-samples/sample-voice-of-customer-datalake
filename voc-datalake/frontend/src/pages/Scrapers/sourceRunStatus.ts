/**
 * @fileoverview Wire-boundary schema for the ?run_status variant of
 * GET /sources/status (issue #146). Lenient by design — the mock server
 * historically served a different shape for this endpoint, so nothing here
 * trusts the response to match its declared type. Malformed optional fields
 * degrade instead of rejecting the record.
 * @module pages/Scrapers/sourceRunStatus
 */

import { z } from 'zod'
import { ReadsSchema } from './reviewReads'

const sourceRunStatusSchema = z.object({
  status: z.string().min(1),
  execution_id: z.string().optional().catch(undefined),
  started_at: z.string().optional().catch(undefined),
  completed_at: z.string().optional().catch(undefined),
  items_found: z.number().optional().catch(undefined),
  errors: z.array(z.string()).optional().catch(undefined),
  // A web_reviews run: how it read each page (reviewReads.ts), each entry read leniently.
  reads: ReadsSchema,
})

export type SourceRunStatus = z.infer<typeof sourceRunStatusSchema>

/**
 * Parse the wire response into a run record, or null when the source has
 * never run (sentinel) or the payload doesn't look like a run record at all.
 */
export function parseRunRecord(raw: unknown): SourceRunStatus | null {
  const parsed = sourceRunStatusSchema.safeParse(raw)
  if (!parsed.success || parsed.data.status === 'never_run') return null
  return parsed.data
}

const runStartedSchema = z.object({ execution_id: z.string().min(1) })

/** The run id `POST /sources/{source}/run` answered, or undefined when the answer carries none. */
export function parseRunStarted(raw: unknown): string | undefined {
  const parsed = runStartedSchema.safeParse(raw)
  return parsed.success ? parsed.data.execution_id : undefined
}
