import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom'
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
      const filters = useCategoryFilters()
      const [searchParams] = useSearchParams()
      return { filters, searchParams }
    },
    { wrapper: createWrapper(initialEntries) }
  )
}

describe('useCategoryFilters', () => {
  describe('URL param initialization (FeedbackDetail deep-links, issue #198)', () => {
    it('initializes search text from ?q=', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=slow+delivery'])
      expect(result.current.filters.searchText).toBe('slow delivery')
    })

    it('initializes source from ?source=', () => {
      const { result } = renderFiltersWithUrl(['/categories?source=webscraper'])
      expect(result.current.filters.selectedSource).toBe('webscraper')
    })

    it('initializes sentiment from ?sentiment=', () => {
      const { result } = renderFiltersWithUrl(['/categories?sentiment=negative'])
      expect(result.current.filters.sentimentFilter).toBe('negative')
    })

    it('falls back to "all" for an invalid sentiment value', () => {
      const { result } = renderFiltersWithUrl(['/categories?sentiment=bogus'])
      expect(result.current.filters.sentimentFilter).toBe('all')
    })

    it('initializes a single category from ?category= (deep-link selects one row)', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])
      expect(result.current.filters.selectedCategories).toStrictEqual(['delivery'])
    })

    it('initializes multiple categories from comma-separated ?category=', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery,pricing'])
      expect(result.current.filters.selectedCategories).toStrictEqual(['delivery', 'pricing'])
    })

    it('ignores the legacy ?all=1 param (browse-all is now the default state)', () => {
      const { result } = renderFiltersWithUrl(['/categories?all=1'])
      expect(result.current.filters.selectedCategories).toStrictEqual([])
      expect(result.current.searchParams.get('all')).toBeNull()
    })
  })

  describe('URL write-back', () => {
    it('mirrors filter changes to the URL', () => {
      const { result } = renderFiltersWithUrl()

      act(() => {
        result.current.filters.setSearchText('refund')
        result.current.filters.setSelectedSource('webscraper')
      })
      act(() => {
        result.current.filters.toggleCategory('delivery')
        result.current.filters.toggleCategory('pricing')
      })

      expect(result.current.searchParams.get('q')).toBe('refund')
      expect(result.current.searchParams.get('source')).toBe('webscraper')
      expect(result.current.searchParams.get('category')).toBe('delivery,pricing')
    })

    it('omits default values from the URL', () => {
      const { result } = renderFiltersWithUrl()
      expect([...result.current.searchParams.keys()]).toStrictEqual([])
    })
  })

  describe('external URL changes (back/forward, same-route navigation)', () => {
    /** Hook plus a navigate handle, so tests can simulate external navigations. */
    function renderFiltersWithNavigate(initialEntries = ['/categories']) {
      return renderHook(
        () => {
          const filters = useCategoryFilters()
          const [searchParams] = useSearchParams()
          const navigate = useNavigate()
          return { filters, searchParams, navigate }
        },
        { wrapper: createWrapper(initialEntries) }
      )
    }

    it('adopts filters from a same-route navigation with new params', () => {
      const { result } = renderFiltersWithNavigate(['/categories'])

      act(() => {
        void result.current.navigate('/categories?category=pricing&q=refund')
      })

      expect(result.current.filters.selectedCategories).toStrictEqual(['pricing'])
      expect(result.current.filters.searchText).toBe('refund')
    })

    it('clears filters when navigation removes the params', () => {
      const { result } = renderFiltersWithNavigate(['/categories?category=delivery&sentiment=negative'])

      act(() => {
        void result.current.navigate('/categories')
      })

      expect(result.current.filters.selectedCategories).toStrictEqual([])
      expect(result.current.filters.sentimentFilter).toBe('all')
    })

    it('restores filters on browser back navigation', () => {
      const { result } = renderFiltersWithNavigate(['/categories?category=delivery'])

      act(() => {
        void result.current.navigate('/categories?category=pricing')
      })
      expect(result.current.filters.selectedCategories).toStrictEqual(['pricing'])

      act(() => {
        void result.current.navigate(-1)
      })
      expect(result.current.filters.selectedCategories).toStrictEqual(['delivery'])
    })

    it('does not reset state from its own URL mirroring', () => {
      const { result } = renderFiltersWithNavigate(['/categories'])

      act(() => {
        result.current.filters.setSearchText('refund')
      })
      act(() => {
        result.current.filters.setShowUrgentOnly(true)
      })

      // Non-URL-synced state survives the mirroring write-back.
      expect(result.current.filters.searchText).toBe('refund')
      expect(result.current.filters.showUrgentOnly).toBe(true)
    })
  })

  describe('category toggling', () => {
    it('deselecting the last category returns to browse-all (empty selection)', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])

      act(() => {
        result.current.filters.toggleCategory('delivery')
      })

      expect(result.current.filters.selectedCategories).toStrictEqual([])
      expect(result.current.searchParams.get('category')).toBeNull()
    })

    it('supports multi-select', () => {
      const { result } = renderFiltersWithUrl()

      act(() => {
        result.current.filters.toggleCategory('delivery')
      })
      act(() => {
        result.current.filters.toggleCategory('pricing')
      })

      expect(result.current.filters.selectedCategories).toStrictEqual(['delivery', 'pricing'])
    })
  })

  describe('clearFilters', () => {
    it('resets every filter and empties the URL', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=x&source=s&sentiment=negative&category=a,b'])

      act(() => {
        result.current.filters.setShowUrgentOnly(true)
        result.current.filters.setRatingFilter({ value: 3, direction: 'below' })
      })
      act(() => {
        result.current.filters.clearFilters()
      })

      const { searchText, selectedCategories, selectedSource, sentimentFilter, ratingFilter, showUrgentOnly } = result.current.filters
      expect({ searchText, selectedCategories, selectedSource, sentimentFilter, ratingFilter, showUrgentOnly }).toStrictEqual({
        searchText: '',
        selectedCategories: [],
        selectedSource: null,
        sentimentFilter: 'all',
        ratingFilter: { value: 0, direction: 'up' },
        showUrgentOnly: false,
      })
      expect([...result.current.searchParams.keys()]).toStrictEqual([])
    })
  })

  describe('hasActiveFilters', () => {
    it('is false with default state (browse-all)', () => {
      const { result } = renderFiltersWithUrl()
      expect(result.current.filters.hasActiveFilters).toBe(false)
    })

    it('is true when the urgent toggle is on', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.filters.setShowUrgentOnly(true)
      })
      expect(result.current.filters.hasActiveFilters).toBe(true)
    })

    it('is true when a category is selected', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])
      expect(result.current.filters.hasActiveFilters).toBe(true)
    })

    it('is true when a rating threshold is set', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.filters.setRatingFilter({ value: 3, direction: 'below' })
      })
      expect(result.current.filters.hasActiveFilters).toBe(true)
    })

    it('stays false when only the rating direction changes (no threshold)', () => {
      const { result } = renderFiltersWithUrl()
      act(() => {
        result.current.filters.setRatingFilter({ value: 0, direction: 'below' })
      })
      expect(result.current.filters.hasActiveFilters).toBe(false)
    })
  })

  describe('channel / dimension / tag filters', () => {
    it('initializes from ?channel, ?dims and ?tag, skipping a malformed dims pair', () => {
      const { result } = renderFiltersWithUrl(['/categories?channel=review&dims=product:mobile_app,bad&tag=vip'])
      const { channel, dimensionFilter, tag, hasActiveFilters } = result.current.filters
      expect({ channel, dimensionFilter, tag, hasActiveFilters }).toStrictEqual({
        channel: 'review', dimensionFilter: { product: 'mobile_app' }, tag: 'vip', hasActiveFilters: true,
      })
    })

    it('mirrors them to the URL with dims sorted, and clears them', () => {
      const { result } = renderFiltersWithUrl()
      act(() => result.current.filters.setDimensionFilter({ product: 'web_shop', module: 'checkout' }))
      act(() => result.current.filters.setTag('vip'))
      expect(result.current.searchParams.toString()).toBe('dims=module%3Acheckout%2Cproduct%3Aweb_shop&tag=vip')
      act(() => result.current.filters.clearFilters())
      expect([...result.current.searchParams.keys()]).toStrictEqual([])
    })
  })
})

