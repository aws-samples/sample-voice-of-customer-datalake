/**
 * @fileoverview Import history (`/scrapers/manual/history*`, the manual-import Lambda,
 * `lambda/shared/import_runs.py`, docs/import-history.md): one record per paste, CSV,
 * JSON, assistant or S3 import. Admin-only, like the imports themselves.
 *
 * Every answer is normalized through a lenient Zod schema: a row without a run id is
 * dropped, a missing count reads as 0 and an unknown method or status as `unknown`.
 *
 * @module api/importHistoryApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText, optionalText, parsedList } from './schemaList'

const IMPORT_METHODS = ['paste', 'csv', 'json', 's3', 'assistant'] as const
const IMPORT_STATUSES = ['completed', 'partial', 'failed'] as const

const count = z.number().int().nonnegative().catch(0)

const CountsSchema = z.object({
  received: count, imported: count, skipped: count, duplicate: count, failed: count,
})

const ImportRunSummarySchema = z.object({
  run_id: z.string().min(1),
  method: z.enum(IMPORT_METHODS).or(z.literal('unknown')).catch('unknown'),
  source: lenientText,
  source_id: lenientText,
  actor: lenientText,
  actor_email: lenientText,
  started_at: lenientText,
  finished_at: lenientText,
  counts: CountsSchema.catch(CountsSchema.parse({})),
  status: z.enum(IMPORT_STATUSES).or(z.literal('unknown')).catch('unknown'),
  warning_count: count,
  error_count: count,
  truncated: z.boolean().catch(false),
  raw_s3_key: optionalText,
  radar_brand: optionalText,
})
export type ImportRunSummary = z.output<typeof ImportRunSummarySchema>

const ImportRunDetailSchema = ImportRunSummarySchema.extend({
  warnings: z.array(z.string()).catch([]),
  errors: z.array(z.string()).catch([]),
})
export type ImportRunDetail = z.output<typeof ImportRunDetailSchema>

const HistoryPageSchema = z.object({
  runs: parsedList(ImportRunSummarySchema),
  next_cursor: optionalText,
})
export type ImportHistoryPage = z.output<typeof HistoryPageSchema>

export function normalizeImportHistoryPage(raw: unknown): ImportHistoryPage {
  const parsed = HistoryPageSchema.safeParse(raw)
  return parsed.success ? parsed.data : { runs: [], next_cursor: undefined }
}

/** The run of `GET …/history/{run_id}`, or null when the answer carries none. */
export function normalizeImportRunDetail(raw: unknown): ImportRunDetail | null {
  const parsed = z.object({ run: ImportRunDetailSchema }).safeParse(raw)
  return parsed.success ? parsed.data.run : null
}

export const importHistoryKey = () => ['import-history'] as const
export const importRunKey = (runId: string) => ['import-history', 'run', runId] as const

const PATH = '/scrapers/manual/history'
const IMPORT_HISTORY_PAGE_SIZE = 25

export const importHistoryApi = {
  list: async (cursor?: string): Promise<ImportHistoryPage> => {
    const params = new URLSearchParams({ limit: String(IMPORT_HISTORY_PAGE_SIZE) })
    if (cursor !== undefined) params.set('cursor', cursor)
    return normalizeImportHistoryPage(await fetchApi<unknown>(`${PATH}?${params.toString()}`))
  },
  get: async (runId: string): Promise<ImportRunDetail | null> =>
    normalizeImportRunDetail(await fetchApi<unknown>(`${PATH}/${encodeURIComponent(runId)}`)),
}
