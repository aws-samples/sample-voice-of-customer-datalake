/**
 * @fileoverview The feedback facets kept in the page URL (`api/feedbackFacets.ts`).
 *
 * The URL IS the state: reading parses it, every setter rewrites only the facet keys
 * (replace, not push), so a filtered page is a shareable link, survives a reload, and the
 * review modal's `?review=` (or any other key) is kept. The Dashboard reads it as-is; the
 * Categories and Problem Analysis pages use the same parse / write helpers for these keys.
 *
 * @module hooks/useFacetParams
 */
import { useSearchParams } from 'react-router-dom'
import { EMPTY_FACETS, FACET_PARAMS, facetEntries, readFacets, toggleFacetValue } from '../api/feedbackFacets'
import type { FacetName, FeedbackFacets } from '../api/feedbackFacets'
import { withOwnedParams } from '../utils/searchParams'

const OWNED_PARAMS: readonly string[] = Object.values(FACET_PARAMS)

export interface FacetParamsApi {
  readonly facets: FeedbackFacets
  /** Check or uncheck one value of one facet (an unknown enum value is dropped on the next read). */
  readonly toggle: (name: FacetName, value: string) => void
  /** Clear one facet (every value = no filter). */
  readonly clearFacet: (name: FacetName) => void
  readonly clearAll: () => void
}

export function useFacetParams(): FacetParamsApi {
  const [params, setParams] = useSearchParams()
  const facets = readFacets(params)

  // Written as query entries and read back through `readFacets`, which validates every value.
  const write = (entries: [string, string][]) => {
    setParams((current) => withOwnedParams(current, OWNED_PARAMS, new URLSearchParams(entries)), { replace: true })
  }
  const replaced = (name: FacetName, values: readonly string[]): [string, string][] => [
    ...facetEntries(facets).filter(([key]) => key !== FACET_PARAMS[name]),
    ...(values.length > 0 ? [[FACET_PARAMS[name], values.join(',')] satisfies [string, string]] : []),
  ]
  return {
    facets,
    toggle: (name, value) => write(replaced(name, toggleFacetValue<string>(facets[name], value))),
    clearFacet: (name) => write(replaced(name, [])),
    clearAll: () => write(facetEntries(EMPTY_FACETS)),
  }
}
