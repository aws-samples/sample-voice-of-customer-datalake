import { describe, expect, it } from 'vitest'
import {
  EMPTY_FACETS, MAX_FACET_VALUES, countActiveFacets, facetEntries, facetQueryParams, facetsKey, hasActiveFacets,
  isUsefulnessBand, parseListParam, readFacets, toggleFacetValue,
} from './feedbackFacets'
import type { FeedbackFacets } from './feedbackFacets'

describe('readFacets', () => {
  it('reads one value and comma lists from the same keys the API takes', () => {
    const facets = readFacets(new URLSearchParams('source=web,app&category=delivery&sentiment=negative,mixed&usefulness=high,unrated'))
    expect(facets).toStrictEqual({
      sources: ['web', 'app'], categories: ['delivery'], sentiments: ['negative', 'mixed'], usefulness: ['high', 'unrated'],
    })
  })

  it('drops unknown enum values, blanks and repeats', () => {
    const facets = readFacets(new URLSearchParams('source= web,,web &sentiment=angry,positive&usefulness=great'))
    expect(facets).toStrictEqual({ ...EMPTY_FACETS, sources: ['web'], sentiments: ['positive'] })
  })

  it('reads nothing from an empty query', () => {
    expect(readFacets(new URLSearchParams())).toStrictEqual(EMPTY_FACETS)
  })
})

describe('parseListParam', () => {
  it('caps a list at the server bound', () => {
    const long = Array.from({ length: MAX_FACET_VALUES + 5 }, (_, n) => `s${n}`).join(',')
    expect(parseListParam(long)).toHaveLength(MAX_FACET_VALUES)
  })
})

describe('writing facets', () => {
  const facets: FeedbackFacets = { sources: ['web', 'app'], categories: [], sentiments: ['negative'], usefulness: [] }

  it('writes only the set facets, comma-joined, in a fixed order', () => {
    expect(facetEntries(facets)).toStrictEqual([['source', 'web,app'], ['sentiment', 'negative']])
    expect(facetQueryParams(facets)).toStrictEqual({ source: 'web,app', sentiment: 'negative' })
  })

  it('round-trips through a URL', () => {
    expect(readFacets(new URLSearchParams(facetEntries(facets)))).toStrictEqual(facets)
  })

  it('keys a selection regardless of its order', () => {
    expect(facetsKey(facets)).toBe(facetsKey({ ...facets, sources: ['app', 'web'] }))
    expect(facetsKey(facets)).not.toBe(facetsKey(EMPTY_FACETS))
  })

  it('counts each set facet once', () => {
    expect(countActiveFacets(facets)).toBe(2)
    expect(hasActiveFacets(facets)).toBe(true)
    expect(hasActiveFacets(EMPTY_FACETS)).toBe(false)
  })
})

describe('helpers', () => {
  it('toggles a value in and out of a list', () => {
    expect(toggleFacetValue(['a'], 'b')).toStrictEqual(['a', 'b'])
    expect(toggleFacetValue(['a', 'b'], 'a')).toStrictEqual(['b'])
  })

  it('recognises only the stored bands as a band', () => {
    expect(isUsefulnessBand('high')).toBe(true)
    expect(isUsefulnessBand('unrated')).toBe(false)
    expect(isUsefulnessBand(undefined)).toBe(false)
  })
})
