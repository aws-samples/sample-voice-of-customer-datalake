import { describe, it, expect } from 'vitest'
import {
  EMPTY_FEEDBACK_FILTERS,
  countActiveFilters,
  feedbackFiltersFromSearchParams,
  filteredSearchParams,
  filtersKey,
  hasActiveFilters,
  isFilterParam,
  normalizeFeedbackFilters,
  toFeedbackQueryParams,
  toggleValue,
} from './feedbackFilters'
import type { FeedbackFilterState } from './feedbackFilters'

function state(patch: Partial<FeedbackFilterState>): FeedbackFilterState {
  return { ...EMPTY_FEEDBACK_FILTERS, ...patch }
}

const FULL = state({
  sources: ['webscraper', 'manual_import'],
  categories: ['delivery'],
  subcategories: ['late'],
  sentiments: ['negative', 'mixed'],
  urgentOnly: true,
  enrichment: { usefulness: ['high', 'unscored'] },
  // A comma inside a value is data, so it must never be split.
  customFields: { region: ['EMEA', 'Las Vegas, NV'] },
})

describe('normalizeFeedbackFilters', () => {
  it('returns the empty state for null, undefined and non-objects', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(normalizeFeedbackFilters(raw)).toEqual(EMPTY_FEEDBACK_FILTERS)
    }
  })

  it('keeps a well-formed state unchanged', () => {
    expect(normalizeFeedbackFilters(FULL)).toEqual(FULL)
  })

  it('degrades each malformed part to "no filter" independently', () => {
    const result = normalizeFeedbackFilters({
      sources: 'webscraper',
      categories: ['delivery'],
      urgentOnly: 'yes',
      customFields: { region: 7 },
    })
    expect(result).toEqual(state({ categories: ['delivery'] }))
  })

  it('drops enrichment fields and values the registry does not declare', () => {
    const result = normalizeFeedbackFilters({
      enrichment: { usefulness: ['high', 'bogus', 'unscored'], invented_field: ['x'] },
    })
    expect(result.enrichment).toEqual({ usefulness: ['high', 'unscored'] })
  })

  it('omits an enrichment field left with no valid values', () => {
    expect(normalizeFeedbackFilters({ enrichment: { usefulness: ['bogus'] } }).enrichment).toEqual({})
  })

  it('upgrades a persisted single-value custom field to a one-value list', () => {
    // The pre-multi-select shape, still sitting in some browsers' localStorage.
    expect(normalizeFeedbackFilters({ customFields: { tier: 'Gold' } }).customFields).toEqual({ tier: ['Gold'] })
  })

  it('drops empty custom values, duplicates, and keys left with none', () => {
    const result = normalizeFeedbackFilters({ customFields: { tier: ['Gold', '', 'Gold'], region: [''], plan: '' } })
    expect(result.customFields).toEqual({ tier: ['Gold'] })
  })
})

describe('toggleValue', () => {
  it('adds a missing value and removes a present one', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('countActiveFilters / hasActiveFilters', () => {
  it('counts nothing for the empty state', () => {
    expect(countActiveFilters(EMPTY_FEEDBACK_FILTERS)).toBe(0)
    expect(hasActiveFilters(EMPTY_FEEDBACK_FILTERS)).toBe(false)
  })

  it('counts a multi-select dimension once', () => {
    expect(countActiveFilters(state({ sources: ['a', 'b', 'c'] }))).toBe(1)
  })

  it('counts every dimension, enrichment field and custom key', () => {
    // sources, categories, subcategories, sentiments, urgent, usefulness, cf_region
    expect(countActiveFilters(FULL)).toBe(7)
    expect(hasActiveFilters(FULL)).toBe(true)
  })

  it('ignores empty enrichment lists and empty custom selections', () => {
    expect(countActiveFilters(state({ enrichment: { usefulness: [] }, customFields: { region: [] } }))).toBe(0)
  })

  it('counts a multi-select custom field once', () => {
    expect(countActiveFilters(state({ customFields: { tier: ['Gold', 'Platinum'] } }))).toBe(1)
  })
})

describe('toFeedbackQueryParams', () => {
  it('omits every empty dimension', () => {
    expect(toFeedbackQueryParams(EMPTY_FEEDBACK_FILTERS)).toEqual({})
  })

  it('encodes every dimension with the API wire keys', () => {
    expect(toFeedbackQueryParams(FULL)).toEqual({
      source: 'webscraper,manual_import',
      category: 'delivery',
      subcategory: 'late',
      sentiment: 'negative,mixed',
      urgent: 'true',
      usefulness: 'high,unscored',
      // A list, never comma-joined: sent as a repeated key.
      cf_region: ['EMEA', 'Las Vegas, NV'],
    })
  })
})

describe('feedbackFiltersFromSearchParams', () => {
  it('round-trips the query params, including a repeated custom field with a comma in a value', () => {
    const params = filteredSearchParams({}, FULL)
    expect(params.getAll('cf_region')).toEqual(['EMEA', 'Las Vegas, NV'])
    expect(feedbackFiltersFromSearchParams(params)).toEqual(FULL)
  })

  it('reads a single cf_ param (an old deep link) as a one-value selection', () => {
    expect(feedbackFiltersFromSearchParams(new URLSearchParams('cf_tier=Gold')).customFields).toEqual({ tier: ['Gold'] })
  })

  it('trims entries and skips empty ones in a comma list', () => {
    const params = new URLSearchParams('source= a ,,b&category=')
    const result = feedbackFiltersFromSearchParams(params)
    expect(result.sources).toEqual(['a', 'b'])
    expect(result.categories).toEqual([])
  })

  it('keeps only known sentiments and treats any urgent value but "true" as off', () => {
    const result = feedbackFiltersFromSearchParams(new URLSearchParams('sentiment=negative,angry&urgent=1'))
    expect(result.sentiments).toEqual(['negative'])
    expect(result.urgentOnly).toBe(false)
  })

  it('ignores a bare cf_ key and empty custom values', () => {
    const result = feedbackFiltersFromSearchParams(new URLSearchParams('cf_=x&cf_region=&cf_tier=gold'))
    expect(result.customFields).toEqual({ tier: ['gold'] })
  })

  it('ignores unrelated params', () => {
    expect(feedbackFiltersFromSearchParams(new URLSearchParams('q=refund&days=7'))).toEqual(EMPTY_FEEDBACK_FILTERS)
  })
})

describe('isFilterParam', () => {
  it('claims exactly the keys the filter model owns', () => {
    for (const key of ['source', 'category', 'subcategory', 'sentiment', 'urgent', 'usefulness', 'cf_region']) {
      expect(isFilterParam(key)).toBe(true)
    }
    for (const key of ['q', 'days', 'limit', 'offset', 'all']) {
      expect(isFilterParam(key)).toBe(false)
    }
  })
})

describe('filteredSearchParams', () => {
  it('drops null/undefined plain params and appends the filters', () => {
    const search = filteredSearchParams({ days: 7, source: undefined, date_basis: null }, state({ sources: ['a'] }))
    expect(search.toString()).toBe('days=7&source=a')
  })

  it('lets the filters override a same-named plain param', () => {
    const search = filteredSearchParams({ category: 'stale' }, state({ categories: ['fresh'] }))
    expect(search.get('category')).toBe('fresh')
  })

  it('repeats a multi-select custom field key once per value', () => {
    const search = filteredSearchParams({ days: 7 }, state({ customFields: { tier: ['Gold', 'Platinum'] } }))
    expect(search.toString()).toBe('days=7&cf_tier=Gold&cf_tier=Platinum')
  })
})

describe('filtersKey', () => {
  it('ignores selection order', () => {
    const a = state({ sources: ['b', 'a'], sentiments: ['negative', 'mixed'] })
    const b = state({ sentiments: ['mixed', 'negative'], sources: ['a', 'b'] })
    expect(filtersKey(a)).toBe(filtersKey(b))
  })

  it('differs when the selection differs', () => {
    expect(filtersKey(state({ sources: ['a'] }))).not.toBe(filtersKey(state({ sources: ['b'] })))
    expect(filtersKey(state({ sources: ['a'] }))).not.toBe(filtersKey(state({ categories: ['a'] })))
  })

  it('ignores custom-field value order but not a value containing a comma', () => {
    const a = state({ customFields: { tier: ['Platinum', 'Gold'] } })
    const b = state({ customFields: { tier: ['Gold', 'Platinum'] } })
    expect(filtersKey(a)).toBe(filtersKey(b))
    // ['a, b'] is one value; ['a', 'b'] is two. They must not share a cache entry.
    expect(filtersKey(state({ customFields: { c: ['a, b'] } })))
      .not.toBe(filtersKey(state({ customFields: { c: ['a', ' b'] } })))
  })
})
