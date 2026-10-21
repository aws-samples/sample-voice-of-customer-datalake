/**
 * @fileoverview Data-quality admin API: per-source profile statistics and the
 * async jobs that refresh them or (re)calculate an LLM enrichment field.
 *
 * Its own module rather than more surface on `client.ts` (which sits at its
 * max-lines budget) — same precedent as `problemsApi` / `customFiltersApi`.
 *
 * Routes live in `lambda/api/settings_handler.py` and are admin-only (403
 * otherwise). The routes only record a job and enqueue it; a background worker
 * does the scanning and the model calls, so the UI starts a job and polls
 * `GET /settings/data-quality` for its progress.
 *
 * Every response is normalized through a lenient Zod schema at this boundary
 * (repo wire-shape rule): counters that arrive as numeric strings are coerced,
 * and a malformed row degrades to a usable shape instead of throwing.
 *
 * @module api/dataQualityApi
 */
import { z } from 'zod'
import { fetchApi } from './client'

/** Enrichment bucket for rows with no stored value (`item_value` in shared/data_quality.py). */
export const UNSCORED_BUCKET = 'unscored'

/** Profile bucket that folds every partition past the snapshot's source cap
 * (`OVERFLOW_SOURCE` in shared/data_quality.py) — not a real, enrichable source. */
export const OVERFLOW_SOURCE = '(other sources)'

export type EnrichMode = 'missing' | 'all'

export type StartDataQualityJobBody =
  | { kind: 'profile' }
  | { kind: 'enrich'; source: string; field: string; mode: EnrichMode }

const lenientString = z.union([z.string(), z.number()]).transform((value) => String(value))
const nullableString = z.string().nullable().catch(null)
const counter = z.coerce.number().catch(0)
const countsSchema = z.record(z.string(), counter).catch({})

const fieldSchema = z.object({
  name: lenientString.catch(''),
  values: z.array(lenientString.catch('')).catch([]),
})

const sourceStatsSchema = z.object({
  source: lenientString.catch(''),
  count: counter,
  ratings: countsSchema,
  sentiments: countsSchema,
  lengths: countsSchema,
  enrichment: z.record(z.string(), countsSchema).catch({}),
})

const statsSchema = z.object({
  generated_at: nullableString,
  scanned: counter,
  sources: z.array(sourceStatsSchema.nullable().catch(null)).catch([]),
})

const jobSchema = z.object({
  job_id: lenientString.catch(''),
  kind: z.string().catch(''),
  source: nullableString,
  field: nullableString,
  mode: nullableString,
  status: z.string().catch(''),
  created_at: nullableString,
  updated_at: nullableString,
  completed_at: nullableString,
  error: nullableString,
  total: counter,
  processed: counter,
  updated: counter,
  skipped: counter,
  failed: counter,
  planned: z.boolean().catch(false),
})

const responseSchema = z
  .object({
    fields: z.array(fieldSchema.nullable().catch(null)).catch([]),
    stats: statsSchema.nullable().catch(null),
    jobs: z.array(jobSchema.nullable().catch(null)).catch([]),
  })
  .catch({ fields: [], stats: null, jobs: [] })

const jobMutationSchema = z
  .object({
    success: z.boolean().catch(false),
    job: jobSchema.nullable().catch(null),
  })
  .catch({ success: false, job: null })

export type DataQualityField = z.infer<typeof fieldSchema>
export type DataQualitySourceStats = z.infer<typeof sourceStatsSchema>
export type DataQualityJob = z.infer<typeof jobSchema>

export interface DataQualityStats {
  generated_at: string | null
  scanned: number
  sources: DataQualitySourceStats[]
}

export interface DataQualityResponse {
  fields: DataQualityField[]
  stats: DataQualityStats | null
  jobs: DataQualityJob[]
}

export interface DataQualityJobMutationResponse {
  success: boolean
  job: DataQualityJob | null
}

const isPresent = <T>(value: T | null): value is T => value !== null

// Drop rows a lenient parse could only coerce to a nameless shell — they have
// nothing to render and no id or source to act on.
const normalizeFields = (fields: (DataQualityField | null)[]): DataQualityField[] =>
  fields
    .filter(isPresent)
    .filter((f) => f.name !== '')
    .map((f) => ({ ...f, values: f.values.filter((v) => v !== '') }))

const normalizeSources = (sources: (DataQualitySourceStats | null)[]): DataQualitySourceStats[] =>
  sources.filter(isPresent).filter((s) => s.source !== '')

const normalizeJobs = (jobs: (DataQualityJob | null)[]): DataQualityJob[] =>
  jobs.filter(isPresent).filter((j) => j.job_id !== '')

/** Fetch the latest profile snapshot, the enrichment-field registry, and recent jobs (newest first). */
export async function getDataQuality(): Promise<DataQualityResponse> {
  const raw = await fetchApi<unknown>('/settings/data-quality')
  const parsed = responseSchema.parse(raw)
  return {
    fields: normalizeFields(parsed.fields),
    stats: parsed.stats && { ...parsed.stats, sources: normalizeSources(parsed.stats.sources) },
    jobs: normalizeJobs(parsed.jobs),
  }
}

/** Start a profile or enrichment job. Rejects with `API Error: 409` when one already runs for the target. */
export async function startDataQualityJob(body: StartDataQualityJobBody): Promise<DataQualityJobMutationResponse> {
  const raw = await fetchApi<unknown>('/settings/data-quality/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return jobMutationSchema.parse(raw)
}

/** Cancel a running job. Rejects with `API Error: 409` when it is no longer running, 404 when unknown. */
export async function cancelDataQualityJob(jobId: string): Promise<DataQualityJobMutationResponse> {
  const raw = await fetchApi<unknown>(`/settings/data-quality/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
  return jobMutationSchema.parse(raw)
}
