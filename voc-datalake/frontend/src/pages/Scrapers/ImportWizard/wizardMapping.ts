/**
 * @fileoverview What the import wizard sends once a person confirmed the columns (7.67.00, docs/import-wizard.md).
 *
 * Reviews or tickets go through the CSV import with a `mapping` of each header to its kind: a choice column whose
 * header names a configured dimension (by key or label) becomes that dimension (`dimension:<key>`), every other
 * column keeps its kind (lambda/shared/import_wizard.py `reviews_fields` reads them). A survey export becomes an
 * imported form, its rows sent 1,000 a call. Every row of a reviews import carries one tag (`import-YYYY-MM-DD-xxxx`)
 * so First insights reads that import's reviews only.
 *
 * @module pages/Scrapers/ImportWizard/wizardMapping
 */
import type { Dimension } from '../../../api/dimensionsSchema'
import type { ColumnKind, ImportTarget } from '../../../api/importWizardSchema'

/** Rows per `POST /feedback-forms/{id}/import` call: far inside the API's 29 s and its 5,000. */
export const ROWS_PER_CALL = 1000

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
export function mappingProblem(kinds: Readonly<Record<string, ColumnKind>>, target: ImportTarget): MappingProblem | null {
  const chosen = Object.values(kinds)
  if (target === 'reviews') return chosen.includes('open_text') ? null : 'noText'
  return chosen.some((kind) => QUESTION_KINDS.has(kind)) ? null : 'noQuestion'
}

/** The tag of one reviews import: its day and four random letters (`import-2026-11-21-k3x9`). */
export function importTag(now: Date, random: () => number = Math.random): string {
  const letters = Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(random() * 32)]).join('')
  return `import-${now.toISOString().slice(0, 10)}-${letters}`
}

/** `items` in runs of `size`, each with the index of its first item. */
export function chunksOf<T>(items: readonly T[], size: number): { readonly offset: number; readonly items: readonly T[] }[] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_unused, index) =>
    ({ offset: index * size, items: items.slice(index * size, (index + 1) * size) }))
}

/** An imported form's name from its file's (`Workshop results.csv` → `Workshop results`). */
export function formName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/u, '').trim()
  return (stem === '' ? fileName : stem).slice(0, 120)
}
