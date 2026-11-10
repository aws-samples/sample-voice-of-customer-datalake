/**
 * @fileoverview Ensure every project's default row in ONE request per view, and hand
 * the answer back as one settled result per project.
 *
 * The page used to fire one `POST /projects/prioritization/rows` per project on load
 * (8 projects = 8 requests). The route now also takes `{project_ids}` and answers each
 * project under `rows` or `errors`; this module sends that one request (split only past
 * `ROW_ENSURE_BATCH_LIMIT`) and maps the answer back to the per-project
 * `PromiseSettledResult` shape the page already reads, so `rowsAnswered`,
 * `refusalsByProject` and `isPermanentRefusal` judge a batched answer exactly as they
 * judged a single one:
 *
 *  - a `rows` entry is a fulfilled `{created, row}`;
 *  - an `errors` entry is a rejected `ApiError` carrying that item's status;
 *  - a project the answer does not mention, or a whole request that failed, is a
 *    rejection the page treats as transient and retries.
 *
 * OLDER API: one that predates the batch reads `project_id` only and answers the whole
 * request 400. The current API answers 400 for a whole batch only when the list itself
 * is malformed, which this module never sends, so a request-level 400 falls back to the
 * single-project shape (one request per project), keeping a frontend deployed ahead of
 * its API working.
 *
 * @module pages/Prioritization/rowEnsureBatch
 */
import { z } from 'zod'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { api } from '../../api/client'
import { ApiError } from '../../lib/errors'

/** Mirrors MAX_ROW_ENSURE_BATCH in lambda/shared/prioritization_row_batch.py. */
const ROW_ENSURE_BATCH_LIMIT = 25

/** What one project's ensure resolved to — the single-row answer's shape. */
interface EnsureAnswer {
  readonly created?: boolean
  readonly row?: unknown
}

type EnsureSettled = PromiseSettledResult<EnsureAnswer>

const RowEntrySchema = z.object({
  project_id: z.string(),
  created: z.boolean().catch(false),
  row: z.unknown(),
})
const ErrorEntrySchema = z.object({
  project_id: z.string(),
  status: z.number().int(),
  error: z.string().optional().catch(undefined),
})
// Lenient per entry: one unreadable entry drops only itself, and its project is then
// "not mentioned", so it is retried rather than mistaken for a refusal.
const BatchAnswerSchema = z.object({
  rows: z.array(z.unknown()).catch([]),
  errors: z.array(z.unknown()).catch([]),
})

function parsedEntries<T>(schema: z.ZodType<T>, entries: readonly unknown[]): T[] {
  return entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

/** The batch answer as one settled result per asked project, in the asked order. */
function settledPerProject(projectIds: readonly string[], raw: unknown): EnsureSettled[] {
  const answer = BatchAnswerSchema.safeParse(raw)
  const rows = answer.success ? parsedEntries(RowEntrySchema, answer.data.rows) : []
  const errors = answer.success ? parsedEntries(ErrorEntrySchema, answer.data.errors) : []
  const rowsById = new Map(rows.map((entry) => [entry.project_id, entry]))
  const errorsById = new Map(errors.map((entry) => [entry.project_id, entry]))
  return projectIds.map((projectId): EnsureSettled => {
    const row = rowsById.get(projectId)
    if (row) return { status: 'fulfilled', value: { created: row.created, row: row.row } }
    const refused = errorsById.get(projectId)
    const reason = refused
      ? new ApiError(refused.status, refused.error)
      : new Error(`The API did not answer for project ${projectId}`)
    return { status: 'rejected', reason }
  })
}

function chunked(ids: readonly string[], size: number): string[][] {
  return Array.from(
    { length: Math.ceil(ids.length / size) },
    (_, index) => ids.slice(index * size, (index + 1) * size),
  )
}

async function ensureChunk(projectIds: readonly string[]): Promise<EnsureSettled[]> {
  try {
    return settledPerProject(projectIds, await api.ensurePrioritizationRows(projectIds))
  } catch (error) {
    if (apiErrorStatus(error) === 400) {
      return Promise.allSettled(projectIds.map((id) => api.createPrioritizationRow(id)))
    }
    return projectIds.map((): EnsureSettled => ({ status: 'rejected', reason: error }))
  }
}

/**
 * Ensure the default row of every project in `projectIds`: one request per
 * `ROW_ENSURE_BATCH_LIMIT` projects, one settled result per project, in order.
 */
export async function ensureDefaultRows(projectIds: readonly string[]): Promise<EnsureSettled[]> {
  const answers = await Promise.all(chunked(projectIds, ROW_ENSURE_BATCH_LIMIT).map(ensureChunk))
  return answers.flat()
}
