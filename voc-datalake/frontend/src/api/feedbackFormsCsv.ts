/**
 * @fileoverview The responses' CSV export (docs/feedback-forms.md "Results and responses"): its two layouts,
 * `familiar` (the default: one header row Excel and Sheets read as it is, a UTF-8 BOM, choices joined with `;`) and
 * `detailed` (7.04.00's, kept for scripts), the optional row of ids, and the file's name.
 *
 * The API answers its name in `Content-Disposition`, which a cross-origin read cannot see (the API exposes
 * `Content-Type` and `ETag` only), so the app names the file itself, by the server's rule:
 * `<form-name-slug>-responses-<yyyy-mm-dd>.csv`, the date in UTC.
 *
 * @module api/feedbackFormsCsv
 */
import { foldAccents } from '../pages/FeedbackForms/model/codes'

type CsvLayout = 'familiar' | 'detailed'

/** Which CSV to download: its layout, and (familiar only) a second header row of ids. */
export interface CsvChoice {
  readonly layout: CsvLayout
  readonly ids: boolean
}

export const FAMILIAR_CSV: CsvChoice = { layout: 'familiar', ids: false }

/** A downloaded CSV: the file, and the name the answer gave it when it could be read. */
export interface CsvFile {
  readonly blob: Blob
  readonly filename: string | null
}

/** The query parameters of `choice`. */
export function csvParams(choice: CsvChoice): Record<string, string> {
  return { format: 'csv', layout: choice.layout, ...(choice.ids ? { ids: 'true' } : {}) }
}

/** The file name a `Content-Disposition` header gives (`filename="…"`), null when none can be read. */
export function dispositionFilename(header: string | null): string | null {
  const match = header === null ? null : /filename="([^"/\\]+)"/.exec(header)
  return match?.[1] ?? null
}

const MAX_SLUG = 60

/** A form name as the file name's slug: lower case, accents folded, any other run of characters `-`, at most 60. */
function nameSlug(name: string): string {
  const words = foldAccents(name).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '')
  return words.join('-').slice(0, MAX_SLUG).replace(/-$/, '')
}

/**
 * `<form-name-slug>-responses-<yyyy-mm-dd>.csv` (the form id when the name gives no slug; the date in UTC), and
 * `…-detailed.csv` for the detailed layout, so both can sit in one folder.
 */
export function csvFilename(name: string, formId: string, layout: CsvLayout, now: Date = new Date()): string {
  const slug = nameSlug(name)
  const base = `${slug === '' ? formId : slug}-responses-${now.toISOString().slice(0, 10)}`
  return layout === 'detailed' ? `${base}-detailed.csv` : `${base}.csv`
}
