/**
 * @fileoverview Wire-boundary schema for the ?run_status variant of
 * GET /sources/status (issue #146). Lenient by design — the mock server
 * historically served a different shape for this endpoint, so nothing here
 * trusts the response to match its declared type. Malformed optional fields
 * degrade instead of rejecting the record.
 * @module pages/Scrapers/sourceRunStatus
 */

import { z } from 'zod'

const sourceRunStatusSchema = z.object({
  status: z.string().min(1),
  started_at: z.string().optional().catch(undefined),
  completed_at: z.string().optional().catch(undefined),
  items_found: z.number().optional().catch(undefined),
  errors: z.array(z.string()).optional().catch(undefined),
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
