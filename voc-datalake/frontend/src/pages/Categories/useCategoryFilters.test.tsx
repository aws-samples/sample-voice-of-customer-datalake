import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom'
import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import { restorePages, useFeedbackFilterStore } from '../../store/feedbackFilterStore'
import { useCategoryFilters } from './useCategoryFilters'

function createWrapper(initialEntries = ['/categories']) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  )
}

/** Renders the hook together with a URL observer so tests can assert the synced params. */
function renderFiltersWithUrl(initialEntries = ['/categories']) {
  return renderHook(
    () => {
      const api = useCategoryFilters()
      const [searchParams] = useSearchParams()
      return { api, searchParams }
    },
    { wrapper: createWrapper(initialEntries) }
  )
}

/** Hook plus a navigate handle, so tests can simulate external navigations. */
function renderFiltersWithNavigate(initialEntries = ['/categories']) {
  return renderHook(
    () => {
      const api = useCategoryFilters()
      const [searchParams] = useSearchParams()
      const navigate = useNavigate()
      return { api, searchParams, navigate }
    },
    { wrapper: createWrapper(initialEntries) }
  )
}

beforeEach(() => {
  useFeedbackFilterStore.setState({ pages: restorePages({}) })
})

describe('useCategoryFilters', () => {
  describe('URL param initialization (FeedbackDetail deep-links, issue #198)', () => {
    it('initializes search text from ?q=', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=slow+delivery'])
      expect(result.current.api.searchText).toBe('slow delivery')
    })

    it('initializes sources from ?source=', () => {
      const { result } = renderFiltersWithUrl(['/categories?source=webscraper,manual_import'])
      expect(result.current.api.filters.sources).toEqual(['webscraper', 'manual_import'])
    })

    it('initializes sentiment from ?sentiment=', () => {
      const { result } = renderFiltersWithUrl(['/categories?sentiment=negative'])
      expect(result.current.api.filters.sentiments).toEqual(['negative'])
    })

    it('drops an invalid sentiment value', () => {
      const { result } = renderFiltersWithUrl(['/categories?sentiment=bogus'])
      expect(result.current.api.filters.sentiments).toEqual([])
    })

    it('initializes a single category from ?category= (deep-link selects one row)', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])
      expect(result.current.api.filters.categories).toEqual(['delivery'])
    })

    it('initializes multiple categories from comma-separated ?category=', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery,pricing'])
      expect(result.current.api.filters.categories).toEqual(['delivery', 'pricing'])
    })

    it('initializes urgency and enrichment filters from the URL', () => {
      const { result } = renderFiltersWithUrl(['/categories?urgent=true&usefulness=high,unscored'])
      expect(result.current.api.filters.urgentOnly).toBe(true)
      expect(result.current.api.filters.enrichment).toEqual({ usefulness: ['high', 'unscored'] })
    })

    it('ignores the legacy ?all=1 param (browse-all is now the default state)', () => {
      const { result } = renderFiltersWithUrl(['/categories?all=1'])
      expect(result.current.api.filters.categories).toEqual([])
      expect(result.current.searchParams.get('all')).toBeNull()
    })
  })

  describe('per-page persistence', () => {
    it('restores the remembered filters on a bare /categories and writes them to the URL', () => {
      useFeedbackFilterStore.getState().setPageFilters('categories', {
        ...EMPTY_FEEDBACK_FILTERS,
        categories: ['delivery'],
      })

      const { result } = renderFiltersWithUrl(['/categories'])

      expect(result.current.api.filters.categories).toEqual(['delivery'])
      expect(result.current.searchParams.get('category')).toBe('delivery')
    })

    it('lets a deep link win over the remembered filters', () => {
      useFeedbackFilterStore.getState().setPageFilters('categories', {
        ...EMPTY_FEEDBACK_FILTERS,
        categories: ['delivery'],
      })

      const { result } = renderFiltersWithUrl(['/categories?category=pricing'])

      expect(result.current.api.filters.categories).toEqual(['pricing'])
      expect(useFeedbackFilterStore.getState().pages.categories.categories).toEqual(['pricing'])
    })

    it('leaves the other pages\u2019 filters untouched', () => {
      useFeedbackFilterStore.getState().setPageFilters('dashboard', {
        ...EMPTY_FEEDBACK_FILTERS,
        sources: ['webscraper'],
      })

      const { result } = renderFiltersWithUrl(['/categories'])
      act(() => {
        result.current.api.toggleCategory('delivery')
      })

      expect(useFeedbackFilterStore.getState().pages.dashboard.sources).toEqual(['webscraper'])
      expect(useFeedbackFilterStore.getState().pages.dashboard.categories).toEqual([])
    })
  })

  describe('URL write-back', () => {
    it('mirrors filter changes to the URL', () => {
      const { result } = renderFiltersWithUrl()

      act(() => {
        result.current.api.setSearchText('refund')
        result.current.api.setFilters({ ...EMPTY_FEEDBACK_FILTERS, sources: ['webscraper'] })
      })
      act(() => {
        result.current.api.toggleCategory('delivery')
      })
      act(() => {
        result.current.api.toggleCategory('pricing')
      })

      expect(result.current.searchParams.get('q')).toBe('refund')
      expect(result.current.searchParams.get('source')).toBe('webscraper')
      expect(result.current.searchParams.get('category')).toBe('delivery,pricing')
    })

    it('omits default values from the URL', () => {
      const { result } = renderFiltersWithUrl()
      expect([...result.current.searchParams.keys()]).toEqual([])
    })

    it('keeps the rating filter out of the URL', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.api.setRatingFilter({ value: 3, direction: 'below' })
      })
      expect([...result.current.searchParams.keys()]).toEqual([])
    })
  })

  describe('external URL changes (back/forward, same-route navigation)', () => {
    it('adopts filters from a same-route navigation with new params', () => {
      const { result } = renderFiltersWithNavigate(['/categories'])

      act(() => {
        result.current.navigate('/categories?category=pricing&q=refund')
      })

      expect(result.current.api.filters.categories).toEqual(['pricing'])
      expect(result.current.api.searchText).toBe('refund')
    })

    it('clears filters when navigation removes the params', () => {
      const { result } = renderFiltersWithNavigate(['/categories?category=delivery&sentiment=negative'])

      act(() => {
        result.current.navigate('/categories')
      })

      expect(result.current.api.filters.categories).toEqual([])
      expect(result.current.api.filters.sentiments).toEqual([])
    })

    it('restores filters on browser back navigation', () => {
      const { result } = renderFiltersWithNavigate(['/categories?category=delivery'])

      act(() => {
        result.current.navigate('/categories?category=pricing')
      })
      expect(result.current.api.filters.categories).toEqual(['pricing'])

      act(() => {
        result.current.navigate(-1)
      })
      expect(result.current.api.filters.categories).toEqual(['delivery'])
    })

    it('does not reset state from its own URL mirroring', () => {
      const { result } = renderFiltersWithNavigate(['/categories'])

      act(() => {
        result.current.api.setSearchText('refund')
      })
      act(() => {
        result.current.api.setRatingFilter({ value: 4, direction: 'up' })
      })

      // Page-local state survives the mirroring write-back.
      expect(result.current.api.searchText).toBe('refund')
      expect(result.current.api.ratingFilter).toEqual({ value: 4, direction: 'up' })
    })
  })

  describe('category and sentiment toggling', () => {
    it('deselecting the last category returns to browse-all (empty selection)', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])

      act(() => {
        result.current.api.toggleCategory('delivery')
      })

      expect(result.current.api.filters.categories).toEqual([])
      expect(result.current.searchParams.get('category')).toBeNull()
    })

    it('supports multi-select', () => {
      const { result } = renderFiltersWithUrl()

      act(() => {
        result.current.api.toggleCategory('delivery')
      })
      act(() => {
        result.current.api.toggleCategory('pricing')
      })

      expect(result.current.api.filters.categories).toEqual(['delivery', 'pricing'])
    })

    it('toggles sentiments independently of categories', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])

      act(() => {
        result.current.api.toggleSentiment('negative')
      })

      expect(result.current.api.filters.sentiments).toEqual(['negative'])
      expect(result.current.api.filters.categories).toEqual(['delivery'])
      expect(result.current.searchParams.get('sentiment')).toBe('negative')
    })
  })

  describe('clearFilters', () => {
    it('resets every filter and empties the URL', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=x&source=s&sentiment=negative&category=a,b&urgent=true'])

      act(() => {
        result.current.api.setRatingFilter({ value: 3, direction: 'below' })
      })
      act(() => {
        result.current.api.clearFilters()
      })

      expect(result.current.api.searchText).toBe('')
      expect(result.current.api.filters).toEqual(EMPTY_FEEDBACK_FILTERS)
      expect(result.current.api.ratingFilter).toEqual({ value: 0, direction: 'up' })
      expect([...result.current.searchParams.keys()]).toEqual([])
    })
  })

  describe('hasActiveFilters', () => {
    it('is false with default state (browse-all)', () => {
      const { result } = renderFiltersWithUrl()
      expect(result.current.api.hasActiveFilters).toBe(false)
    })

    it('is true when urgent-only is set', () => {
      const { result } = renderFiltersWithUrl(['/categories?urgent=true'])
      expect(result.current.api.hasActiveFilters).toBe(true)
    })

    it('is true when a category is selected', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])
      expect(result.current.api.hasActiveFilters).toBe(true)
    })

    it('is true when only search text is set', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=refund'])
      expect(result.current.api.hasActiveFilters).toBe(true)
    })

    it('is true when a rating threshold is set', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.api.setRatingFilter({ value: 3, direction: 'below' })
      })
      expect(result.current.api.hasActiveFilters).toBe(true)
    })

    it('stays false when only the rating direction changes (no threshold)', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.api.setRatingFilter({ value: 0, direction: 'below' })
      })
      expect(result.current.api.hasActiveFilters).toBe(false)
    })

    it('is true when a custom filter is selected', () => {
      const { result } = renderFiltersWithUrl(['/categories?cf_region=EMEA'])
      expect(result.current.api.hasActiveFilters).toBe(true)
    })
  })

  describe('custom-field filters (Phase 4d)', () => {
    it('initializes customFields from cf_<key>= params', () => {
      const { result } = renderFiltersWithUrl(['/categories?cf_region=EMEA&cf_plan=pro'])
      expect(result.current.api.filters.customFields).toEqual({ region: ['EMEA'], plan: ['pro'] })
    })

    it('reads a repeated cf_<key> as a multi-select', () => {
      const { result } = renderFiltersWithUrl(['/categories?cf_tier=Gold&cf_tier=Platinum'])
      expect(result.current.api.filters.customFields).toEqual({ tier: ['Gold', 'Platinum'] })
    })

    it('ignores a bare cf_ param with an empty value', () => {
      const { result } = renderFiltersWithUrl(['/categories?cf_region='])
      expect(result.current.api.filters.customFields).toEqual({})
    })

    it('mirrors a multi-select custom filter to the URL as a repeated key', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.api.setFilters({ ...EMPTY_FEEDBACK_FILTERS, customFields: { city: ['Reno', 'Las Vegas, NV'] } })
      })
      // Never comma-joined: "Las Vegas, NV" is one value.
      expect(result.current.searchParams.getAll('cf_city')).toEqual(['Reno', 'Las Vegas, NV'])
      expect(result.current.api.filters.customFields).toEqual({ city: ['Reno', 'Las Vegas, NV'] })
    })

    it('clearFilters removes custom filters too', () => {
      const { result } = renderFiltersWithUrl(['/categories?cf_region=EMEA&cf_plan=pro'])
      act(() => {
        result.current.api.clearFilters()
      })
      expect(result.current.api.filters.customFields).toEqual({})
      expect([...result.current.searchParams.keys()]).toEqual([])
    })

    it('adopts custom filters from an external navigation', () => {
      const { result } = renderFiltersWithNavigate(['/categories'])
      act(() => {
        result.current.navigate('/categories?cf_tier=gold')
      })
      expect(result.current.api.filters.customFields).toEqual({ tier: ['gold'] })
    })
  })
})
