/**
 * @fileoverview Problem Analysis filters, kept in the URL so a filtered view can be
 * shared, survives a reload, and Back returns to it: `source`, `category`,
 * `subcategory`, `urgent=1`, `resolved=1`, `similarity` (low|med|high|off;
 * absent = the default, med) and `types` (absent = Problems only; `all`; or a comma
 * list, `feedbackTypes.ts`). The period and date basis are the header's, like every
 * other page. The URL IS the state: each setter rewrites only
 * these keys (replace, not push), so the review modal's `?review=` survives.
 *
 * Choosing a category clears the subcategory: one names the other.
 *
 * @module pages/ProblemAnalysis/useProblemFilters
 */
import { useSearchParams } from 'react-router-dom'
import { withOwnedParams } from '../../utils/searchParams'
import { isProblemsOnly, readTypeSelection, writeTypeSelection } from './feedbackTypes'
import type { TypeSelection } from './feedbackTypes'

/** How aggressively near-duplicate problems merge, by its URL token. */
const SIMILARITY_LEVELS = { low: 0.2, med: 0.4, high: 0.6, off: 1.0 } as const
export type SimilarityLevel = keyof typeof SIMILARITY_LEVELS
const DEFAULT_SIMILARITY: SimilarityLevel = 'med'

function isSimilarityLevel(value: string | null): value is SimilarityLevel {
  return value !== null && Object.hasOwn(SIMILARITY_LEVELS, value)
}

/**
 * Keys this page writes. `window` (the retired "Latest 2,000 reviews" select) is read
 * by nothing; it is listed so the next filter change drops it from an old link.
 */
const OWNED_PARAMS: readonly string[] = ['source', 'category', 'subcategory', 'urgent', 'resolved', 'similarity', 'types', 'window']

export interface ProblemFilters {
  readonly source: string | null
  readonly category: string | null
  readonly subcategory: string | null
  readonly urgentOnly: boolean
  readonly showResolved: boolean
  readonly similarity: SimilarityLevel
  readonly types: TypeSelection
}

export interface ProblemFiltersApi extends ProblemFilters {
  readonly update: (change: Partial<ProblemFilters>) => void
  readonly clear: () => void
  readonly anyActive: boolean
}

function paramOrNull(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  return value === null || value === '' ? null : value
}

/** The filters a URL says. */
function readProblemFilters(params: URLSearchParams): ProblemFilters {
  const similarity = params.get('similarity')
  return {
    source: paramOrNull(params, 'source'),
    category: paramOrNull(params, 'category'),
    subcategory: paramOrNull(params, 'subcategory'),
    urgentOnly: params.get('urgent') === '1',
    showResolved: params.get('resolved') === '1',
    similarity: isSimilarityLevel(similarity) ? similarity : DEFAULT_SIMILARITY,
    types: readTypeSelection(params.get('types')),
  }
}

/** The canonical query for `filters` (defaults omitted). */
function writeProblemFilters(filters: ProblemFilters): URLSearchParams {
  const entries: [string, string | null][] = [
    ['source', filters.source],
    ['category', filters.category],
    ['subcategory', filters.subcategory],
    ['urgent', filters.urgentOnly ? '1' : null],
    ['resolved', filters.showResolved ? '1' : null],
    ['similarity', filters.similarity === DEFAULT_SIMILARITY ? null : filters.similarity],
    ['types', writeTypeSelection(filters.types)],
  ]
  return new URLSearchParams(entries.filter((entry): entry is [string, string] => entry[1] !== null))
}

export function useProblemFilters(): ProblemFiltersApi {
  const [params, setParams] = useSearchParams()
  const filters = readProblemFilters(params)

  const write = (next: ProblemFilters) => {
    setParams((current) => withOwnedParams(current, OWNED_PARAMS, writeProblemFilters(next)), { replace: true })
  }
  const update = (change: Partial<ProblemFilters>) => {
    const categoryChanged = change.category !== undefined && change.category !== filters.category
    write({ ...filters, ...(categoryChanged ? { subcategory: null } : {}), ...change })
  }
  // Clear resets the narrowing filters; Similarity is a view setting and stays.
  const clear = () => write({ ...readProblemFilters(new URLSearchParams()), similarity: filters.similarity })

  const anyActive = filters.source !== null || filters.category !== null || filters.subcategory !== null
    || filters.urgentOnly || filters.showResolved || !isProblemsOnly(filters.types)
  return { ...filters, update, clear, anyActive }
}
