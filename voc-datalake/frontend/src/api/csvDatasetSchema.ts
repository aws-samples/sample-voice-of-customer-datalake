/**
 * @fileoverview Wire shapes of a CSV dataset upload (issue #411, docs/csv-import.md).
 *
 * `POST /scrapers/manual/csv-upload` with `dataset_name` keys every row that has its own
 * `id` by (dataset, id), so a corrected re-upload updates the stored row. A `dry_run`
 * answers what the upload would do (`counts` + the first changed rows); a real upload that
 * changes stored rows needs `apply_updates: true` (409 otherwise). Lenient like the other
 * boundary schemas: a missing count reads 0, a malformed changed row is dropped.
 *
 * The dataset-name rule is lockstepped with `lambda/shared/csv_datasets.py` `dataset_key`.
 *
 * @module api/csvDatasetSchema
 */
import { z } from 'zod'
import { parseEach } from './lenientFields'

/** Longest dataset name (`DATASET_NAME_MAX_LENGTH`). */
export const DATASET_NAME_MAX_LENGTH = 64
const DATASET_NAME = /^[A-Za-z0-9 ._-]+$/

export type DatasetNameProblem = 'tooLong' | 'invalidChars'

/** Why `raw` cannot be a dataset name, or null when it can (blank = no dataset, also fine). */
export function datasetNameProblem(raw: string): DatasetNameProblem | null {
  const name = raw.trim()
  if (name === '') return null
  if (name.length > DATASET_NAME_MAX_LENGTH) return 'tooLong'
  return DATASET_NAME.test(name) ? null : 'invalidChars'
}

const count = z.number().int().nonnegative().catch(0)

const CountsSchema = z.object({ new: count, changed: count, unchanged: count, v1_rows: count })
  .catch({ new: 0, changed: 0, unchanged: 0, v1_rows: 0 })

export type CsvDatasetCounts = z.infer<typeof CountsSchema>

const ChangedRowSchema = z.object({
  row: z.number().int().positive().nullable().catch(null),
  csv_row_id: z.string().nullable().catch(null),
  before: z.string().catch(''),
  after: z.string().catch(''),
})

export type CsvChangedRow = z.infer<typeof ChangedRowSchema>

const PreviewSchema = z.object({
  total_rows: count,
  counts: CountsSchema,
  changed_rows: z.unknown().transform((value) => parseEach(ChangedRowSchema, value)),
  changed_rows_truncated: z.boolean().catch(false),
  warnings: z.array(z.string()).optional().catch(undefined),
})

export type CsvDatasetPreview = z.infer<typeof PreviewSchema>

/** A dry-run answer, normalised (never throws). */
export function parseCsvDatasetPreview(raw: unknown): CsvDatasetPreview {
  const parsed = PreviewSchema.safeParse(raw)
  return parsed.success ? parsed.data : PreviewSchema.parse({})
}

const UploadSchema = z.object({
  imported_count: count,
  total_rows: count,
  counts: CountsSchema.optional().catch(undefined),
  warnings: z.array(z.string()).optional().catch(undefined),
  errors: z.array(z.string()).optional().catch(undefined),
})

export type CsvUploadResult = z.infer<typeof UploadSchema>

/** A real upload's answer, normalised (never throws). */
export function parseCsvUploadResult(raw: unknown): CsvUploadResult {
  const parsed = UploadSchema.safeParse(raw)
  return parsed.success ? parsed.data : UploadSchema.parse({})
}
