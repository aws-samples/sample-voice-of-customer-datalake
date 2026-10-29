/**
 * @fileoverview Source profiles (data-protection policy per source) and the
 * erasure jobs that remove one person's feedback.
 *
 * - `GET /settings/sources` — admins get every field; everyone else only
 *   `{id, label, restricted}` (enough to name sources in pickers). Both read
 *   through the same lenient schema, so the missing fields take their defaults.
 * - `PUT /settings/sources` (admin) — validated server-side
 *   (`shared/source_profiles.py`).
 * - `POST /settings/erasure` (admin) → 202 `{job}`; `GET` → `{jobs, sources}`,
 *   jobs newest first. The erased value is only ever hashed server-side; this
 *   client never stores it either (the form clears it once the job is accepted).
 *   `field: 'source'` erases a whole source: `value` and `confirm` both carry
 *   the source id (the server refuses a mismatch), and `sources` lists the ids
 *   it accepts (docs/source-policies.md → Delete all data from a source).
 *
 * @module api/sourceProfilesApi
 */
import { post, put } from './requestKit'
import { z } from 'zod'
import { fetchApi } from './client'
import { StringMapSchema, TagsSchema } from './dimensionsSchema'
import { toOptionalFiniteNumber } from './lenientFields'
import { parsedList } from './schemaList'
import type { PiiPolicy } from './types'

export const PII_POLICIES = ['allow', 'redact', 'summary_only'] as const satisfies readonly PiiPolicy[]
export const MAX_SOURCE_PROFILES = 50
export const MIN_RETENTION_DAYS = 30
export const MAX_RETENTION_DAYS = 3650
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
/** The profile id CSV and JSON uploads use when the uploader picks none. */
export const MANUAL_IMPORT_SOURCE = 'manual_import'

export interface SourceProfile {
  id: string
  label: string
  pii: PiiPolicy
  /** null = keep forever. */
  retention_days: number | null
  restricted: boolean
  dimension_defaults: Record<string, string>
  tags: string[]
  /** Radar source (docs/radar.md): the OTHER brand it tracks; absent on an ordinary source. */
  radar_brand?: string
  /** The tracked brand's own website domains (release search, official links). */
  radar_domains?: string[]
}

/** The Radar fields of a profile, present only when it names a brand. */
function radarFields(brand: string | undefined, domains: string[]): Pick<SourceProfile, 'radar_brand' | 'radar_domains'> {
  return brand === undefined ? {} : { radar_brand: brand, radar_domains: domains }
}

/** A positive whole number of days, else null (= keep forever). */
const retentionField = z.unknown().optional().transform((value): number | null => {
  const days = toOptionalFiniteNumber(value)
  return days !== undefined && Number.isInteger(days) && days > 0 ? days : null
})

const SourceProfileSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().catch(''),
  pii: z.enum(PII_POLICIES).catch('allow'),
  retention_days: retentionField,
  restricted: z.boolean().catch(false),
  dimension_defaults: StringMapSchema,
  tags: TagsSchema,
  radar_brand: z.string().trim().min(1).optional().catch(undefined),
  radar_domains: z.array(z.string()).catch([]).optional(),
}).transform(({ radar_brand: brand, radar_domains: domains, ...profile }): SourceProfile => ({
  ...profile,
  label: profile.label === '' ? profile.id : profile.label,
  ...radarFields(brand, domains ?? []),
}))

const SourcesEnvelopeSchema = z.object({ sources: parsedList(SourceProfileSchema) }).catch({ sources: [] })

export function normalizeSourceProfiles(raw: unknown): SourceProfile[] {
  return SourcesEnvelopeSchema.parse(raw).sources
}

/** A fresh profile with the contract defaults (allow, keep forever, open). */
export function defaultSourceProfile(id: string, label = id): SourceProfile {
  return { id, label, pii: 'allow', retention_days: null, restricted: false, dimension_defaults: {}, tags: [] }
}

// ── Erasure ─────────────────────────────────────────────────────────────────

/** The person fields of the erasure form. */
export const ERASURE_FIELDS = ['author', 'source_id', 'csv_row_id', 'email'] as const
export type ErasureField = typeof ERASURE_FIELDS[number]
/** A job's field: a person field, or `source` for a whole-source erasure. */
export const SOURCE_ERASURE_FIELD = 'source'
const JOB_FIELDS = [...ERASURE_FIELDS, SOURCE_ERASURE_FIELD] as const
export type ErasureJobField = typeof JOB_FIELDS[number]
const ERASURE_PHASES = ['items', 'raw'] as const

const ERASURE_STATUSES = ['queued', 'running', 'completed', 'failed'] as const
export type ErasureStatus = typeof ERASURE_STATUSES[number]

const count = z.number().int().nonnegative().catch(0)
const optionalText = z.string().min(1).optional().catch(undefined)

const ErasureJobSchema = z.object({
  job_id: z.string().min(1),
  // Unknown reads as failed, like reprocess jobs: never poll forever.
  status: z.enum(ERASURE_STATUSES).catch('failed'),
  field: z.enum(JOB_FIELDS).catch('author'),
  source: optionalText,
  value_hash: z.string().catch(''),
  deleted_items: count,
  deleted_objects: count,
  started_by: z.string().catch(''),
  created_at: z.string().catch(''),
  finished_at: optionalText,
  error: optionalText,
  /** A whole-source erasure deletes the reviews first, then the raw folder. */
  phase: z.enum(ERASURE_PHASES).optional().catch(undefined),
})

export type ErasureJob = z.infer<typeof ErasureJobSchema>

export function isLiveErasure(job: Pick<ErasureJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running'
}

const JobsEnvelopeSchema = z.object({ jobs: parsedList(ErasureJobSchema) }).catch({ jobs: [] })
const JobEnvelopeSchema = z.object({ job: z.unknown() }).catch({ job: undefined })
const SourcesListSchema = z.object({
  sources: z.array(z.unknown()).catch([]).transform((ids) => ids.filter((id): id is string => typeof id === 'string' && SOURCE_ID_RE.test(id))),
}).catch({ sources: [] })

/** The source ids a whole-source erasure may name (`GET /settings/erasure` → `sources`). */
export function normalizeErasableSources(raw: unknown): string[] {
  return SourcesListSchema.parse(raw).sources
}

export function normalizeErasureJobs(raw: unknown): ErasureJob[] {
  return JobsEnvelopeSchema.parse(raw).jobs
}

export function normalizeErasureJob(raw: unknown): ErasureJob | null {
  const parsed = ErasureJobSchema.safeParse(JobEnvelopeSchema.parse(raw).job)
  return parsed.success ? parsed.data : null
}

export interface ErasureRequest {
  field: ErasureField
  value: string
  source?: string
}

export interface SourceErasureRequest {
  source: string
  /** What the person typed; the server refuses it unless it equals `source`. */
  confirm: string
}

export const sourceProfilesKey = () => ['source-profiles'] as const
export const erasureJobsKey = () => ['erasure-jobs'] as const
export const erasableSourcesKey = () => ['erasure-sources'] as const

export const sourceProfilesApi = {
  getProfiles: async (): Promise<SourceProfile[]> =>
    normalizeSourceProfiles(await fetchApi<unknown>('/settings/sources')),

  saveProfiles: async (sources: SourceProfile[]): Promise<SourceProfile[]> =>
    normalizeSourceProfiles(await fetchApi<unknown>('/settings/sources', put({ sources }))),

  startErasure: async (request: ErasureRequest): Promise<ErasureJob | null> =>
    normalizeErasureJob(await fetchApi<unknown>('/settings/erasure', post(request.source === undefined || request.source === ''
        ? { field: request.field, value: request.value }
        : request))),

  startSourceErasure: async ({ source, confirm }: SourceErasureRequest): Promise<ErasureJob | null> =>
    normalizeErasureJob(await fetchApi<unknown>('/settings/erasure', post({ field: SOURCE_ERASURE_FIELD, value: source, confirm }))),

  listErasureJobs: async (): Promise<ErasureJob[]> =>
    normalizeErasureJobs(await fetchApi<unknown>('/settings/erasure')),

  listErasableSources: async (): Promise<string[]> =>
    normalizeErasableSources(await fetchApi<unknown>('/settings/erasure')),
}
