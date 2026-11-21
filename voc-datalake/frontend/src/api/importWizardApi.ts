/**
 * @fileoverview The import wizard's calls (7.67.00, docs/import-wizard.md), all admin-only like every import:
 *
 * - `detect`: `POST /scrapers/manual/detect`, what each column of a file's first 256 KB holds;
 * - `uploadReviews`: `POST /scrapers/manual/csv-upload` with the wizard's `mapping` (reviews or tickets);
 * - `createImportedForm`: `POST /feedback-forms` with `imported` (a survey export becomes an imported form, Off);
 * - `importRows`: `POST /feedback-forms/{id}/import`, at most 5,000 rows a call (the wizard sends 1,000).
 *
 * Every call goes to the current workspace (the client's `X-Workspace-Id`).
 *
 * @module api/importWizardApi
 */
import { fetchApi } from './client'
import { parseCsvUploadResult } from './csvDatasetSchema'
import type { CsvUploadResult } from './csvDatasetSchema'
import { parseDetectAnswer, parseRowsImported } from './importWizardSchema'
import type { ColumnKind, DateOrder, DetectAnswer, FileFormat, ImportTarget, RowsImported } from './importWizardSchema'
import { post } from './requestKit'

export interface DetectRequest {
  readonly format: FileFormat
  /** The file's first 256 KB (cut at a line end), or a workbook in base64. */
  readonly sample: string
  readonly truncated: boolean
  readonly delimiter?: string
  /** The kinds a person chose so far. */
  readonly mapping?: Readonly<Record<string, ColumnKind>>
  /** Every distinct value of the choice, multiple-choice and matrix columns over the whole file. */
  readonly values?: Readonly<Record<string, readonly string[]>>
  readonly target?: ImportTarget
  readonly date_order?: DateOrder
  readonly language?: string
}

interface ReviewsUpload {
  readonly csv_text: string
  readonly delimiter: string
  /** `{header: kind | dimension:<key>}` (lambda/shared/import_wizard.py `check_reviews_mapping`). */
  readonly mapping: Readonly<Record<string, string>>
  readonly date_order: DateOrder
  /** The tag every row gets, so First insights reads this import's reviews. */
  readonly import_tag: string
  readonly default_source?: string
}

interface ImportedFormRequest {
  readonly name: string
  readonly definition: Readonly<Record<string, unknown>>
  readonly imported: { readonly from: string; readonly at: string; readonly filename: string }
}

interface OriginalFile {
  readonly name: string
  readonly format: FileFormat
  /** The file's text, or a workbook in base64. */
  readonly content: string
}

interface RowsRequest {
  readonly rows: readonly Readonly<Record<string, string>>[]
  readonly mapping: Readonly<Record<string, string>>
  readonly date_order: DateOrder
  /** The file row of the first row (refusals name the file's rows). */
  readonly offset: number
  /** The original file, on the first call only; `file_key` (the first call's `raw_s3_key` key) on the next. */
  readonly file?: OriginalFile
  readonly file_key?: string
  readonly dry_run?: boolean
}

export const importWizardApi = {
  detect: async (request: DetectRequest): Promise<DetectAnswer> =>
    parseDetectAnswer(await fetchApi<unknown>('/scrapers/manual/detect', post(request))),

  uploadReviews: async (upload: ReviewsUpload): Promise<CsvUploadResult> =>
    parseCsvUploadResult(await fetchApi<unknown>('/scrapers/manual/csv-upload', post(upload))),

  /** The new imported form's id. */
  createImportedForm: async (request: ImportedFormRequest): Promise<string> => {
    const answer = await fetchApi<{ form?: { form_id?: unknown } }>('/feedback-forms', post({
      schema_version: 2, ...request.definition, name: request.name, imported: request.imported, enabled: false,
    }))
    const formId = answer.form?.form_id
    if (typeof formId !== 'string' || formId === '') throw new Error('The form was not created')
    return formId
  },

  importRows: async (formId: string, request: RowsRequest): Promise<RowsImported> =>
    parseRowsImported(await fetchApi<unknown>(`/feedback-forms/${encodeURIComponent(formId)}/import`, post(request))),
}
