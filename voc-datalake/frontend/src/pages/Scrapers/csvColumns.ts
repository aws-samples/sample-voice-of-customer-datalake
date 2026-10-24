/**
 * @fileoverview CSV upload column mapping: read the header row, suggest where
 * each column goes, and check the mapping before it is sent as `column_map`.
 *
 * The suggestions mirror the server's own header synonyms (manual import
 * handler), so an untouched mapping uploads exactly as an unmapped file would;
 * a header the server would not recognise defaults to `metadata`, so nothing is
 * silently dropped.
 *
 * @module pages/Scrapers/csvColumns
 */
import type { Dimension } from '../../api/dimensionsSchema'
import type { CsvColumnTarget } from '../../api/types'

/** The single-valued field targets (each may be chosen for one column only). */
const FIELD_TARGETS = ['text', 'id', 'rating', 'date', 'author', 'title', 'url', 'channel', 'tags'] as const
type FieldTarget = typeof FIELD_TARGETS[number]

const SYNONYMS: Record<FieldTarget, readonly string[]> = {
  text: ['text', 'review', 'comment', 'feedback'],
  id: ['id', 'review_id'],
  rating: ['rating', 'stars', 'score'],
  date: ['date', 'timestamp', 'created_at'],
  author: ['author', 'user', 'user_id', 'name'],
  title: ['title', 'subject'],
  url: ['url', 'link'],
  channel: ['channel', 'source', 'source_channel'],
  tags: ['tags', 'labels'],
}

const DIMENSION_PREFIX = 'dimension:'

/** `dimension:<key>` for a dimension key. */
function dimensionTarget(key: string): CsvColumnTarget {
  return `${DIMENSION_PREFIX}${key}`
}

/** The dimension key of a `dimension:<key>` target, else undefined. */
export function dimensionKeyOf(target: string): string | undefined {
  return target.startsWith(DIMENSION_PREFIX) ? target.slice(DIMENSION_PREFIX.length) : undefined
}

/** Every target a column may take, given the configured dimensions. */
export function targetOptions(dimensions: readonly Dimension[]): CsvColumnTarget[] {
  return [...FIELD_TARGETS, ...dimensions.map((d) => dimensionTarget(d.key)), 'metadata', 'ignore']
}

export function isCsvColumnTarget(value: string, dimensions: readonly Dimension[]): value is CsvColumnTarget {
  return targetOptions(dimensions).some((target) => target === value)
}

/** Where a header most likely goes: a field synonym, a dimension (by key or label), else metadata. */
export function suggestTarget(header: string, dimensions: readonly Dimension[]): CsvColumnTarget {
  const name = header.trim().toLowerCase()
  const field = FIELD_TARGETS.find((target) => SYNONYMS[target].includes(name))
  if (field !== undefined) return field
  const dimension = dimensions.find((d) => d.key === name || d.label.toLowerCase() === name)
  return dimension === undefined ? 'metadata' : dimensionTarget(dimension.key)
}

/** One header cell: quoted (doubled quotes are a literal quote) or bare, then its terminator. */
const HEADER_CELL = /(?:"((?:[^"]|"")*)"|([^,\r\n]*))(,|\r\n|\n|\r|$)/y

/** The cells of the header row from `from` on (recursion stands in for a mutable cursor). */
function headerCells(input: string, from: number): string[] {
  HEADER_CELL.lastIndex = from
  const match = HEADER_CELL.exec(input)
  if (match === null) return []
  const [whole, quoted, bare = '', terminator] = match
  const cell = quoted === undefined ? bare : quoted.replaceAll('""', '"')
  const more = terminator === ',' && whole.length > 0
  return more ? [cell.trim(), ...headerCells(input, from + whole.length)] : [cell.trim()]
}

/** The first row of `csv` as cells (RFC 4180 quoting, BOM stripped); [] when there is none. */
export function parseCsvHeader(csv: string): string[] {
  const headers = headerCells(csv.replace(/^\uFEFF/, ''), 0)
  return headers.every((h) => h === '') ? [] : headers
}

/** The suggested mapping of every header. Duplicate headers keep the first. */
export function suggestMapping(headers: readonly string[], dimensions: readonly Dimension[]): Record<string, CsvColumnTarget> {
  const taken = new Set<CsvColumnTarget>()
  return Object.fromEntries(headers.filter((h, i) => h !== '' && headers.indexOf(h) === i).map((header) => {
    const suggested = suggestTarget(header, dimensions)
    // A second synonym of a taken field (e.g. both "review" and "comment") stays metadata.
    const target = taken.has(suggested) && suggested !== 'metadata' ? 'metadata' : suggested
    taken.add(target)
    return [header, target]
  }))
}

export interface MappingProblem {
  messageKey: string
  params: Record<string, string>
}

const PROBLEMS = {
  noText: { messageKey: 'scrapers:csvUpload.mapping.problems.noText' },
  twice: { messageKey: 'scrapers:csvUpload.mapping.problems.twice' },
} as const

/** Why the mapping cannot be sent (no text column, or a field / dimension chosen twice), or null. */
export function mappingProblem(mapping: Readonly<Record<string, CsvColumnTarget>>): MappingProblem | null {
  const targets = Object.values(mapping)
  if (!targets.includes('text')) return { messageKey: PROBLEMS.noText.messageKey, params: {} }
  const single = targets.filter((target) => target !== 'metadata' && target !== 'ignore')
  const twice = single.find((target, i) => single.indexOf(target) !== i)
  return twice === undefined ? null : { messageKey: PROBLEMS.twice.messageKey, params: { target: twice } }
}
