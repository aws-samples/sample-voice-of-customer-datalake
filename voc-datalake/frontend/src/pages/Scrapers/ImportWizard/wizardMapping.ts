/**
 * @fileoverview What the import wizard sends once a person confirmed the columns (7.67.00, docs/import-wizard.md).
 *
 * Reviews or tickets go through the CSV import with a `mapping` of each header to its kind: a choice column whose
 * header names a configured dimension (by key or label) becomes that dimension (`dimension:<key>`), every other
 * column keeps its kind (lambda/shared/import_wizard.py `reviews_fields` reads them). A survey export becomes an
 * imported form, its rows sent in calls sized by `importCalls`. Every row of a reviews import carries one tag
 * (`import-YYYY-MM-DD-xxxx`) so First insights reads that import's reviews only.
 *
 * @module pages/Scrapers/ImportWizard/wizardMapping
 */
import type { Dimension } from '../../../api/dimensionsSchema'
import type { ColumnKind, ImportTarget, InferredForm } from '../../../api/importWizardSchema'
import { inferredQuestions } from './inferredQuestions'

/** The rows one `POST /feedback-forms/{id}/import` call takes at most (lambda/shared/forms_v2_import.py). */
const MAX_ROWS_PER_CALL = 5000
/** The texts (each row's text, its open answers and its hidden values) one call holds when its source redacts
 * personal data, each one Comprehend call (lambda/shared/forms_v2_import.py `MAX_REDACTED_TEXTS`): a call stays well
 * inside the API's 29 s. */
const MAX_REDACTED_TEXTS = 250
/** The languages whose texts reach Comprehend (lambda/shared/pii_redaction.py `COMPREHEND_PII_LANGUAGES`): a form in
 * another one sends none, so its calls are bound by their size alone. */
const COMPREHEND_LANGUAGES: ReadonlySet<string> = new Set(['en', 'es'])
/** A call's body as its Lambda event carries it (its JSON escaped once more, as the event's `body`): Lambda takes 6 MB
 * a synchronous call, headers and request context included, so a call stays under 4 MB. */
const MAX_CALL_BYTES = 4 * 1024 * 1024

export type MappingProblem = 'noText' | 'noQuestion'

/** The kinds a question can come from (lambda/shared/import_survey.py `infer_form`). */
const QUESTION_KINDS: ReadonlySet<ColumnKind> = new Set([
  'open_text', 'nps_0_10', 'csat', 'rating_1_5', 'rating_1_10', 'choice', 'multi_choice', 'matrix_cell',
])

/** Lower-case words of a header or a dimension's label, for matching one to the other. */
function folded(text: string): string {
  const words = text.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '_')
  // (one `_` at most at each end: the replace above folds every run into one)
  const start = words.startsWith('_') ? words.slice(1) : words
  return start.endsWith('_') ? start.slice(0, -1) : start
}

/** The dimension a choice column's header names (its key or its label), if any. */
export function dimensionFor(header: string, dimensions: readonly Dimension[]): Dimension | undefined {
  const name = folded(header)
  return dimensions.find((dimension) => dimension.key === name || folded(dimension.label) === name)
}

/** The CSV import's `mapping` of a reviews file. */
export function reviewsMapping(kinds: Readonly<Record<string, ColumnKind>>, dimensions: readonly Dimension[]): Record<string, string> {
  return Object.fromEntries(Object.entries(kinds).map(([header, kind]) => {
    const dimension = kind === 'choice' ? dimensionFor(header, dimensions) : undefined
    return [header, dimension === undefined ? kind : `dimension:${dimension.key}`]
  }))
}

/** Why the kinds cannot be imported as `target`, or null. */
export function wizardMappingProblem(kinds: Readonly<Record<string, ColumnKind>>, target: ImportTarget): MappingProblem | null {
  const chosen = Object.values(kinds)
  if (target === 'reviews') return chosen.includes('open_text') ? null : 'noText'
  return chosen.some((kind) => QUESTION_KINDS.has(kind)) ? null : 'noQuestion'
}

/** The tag of one reviews import: its day and four random letters (`import-2026-11-21-k3x9`). */
export function importTag(now: Date, random: () => number = Math.random): string {
  const letters = Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(random() * 32)]).join('')
  return `import-${now.toISOString().slice(0, 10)}-${letters}`
}

interface ImportCall<T> {
  /** The index of its first row. */
  readonly offset: number
  readonly items: readonly T[]
}

const encoder = new TextEncoder()

/** The bytes `value` takes in a Lambda event: its JSON, escaped again as a string (without that string's quotes). */
export function eventBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(JSON.stringify(value))).length - 2
}

interface CallSizes {
  /** `eventBytes` of the first call without its rows (the original file rides it). */
  readonly first: number
  /** `eventBytes` of a later call without its rows (the first call's file key instead). */
  readonly later: number
  /** The texts one row may send to Comprehend (`redactedTextsPerRow`); 0 for none. */
  readonly textsPerRow: number
}

/** The texts one row of `form` sends to Comprehend under a redacting source, as the server counts them
 * (lambda/shared/forms_v2_import.py `check_redaction_budget`): its text, one per open-text question and one per hidden
 * field; none for a form in a language Comprehend does not read. */
export function redactedTextsPerRow(form: InferredForm): number {
  const { language, hidden_fields: hidden } = form.definition
  if (typeof language !== 'string' || !COMPREHEND_LANGUAGES.has(language)) return 0
  const openText = inferredQuestions(form).filter((question) => question.type === 'open_text').length
  return 1 + openText + (Array.isArray(hidden) ? hidden.length : 0)
}

/** The rows in calls, in order: each at most `MAX_REDACTED_TEXTS` texts (when a row sends any) and, with the call's
 * other fields, at most `MAX_CALL_BYTES` (a row too large on its own still goes, alone). */
export function importCalls<T>(rows: readonly T[], sizes: CallSizes): ImportCall<T>[] {
  const byTexts = sizes.textsPerRow > 0 ? Math.floor(MAX_REDACTED_TEXTS / sizes.textsPerRow) : MAX_ROWS_PER_CALL
  const maxRows = Math.max(1, Math.min(MAX_ROWS_PER_CALL, byTexts))
  const calls: { readonly offset: number; readonly items: T[]; bytes: number }[] = []
  rows.forEach((row, index) => {
    const bytes = eventBytes(row) + 1 // and its comma
    const last = calls.at(-1)
    if (last === undefined || last.items.length >= maxRows || last.bytes + bytes > MAX_CALL_BYTES) {
      calls.push({ offset: index, items: [row], bytes: (last === undefined ? sizes.first : sizes.later) + bytes })
    } else {
      last.items.push(row)
      last.bytes += bytes
    }
  })
  return calls.map(({ offset, items }) => ({ offset, items }))
}

/** An imported form's name from its file's (`Workshop results.csv` → `Workshop results`). */
export function formName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/u, '').trim()
  return (stem === '' ? fileName : stem).slice(0, 120)
}
