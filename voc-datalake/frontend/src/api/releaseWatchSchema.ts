/**
 * @fileoverview The `GET /metrics/release-watch` body, normalized leniently at the boundary
 * (`lambda/shared/release_watch.py`). An unreadable release is dropped, an unreadable
 * number reads as 0 / null, so a sparse answer renders as "no data", never a crash.
 * @module api/releaseWatchSchema
 */
import { z } from 'zod'
import { isPresent } from '../lib/typeGuards'
import { readPartialWindow, type PartialWindow } from './partialWindow'

const count = z.number().int().nonnegative().catch(0)
const nullableNumber = z.number().nullable().catch(null)

const RankedSchema = z.object({ name: z.string().min(1), count })
const SideSchema = z.object({
  days: count,
  count,
  scored: count,
  avg_sentiment: nullableNumber,
  negative: count,
  top_categories: z.array(RankedSchema.nullable().catch(null)).catch([]),
}).catch({ days: 0, count: 0, scored: 0, avg_sentiment: null, negative: 0, top_categories: [] })

const ComplaintDeltaSchema = z.object({ name: z.string().min(1), before: count, after: count })

const ReleaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().catch(''),
  kind: z.enum(['github_release', 'launch']).catch('launch'),
  date: z.string().min(1),
  before: SideSchema,
  after: SideSchema,
  deltas: z.object({
    volume_pct: nullableNumber,
    negative_pct: nullableNumber,
    sentiment: nullableNumber,
  }).catch({ volume_pct: null, negative_pct: null, sentiment: null }),
  complaint_deltas: z.array(ComplaintDeltaSchema.nullable().catch(null)).catch([]),
  regression: z.boolean().catch(false),
  reasons: z.array(z.string()).catch([]),
  feedback_ids: z.array(z.string()).catch([]),
  /** The same reviews as `feedback_ids`, each with the words its link shows (newer servers). */
  evidence: z.array(z.object({ feedback_id: z.string().min(1), title: z.string().catch('') }).nullable().catch(null)).catch([]),
})

const ReleaseWatchSchema = z.looseObject({
  window_days: count,
  releases: z.array(ReleaseSchema.nullable().catch(null)).catch([]),
})

type RawRelease = z.infer<typeof ReleaseSchema>
type RawSide = z.infer<typeof SideSchema>

export interface ReleaseSide extends Omit<RawSide, 'top_categories'> {
  top_categories: z.infer<typeof RankedSchema>[]
}

interface ReleaseEvidence {
  readonly feedbackId: string
  /** The review's title or first words; empty when the server sent none (an older answer). */
  readonly title: string
}

export interface ReleaseWatchEntry extends Omit<RawRelease, 'before' | 'after' | 'complaint_deltas' | 'evidence'> {
  before: ReleaseSide
  after: ReleaseSide
  complaint_deltas: z.infer<typeof ComplaintDeltaSchema>[]
  evidence: ReleaseEvidence[]
}

export interface ReleaseWatch {
  windowDays: number
  releases: ReleaseWatchEntry[]
  partial: PartialWindow
}

const side = (raw: RawSide): ReleaseSide => ({ ...raw, top_categories: raw.top_categories.filter(isPresent) })

/** One link per evidence review: the titled rows, else the bare ids (an older server). */
function evidenceOf(release: RawRelease): ReleaseEvidence[] {
  const titled = release.evidence.filter(isPresent).map((row) => ({ feedbackId: row.feedback_id, title: row.title.trim() }))
  return titled.length > 0 ? titled : release.feedback_ids.map((feedbackId) => ({ feedbackId, title: '' }))
}

/** The response as the UI reads it; anything unreadable becomes an empty watch. */
export function normalizeReleaseWatch(raw: unknown): ReleaseWatch {
  const parsed = ReleaseWatchSchema.catch(ReleaseWatchSchema.parse({})).parse(raw ?? {})
  return {
    windowDays: parsed.window_days,
    releases: parsed.releases.filter(isPresent).map((release) => ({
      ...release,
      before: side(release.before),
      after: side(release.after),
      complaint_deltas: release.complaint_deltas.filter(isPresent).filter((row) => row.after > row.before),
      evidence: evidenceOf(release),
    })),
    partial: readPartialWindow(raw),
  }
}
