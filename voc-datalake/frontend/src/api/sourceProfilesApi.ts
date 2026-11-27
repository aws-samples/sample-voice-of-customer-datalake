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
 *   jobs newest first. Every erasure states its `legal_basis` (required since
 *   6.00.00, ≤ 300 characters); so does a profile's retention period
 *   (`retention_legal_basis`, required on save when `retention_days` is set). The erased value is only ever hashed server-side; this
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
import type { RequestScope } from './baseUrl'
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
  /** Why items are deleted after `retention_days`; null on a profile saved before 6.00.00 (it keeps running). */
  retention_legal_basis: string | null
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
  retention_legal_basis: z.string().trim().min(1).nullable().optional().catch(null).transform((basis) => basis ?? null),
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
  return {
    id, label, pii: 'allow', retention_days: null, retention_legal_basis: null, restricted: false,
    dimension_defaults: {}, tags: [],
  }
}

// ── Erasure ─────────────────────────────────────────────────────────────────

/** The person fields of the erasure form. */
export const ERASURE_FIELDS = ['author', 'source_id', 'csv_row_id', 'email'] as const
export type ErasureField = typeof ERASURE_FIELDS[number]
/** A job's field: a person field, or `source` for a whole-source erasure. */
const SOURCE_ERASURE_FIELD = 'source'
const JOB_FIELDS = [...ERASURE_FIELDS, SOURCE_ERASURE_FIELD] as const
export type ErasureJobField = typeof JOB_FIELDS[number]
/** The worker's phases in order (lambda/jobs/retention/handler.py). */
const ERASURE_PHASES = [
  'registries', 'items', 'form_tests', 'exports', 'radar', 'boards', 'members', 'raw', 'lineage', 'workspace_projects',
  'workspace_lineage', 'participants', 'agent_memory', 'engineering_lineage',
] as const

const ERASURE_STATUSES = ['queued', 'running', 'completed', 'failed'] as const

const count = z.number().int().nonnegative().catch(0)
const optionalText = z.string().min(1).optional().catch(undefined)

const optionalFlag = z.boolean().optional().catch(undefined)

/** A list of keys a job kept (keys only, never content): at most the first 200, `more` when the job holds others
 *  (it keeps no count past them). `files_needing_review`: whole-file uploads that hold erased rows and others, S3
 *  import originals folders (a key ending in `/`), product documents and library items that hold the address;
 *  `files_not_checked` (since 7.97.00): the documents an erasure by email could not judge. */
const KeptKeysSchema = z.object({
  count,
  keys: z.array(z.unknown()).catch([]).transform((keys) => keys.filter((key): key is string => typeof key === 'string')),
  more: z.boolean().catch(false),
}).optional().catch(undefined)

/** The review registries check of a run (7.93.00, lambda/jobs/retention/registries.py `RESULTS`). */
const REVIEW_REGISTRIES = ['complete', 'not_backfilled', 'incomplete'] as const
/** Why a run owes its lineage marks (7.97.00, lambda/jobs/retention/registries.py `owed_code`). */
const LINEAGE_OWED_REASONS = ['not_backfilled', 'incomplete', 'failed_before_marks', 'owe_failed'] as const

/** The counters on a job row only once above 0 (lambda/shared/retention.py `ERASURE_OPTIONAL_COUNTERS`), each absent
 *  reading as 0, beside those the job schema names on its own: boards, members, workspace items, and the two the
 *  panel reads as follow-ups rather than counts (`participant_guards_malformed`, the operator's before any rerun;
 *  `participant_index_rows_kept`, which needs only the rerun). */
const OutcomeCountersSchema = z.object({
  participants_erased: count,
  participants_not_erased: count,
  deleted_export_objects: count,
  project_rows_deidentified: count,
  /** 7.98.00 (3g-pin): the prototype pins whose replies named the address, now "Team member". */
  pin_replies_deidentified: count,
  form_test_responses_deleted: count,
  product_docs_not_checked: count,
  agent_memory_people_erased: count,
  agent_memory_people_refused: count,
  agent_memory_accounts_not_erased: count,
  engineering_rows_marked: count,
  project_ids_malformed: count,
  unscoped_rows_skipped: count,
})
/** Those counters, in the order the panel lists them. */
export const ERASURE_OUTCOME_COUNTERS = OutcomeCountersSchema.keyof().options
export type ErasureOutcomeCounter = typeof ERASURE_OUTCOME_COUNTERS[number]

const ErasureJobSchema = z.object({
  job_id: z.string().min(1),
  // Unknown reads as failed, like reprocess jobs: never poll forever.
  status: z.enum(ERASURE_STATUSES).catch('failed'),
  field: z.enum(JOB_FIELDS).catch('author'),
  source: optionalText,
  value_hash: z.string().catch(''),
  /** Absent on a job started before 6.00.00. */
  legal_basis: optionalText,
  deleted_items: count,
  deleted_objects: count,
  /** Other brands' reviews (voc-radar) the job deleted. */
  deleted_radar_items: count,
  /** Personas / documents whose cited reviews or board requests were erased, now marked. */
  artifacts_marked: count,
  /** Board requests and +1s an erasure by email de-identified; absent (0) when it touched none. */
  board_items_deidentified: count,
  /** Workspace membership rows whose email and name an erasure by email removed; absent (0) when it touched none. */
  member_rows_deidentified: count,
  /** Of `deleted_items`, the workspaces' items (an erasure of a person and a retention window reach them); absent (0)
   * when it deleted none. */
  deleted_workspace_items: count,
  /** The workspace an erasure in one workspace ran in (its job row, since 7.09.00); absent on the deployment's. */
  workspace_id: optionalText,
  files_needing_review: KeptKeysSchema,
  files_not_checked: KeptKeysSchema,
  /** An erasure by email without a source, the deployment's (7.48.00): whether it walked the deployment's projects. */
  deployment_projects_walked: optionalFlag,
  /** The same walk begun under 7.98.00, so it reached every prototype pin's replies (3g-pin). */
  pins_walked: optionalFlag,
  /** An erasure by email without a source (7.72.00): whether it looked in voc-participants, and erased everyone there
   *  (nobody refused, no index row kept, no malformed row skipped). */
  participants_walked: optionalFlag,
  participants_complete: optionalFlag,
  participant_guards_malformed: count,
  participant_index_rows_kept: count,
  /** With the engineering agents (7.84.00): whether the run walked their memory and left no account unverified. */
  agent_memory_walked: optionalFlag,
  agent_memory_complete: optionalFlag,
  /** 7.93.00: the run's review registries check, whether it owes its lineage marks (with why and what happens next,
   *  the server's text) and whether it replayed what an earlier run owed. */
  review_registries: z.enum(REVIEW_REGISTRIES).optional().catch(undefined),
  lineage_owed: optionalFlag,
  incomplete_reason: optionalText,
  lineage_owed_replayed: optionalFlag,
  /** 7.97.00: why the marks are owed as a code the panel translates (registries.py `owed_code`), and the run's
   *  mode (which later run makes them); absent on an older row, which keeps `incomplete_reason`'s words. */
  lineage_owed_reason: z.enum(LINEAGE_OWED_REASONS).optional().catch(undefined),
  lineage_owed_mode: z.enum(['retention', 'erase']).optional().catch(undefined),
  ...OutcomeCountersSchema.shape,
  started_by: z.string().catch(''),
  created_at: z.string().catch(''),
  finished_at: optionalText,
  error: optionalText,
  /** The worker's phase (lambda/jobs/retention/handler.py `_phases`): the registries check, reviews, a form's test
   * responses, exports, Radar reviews, (by email) board requests, memberships, projects, participants and the agents'
   * memory, (whole source) the raw folder, then the lineage marks. */
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

/** `GET /settings/erasure`: the newest jobs and the source ids a whole-source erasure may name. */
export interface ErasureList {
  jobs: ErasureJob[]
  sources: string[]
}

export function normalizeErasureList(raw: unknown): ErasureList {
  return { jobs: normalizeErasureJobs(raw), sources: normalizeErasableSources(raw) }
}

/**
 * Whether a job that `before` showed live has since ended (completed or failed): its
 * deletions have moved the feedback counts, so every feedback view should refresh.
 */
export function erasureEnded(before: readonly ErasureJob[], after: readonly ErasureJob[]): boolean {
  const wasLive = new Set(before.filter(isLiveErasure).map((job) => job.job_id))
  return after.some((job) => wasLive.has(job.job_id) && !isLiveErasure(job))
}

export interface ErasureRequest {
  field: ErasureField
  value: string
  source?: string
  /** Why this erasure is lawful (an erasure request, a contract); never the person's name or email. */
  legal_basis: string
}

export interface SourceErasureRequest {
  source: string
  /** What the person typed; the server refuses it unless it equals `source`. */
  confirm: string
  legalBasis: string
}

export const sourceProfilesKey = () => ['source-profiles'] as const
export const erasureJobsKey = () => ['erasure-jobs'] as const

export const sourceProfilesApi = {
  /** `scope` (workspace/configScope.ts): the workspace's profiles (default) or the deployment's. */
  getProfiles: async (scope: RequestScope = 'workspace'): Promise<SourceProfile[]> =>
    normalizeSourceProfiles(await (scope === 'deployment'
      ? fetchApi<unknown>('/settings/sources', { method: 'GET' }, 'deployment')
      : fetchApi<unknown>('/settings/sources'))),

  saveProfiles: async (sources: SourceProfile[], scope: RequestScope = 'workspace'): Promise<SourceProfile[]> =>
    normalizeSourceProfiles(await (scope === 'deployment'
      ? fetchApi<unknown>('/settings/sources', put({ sources }), 'deployment')
      : fetchApi<unknown>('/settings/sources', put({ sources })))),

  startErasure: async ({ source, ...request }: ErasureRequest): Promise<ErasureJob | null> =>
    normalizeErasureJob(await fetchApi<unknown>('/settings/erasure', post(source === undefined || source === ''
      ? request
      : { ...request, source }))),

  /** Always the deployment's (no `X-Workspace-Id`): a workspace refuses a whole-source erasure (400), since the
   *  sources it may name, its lock and its sweep of `raw/<source>/` are the deployment's. */
  startSourceErasure: async ({ source, confirm, legalBasis }: SourceErasureRequest): Promise<ErasureJob | null> =>
    normalizeErasureJob(await fetchApi<unknown>('/settings/erasure', post({
      field: SOURCE_ERASURE_FIELD, value: source, confirm, legal_basis: legalBasis,
    }), 'deployment')),

  /** The jobs and the whole-source picker's sources: the current workspace's jobs (no sources) by default, the
   *  deployment's with `'deployment'`. An erasure by author, source id, CSV row or email (`startErasure`) acts in the
   *  current workspace inside one (its member admins), the deployment's outside. */
  listErasure: async (scope: RequestScope = 'workspace'): Promise<ErasureList> =>
    normalizeErasureList(await (scope === 'deployment'
      ? fetchApi<unknown>('/settings/erasure', { method: 'GET' }, 'deployment')
      : fetchApi<unknown>('/settings/erasure'))),
}
