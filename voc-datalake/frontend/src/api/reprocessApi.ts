/**
 * @fileoverview Category reprocess jobs — re-categorise stored feedback after
 * the category config changes (admin only).
 *
 * Two modes, both of which update items IN PLACE (nothing is deleted or
 * re-created):
 * - `processed` re-classifies category/subcategory from the stored (translated)
 *   text against the current config;
 * - `raw` re-runs full enrichment from the immutable raw object in S3.
 * Either costs one model call per review in the window.
 *
 * One job at a time: starting while one is queued/running answers 409. Every
 * response is normalized through a lenient Zod schema — the panel polls this
 * while the job runs, so a drifted field must not crash the poll.
 *
 * @module api/reprocessApi
 */
import { z } from 'zod'
import { fetchApi } from './client'

// `dimensions` re-infers AI dimensions only; it never overwrites a value set by
// the source, its profile or a person (`dimension_sources` source/profile/manual).
const REPROCESS_MODES = ['processed', 'raw', 'dimensions'] as const
export type ReprocessMode = typeof REPROCESS_MODES[number]

const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
export type ReprocessJobStatus = typeof JOB_STATUSES[number]

/** Statuses after which the job never changes again — polling stops here. */
const TERMINAL_STATUSES: ReadonlySet<ReprocessJobStatus> = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalJob(job: Pick<ReprocessJob, 'status'>): boolean {
  return TERMINAL_STATUSES.has(job.status)
}

/**
 * The backend's per-job cost ceiling (`MAX_REPROCESS_ITEMS` in
 * lambda/shared/reprocess_jobs.py, pinned by reprocessApi.lockstep.test.ts):
 * a job that scans this many reviews ends 'completed' with `stopped_at_ceiling`.
 */
export const MAX_REPROCESS_ITEMS = 50_000

const count = z.number().int().nonnegative().catch(0)
const optionalText = z.string().optional().catch(undefined)

const ReprocessJobSchema = z.object({
  job_id: z.string().min(1),
  // An unknown status reads as failed: a panel must never poll forever on a
  // state it cannot recognise.
  status: z.enum(JOB_STATUSES).catch('failed'),
  mode: z.enum(REPROCESS_MODES).catch('processed'),
  days: z.number().int().nonnegative().catch(0),
  include_manual: z.boolean().catch(false),
  scanned: count,
  updated: count,
  unchanged: count,
  skipped_manual: count,
  failed: count,
  started_by: z.string().catch(''),
  created_at: z.string().catch(''),
  updated_at: z.string().catch(''),
  finished_at: optionalText,
  error: optionalText,
  // Absent on jobs written before the ceiling existed.
  stopped_at_ceiling: z.boolean().optional().catch(undefined).transform((value) => value === true),
})

export type ReprocessJob = z.infer<typeof ReprocessJobSchema>

/** `{job: Job | null}` — a missing or unparseable job reads as "no job". */
const JobEnvelopeSchema = z.object({
  job: z.unknown().optional(),
}).catch({})

export function normalizeJobEnvelope(raw: unknown): ReprocessJob | null {
  const { job } = JobEnvelopeSchema.parse(raw)
  const parsed = ReprocessJobSchema.safeParse(job)
  return parsed.success ? parsed.data : null
}

/** Body of `POST /settings/categories/reprocess`; `days: 0` means all time. */
export interface ReprocessRequest {
  mode: ReprocessMode
  days: number
  include_manual: boolean
}

const BASE = '/settings/categories/reprocess'

/** Latest job, polled while it runs. */
export const latestReprocessJobKey = () => ['category-reprocess-job'] as const

export const reprocessApi = {
  getLatest: async (): Promise<ReprocessJob | null> => normalizeJobEnvelope(await fetchApi<unknown>(BASE)),

  get: async (jobId: string): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(`${BASE}/${encodeURIComponent(jobId)}`)),

  start: async (request: ReprocessRequest): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(BASE, { method: 'POST', body: JSON.stringify(request) })),

  cancel: async (jobId: string): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(`${BASE}/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })),
}
