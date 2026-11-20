/**
 * @fileoverview The Results filters as the address holds them (UX §10.1: "the URL holds the filters, so a view can
 * be shared"): `range` (7, 30, 90 or `all`; 30 when absent), `lang`, `ending` and one `hf.<id>=<value>` per hidden
 * field. "Include test responses" is NOT among them: it is never remembered (UX §10.5).
 *
 * @module pages/FeedbackForms/results/resultFilters
 */
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'

export const RANGES = ['7', '30', '90', 'all'] as const
export type Range = (typeof RANGES)[number]
const DEFAULT_RANGE: Range = '30'

const HIDDEN_PREFIX = 'hf.'

export interface ViewFilters {
  readonly range: Range
  readonly language: string
  readonly ending: string
  readonly hidden: Readonly<Record<string, string>>
}

const isRange = (value: string | null): value is Range => RANGES.some((range) => range === value)

export function readFilters(params: URLSearchParams): ViewFilters {
  const range = params.get('range')
  const hidden = Object.fromEntries([...params.entries()]
    .filter(([key, value]) => key.startsWith(HIDDEN_PREFIX) && key.length > HIDDEN_PREFIX.length && value !== '')
    .map(([key, value]) => [key.slice(HIDDEN_PREFIX.length), value]))
  return { range: isRange(range) ? range : DEFAULT_RANGE, language: params.get('lang') ?? '', ending: params.get('ending') ?? '', hidden }
}

/** `params` with the Results filters replaced by `filters` (other parameters kept). */
export function writeFilters(params: URLSearchParams, filters: ViewFilters): URLSearchParams {
  const next = new URLSearchParams([...params.entries()].filter(([key]) => key !== 'range' && key !== 'lang' && key !== 'ending' && !key.startsWith(HIDDEN_PREFIX)))
  if (filters.range !== DEFAULT_RANGE) next.set('range', filters.range)
  if (filters.language !== '') next.set('lang', filters.language)
  if (filters.ending !== '') next.set('ending', filters.ending)
  for (const [id, value] of Object.entries(filters.hidden)) next.set(`${HIDDEN_PREFIX}${id}`, value)
  return next
}

/** Does the view narrow anything beyond the default range? */
export function narrows(filters: ViewFilters): boolean {
  return filters.range !== DEFAULT_RANGE || filters.language !== '' || filters.ending !== '' || Object.keys(filters.hidden).length > 0
}

/**
 * Does the view narrow its responses by what the drop-off's counters know nothing of (a language, an ending, a hidden
 * value)? Then there is no funnel: filtered completions against every visit's opens would read as a false drop (the
 * server answers `funnel: null` too, lambda/api/feedback_form_handler.py `_funnel_hidden`). Dates alone keep it.
 */
export function hidesFunnel(filters: ViewFilters): boolean {
  return filters.language !== '' || filters.ending !== '' || Object.keys(filters.hidden).length > 0
}

export const CLEAR_FILTERS: ViewFilters = { range: DEFAULT_RANGE, language: '', ending: '', hidden: {} }

/** The request's filters. */
export function apiFilters(filters: ViewFilters, includeTest: boolean): ResultsFilters {
  return {
    days: filters.range === 'all' ? null : Number(filters.range),
    language: filters.language,
    ending: filters.ending,
    hidden: filters.hidden,
    includeTest,
  }
}
