import { describe, it, expect } from 'vitest'
import { ENRICHMENT_FIELDS, UNSCORED, enrichmentFilterOptions, pickEnrichmentValues } from './enrichmentFields'

// The field list itself is pinned against the Python registry by
// lambda/shared/test/test_enrichment_fields.py; these tests cover behaviour.

describe('enrichmentFilterOptions', () => {
  it('lists the declared values, in order, then the unscored bucket', () => {
    for (const field of ENRICHMENT_FIELDS) {
      expect(enrichmentFilterOptions(field)).toEqual([...field.values, UNSCORED])
    }
  })
})

describe('pickEnrichmentValues', () => {
  it('keeps a declared value', () => {
    expect(pickEnrichmentValues({ usefulness: 'high', original_text: 'x' })).toEqual({ usefulness: 'high' })
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(pickEnrichmentValues({ usefulness: ' Medium ' })).toEqual({ usefulness: 'medium' })
  })

  it('omits out-of-enum, non-string and missing values (they read as unscored)', () => {
    for (const raw of [{ usefulness: 'very high' }, { usefulness: 3 }, { usefulness: null }, {}]) {
      expect(pickEnrichmentValues(raw)).toEqual({})
    }
  })

  it('does not accept "unscored" as a stored value', () => {
    expect(pickEnrichmentValues({ usefulness: UNSCORED })).toEqual({})
  })

  it('ignores fields outside the registry', () => {
    expect(pickEnrichmentValues({ invented_field: 'high' })).toEqual({})
  })

  it('returns an empty map for non-object input', () => {
    for (const raw of [null, undefined, 'high', 7, ['high']]) {
      expect(pickEnrichmentValues(raw)).toEqual({})
    }
  })
})
