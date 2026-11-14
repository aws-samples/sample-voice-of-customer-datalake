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
 * A job replays a SLICE (TENETS.md D3): `sources`, `categories`, and either `days`
 * or a `date_from`/`date_to` range on the processed or the review date. A job
 * that reaches the per-job ceiling ends `partial`; `{resume: <job_id>}` continues
 * it from where it stopped. docs/categories.md → "Reprocessing a slice".
 *
 * One job at a time per scope (the deployment's, and each workspace's own since
 * 7.13.00): starting while one is queued/running answers 409. Every
 * response is normalized through a lenient Zod schema — the panel polls this
 * while the job runs, so a drifted field must not crash the poll.
 *
 * @module api/reprocessApi
 */
import { post } from './requestKit'
import { z } from 'zod'
import { fetchApi } from './client'
import type { RequestScope } from './baseUrl'

// `dimensions` re-infers AI dimensions only; it never overwrites a value set by
// the source, its profile or a person (`dimension_sources` source/profile/manual).
const REPROCESS_MODES = ['processed', 'raw', 'dimensions'] as const
export type ReprocessMode = typeof REPROCESS_MODES[number]

const JOB_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const
export type ReprocessJobStatus = typeof JOB_STATUSES[number]

/** Statuses after which the job never changes again — polling stops here. */
const TERMINAL_STATUSES: ReadonlySet<ReprocessJobStatus> = new Set(['completed', 'partial', 'failed', 'cancelled'])

const DATE_BASES = ['processed', 'review'] as const
export type ReprocessDateBasis = typeof DATE_BASES[number]

/** Bounds of a slice axis (`MAX_SLICE_VALUES` in lambda/shared/reprocess_slices.py). */
export const MAX_SLICE_VALUES = 50

export function isTerminalJob(job: Pick<ReprocessJob, 'status'>): boolean {
  return TERMINAL_STATUSES.has(job.status)
}

/**
 * The backend's per-job cost ceiling (`MAX_REPROCESS_ITEMS` in
 * lambda/shared/reprocess_jobs.py, pinned by reprocessApi.lockstep.test.ts):
 * a job that scans this many reviews ends 'partial' with `stopped_at_ceiling`, and can be resumed.
 */
export const MAX_REPROCESS_ITEMS = 50_000

const count = z.number().int().nonnegative().catch(0)
const optionalText = z.string().optional().catch(undefined)
const textList = z.array(z.unknown()).optional().catch(undefined)
  .transform((values) => (values ?? []).filter((value): value is string => typeof value === 'string'))

/** The configuration the worker derived with (`config` on the job row). */
const JobConfigSchema = z.object({
  config_version: z.number().int().nullable().catch(null),
  categories_sha16: z.string().nullable().catch(null),
  model_id: z.string().nullable().catch(null),
  prompt_version: z.string().nullable().catch(null),
}).nullable().optional().catch(null).transform((value) => value ?? null)

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
  // The slice (absent on jobs written before slices: `days` only).
  sources: textList,
  categories: textList,
  date_from: optionalText,
  date_to: optionalText,
  date_basis: z.enum(DATE_BASES).catch('processed'),
  // Raw mode: reviews replayed from the stored text (no archived raw item), and their sources.
  raw_fallback: count,
  raw_fallback_sources: textList,
  resumable: z.boolean().optional().catch(undefined).transform((value) => value === true),
  resumed_from: optionalText,
  /** On a cancelled or failed resumer: the partial job it handed back, still resumable (GET latest only). */
  resumable_job_id: optionalText,
  config: JobConfigSchema,
  config_changed: z.boolean().optional().catch(undefined).transform((value) => value === true),
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

/** The window of a new job: `days` (0 = all time) OR a `date_from`/`date_to` range, never both. */
export type ReprocessWindow =
  | { days: number }
  | { date_from?: string; date_to?: string; date_basis: ReprocessDateBasis }

/** Body of `POST /settings/categories/reprocess` for a new job. */
export type ReprocessStart = {
  mode: ReprocessMode
  include_manual: boolean
  sources?: string[]
  categories?: string[]
} & ReprocessWindow

/** A new job, or `{resume}`: continue a partial job where it stopped (same mode and slice). */
export type ReprocessRequest = ReprocessStart | { resume: string }

const BASE = '/settings/categories/reprocess'

/** Latest job, polled while it runs. */
export const latestReprocessJobKey = () => ['category-reprocess-job'] as const

/**
 * Whose job a call reaches (since 7.13.00, workspace/configScope.ts): `'workspace'` (the default) names the current
 * workspace, so inside one it is that workspace's own job, replaying its reviews with its own categories and
 * dimensions, for its admins; `'deployment'` never names one, so Administration's panel reaches the deployment's
 * job, for the deployment's administrators, from any address.
 */
export const reprocessApi = {
  getLatest: async (scope: RequestScope = 'workspace'): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(BASE, { method: 'GET' }, scope)),

  start: async (request: ReprocessRequest, scope: RequestScope = 'workspace'): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(BASE, post(request), scope)),

  cancel: async (jobId: string, scope: RequestScope = 'workspace'): Promise<ReprocessJob | null> =>
    normalizeJobEnvelope(await fetchApi<unknown>(`${BASE}/${encodeURIComponent(jobId)}/cancel`, post(), scope)),
}
