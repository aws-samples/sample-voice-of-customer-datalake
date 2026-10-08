/**
 * @fileoverview Reading a metrics response's "the window was not read in full"
 * flags, leniently, at the boundary.
 *
 * `is_partial` (see `MetricsSummary.is_partial`) says the counts are a lower
 * bound. Since all-time windows exist, one cause carries detail worth showing:
 * a per-day walk that hit the request's TIME BUDGET stops early and reports
 * `partial_reason: 'time_budget'` with `scanned_through: 'YYYY-MM-DD'` — the
 * oldest day it reached — so the UI can say how far back the numbers go.
 *
 * @module api/partialWindow
 */
import { z } from 'zod'

/** The partial reason whose `scanned_through` date the UI names. */
const TIME_BUDGET_REASON = 'time_budget'

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const PartialFlagsSchema = z.object({
  is_partial: z.boolean().catch(false),
  partial_reason: z.string().optional().catch(undefined),
  scanned_through: isoDay.optional().catch(undefined),
}).catch({ is_partial: false })

export interface PartialWindow {
  isPartial: boolean
  /** Oldest day read, when the walk stopped on its time budget. */
  scannedThrough: string | null
}

/** The flags of any metrics response; an absent or malformed flag reads as complete. */
export function readPartialWindow(response: unknown): PartialWindow {
  const flags = PartialFlagsSchema.parse(response ?? {})
  const scannedThrough = flags.is_partial && flags.partial_reason === TIME_BUDGET_REASON
    ? flags.scanned_through ?? null
    : null
  return { isPartial: flags.is_partial, scannedThrough }
}
