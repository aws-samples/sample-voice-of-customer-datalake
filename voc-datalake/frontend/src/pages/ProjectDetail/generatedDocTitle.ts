/**
 * The title each generated document is requested under.
 *
 * A version series is (base title, document type). The base title drops the
 * backend's `(vN)` suffix and a trailing ` — <label>` naming the document's own
 * type, so 'X', 'X — PRD' and 'X — PRD (v1)' are one PRD series while
 * 'X — PR/FAQ' is the PR/FAQ series 'X'. `documentSeriesKey` mirrors
 * `normalized_base_title` in lambda/shared/document_versions.py — the two test
 * tables (SERIES_KEY_CASES) are kept in lockstep.
 *
 * When more than one type is generated at once each new series title carries its
 * type, so the PRD and PR/FAQ can be told apart in the list, the picker or an
 * export. A title that continues an existing series is requested under that
 * series' stored base title, so every version of a series shares one title.
 */
import type { DocType } from '../../api/types'

const TYPE_LABEL: Readonly<Record<DocType, string>> = {
  prd: 'PRD',
  prfaq: 'PR/FAQ',
}

/** Trailing type labels per type (mirrors DOCUMENT_TYPE_TITLE_LABELS). */
const TYPE_LABELS: Readonly<Partial<Record<string, readonly string[]>>> = {
  prd: ['PRD'],
  prfaq: ['PR/FAQ', 'PR-FAQ', 'PRFAQ'],
}

/** Separators a type label may follow: em dash, en dash, hyphen. */
const LABEL_SEPARATORS = ['\u2014', '\u2013', '-']

const POSITIVE_INTEGER = /^[1-9]\d*$/

/** The fields of a stored document that identify its series. */
export interface SeriesDocument {
  readonly document_type: string
  readonly title: string
  readonly base_title?: string
}

/** NFKC, collapsed whitespace, and a terminal ` (vN)` removed (split_versioned_title). */
function unversionedTitle(title: string): string {
  const clean = title.normalize('NFKC').split(/\s+/).filter(Boolean).join(' ')
  const start = clean.toLowerCase().lastIndexOf(' (v')
  const isVersioned = start >= 0 && clean.endsWith(')')
    && POSITIVE_INTEGER.test(clean.slice(start + 3, -1))
  return isVersioned ? clean.slice(0, start) : clean
}

/** `title` without a trailing ` — <label>` (whitespace, separator, label), else null. */
function withoutLabel(title: string, label: string): string | null {
  if (!title.toLowerCase().endsWith(label.toLowerCase())) return null
  const head = title.slice(0, title.length - label.length).trimEnd()
  const separator = head.slice(-1)
  const beforeSeparator = head.slice(0, -1)
  const spaced = beforeSeparator !== beforeSeparator.trimEnd()
  const base = beforeSeparator.trimEnd()
  return LABEL_SEPARATORS.includes(separator) && spaced && base !== '' ? base : null
}

/** The base title with its `(vN)` and any own-type label suffix removed. */
function seriesBaseTitle(title: string, docType: string): string {
  const unversioned = unversionedTitle(title)
  for (const label of TYPE_LABELS[docType] ?? []) {
    const base = withoutLabel(unversioned, label)
    if (base !== null) return base
  }
  return unversioned
}

/**
 * The series identity of a title within a document type (empty for a blank title).
 * `toLowerCase` stands in for Python's `casefold`; they agree on the titles users type
 * except for rare full case-foldings such as 'ß' → 'ss'.
 */
export function documentSeriesKey(title: string, docType: string): string {
  return seriesBaseTitle(title, docType).toLowerCase()
}

function labelledTitle(title: string, docType: DocType, typeCount: number): string {
  if (typeCount < 2) return title
  const label = TYPE_LABEL[docType]
  const trimmed = title.trim()
  if (trimmed === '') return label
  return trimmed.toLowerCase().endsWith(label.toLowerCase()) ? trimmed : `${trimmed} — ${label}`
}

export function generatedDocTitle(
  title: string,
  docType: DocType,
  typeCount: number,
  existing: readonly SeriesDocument[] = [],
): string {
  const requested = labelledTitle(title, docType, typeCount)
  const key = documentSeriesKey(requested, docType)
  if (key === '') return requested
  const series = existing.find((document) => document.document_type === docType
    && documentSeriesKey(document.base_title ?? document.title, docType) === key)
  // Continue the series under its own display title ('X — PRD' stays 'X — PRD').
  return series === undefined ? requested : unversionedTitle(series.base_title ?? series.title)
}
