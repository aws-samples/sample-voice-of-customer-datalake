import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useSearchParams } from 'react-router-dom'
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
      expect(result.current.filters.selectedCategories).toEqual(['delivery'])
    })

    it('initializes multiple categories from comma-separated ?category=', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery,pricing'])
      expect(result.current.filters.selectedCategories).toEqual(['delivery', 'pricing'])
    })

    it('ignores the legacy ?all=1 param (browse-all is now the default state)', () => {
      const { result } = renderFiltersWithUrl(['/categories?all=1'])
      expect(result.current.filters.selectedCategories).toEqual([])
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
      expect([...result.current.searchParams.keys()]).toEqual([])
    })
  })

  describe('category toggling', () => {
    it('deselecting the last category returns to browse-all (empty selection)', () => {
      const { result } = renderFiltersWithUrl(['/categories?category=delivery'])

      act(() => {
        result.current.filters.toggleCategory('delivery')
      })

      expect(result.current.filters.selectedCategories).toEqual([])
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

      expect(result.current.filters.selectedCategories).toEqual(['delivery', 'pricing'])
    })
  })

  describe('clearFilters', () => {
    it('resets every filter and empties the URL', () => {
      const { result } = renderFiltersWithUrl(['/categories?q=x&source=s&sentiment=negative&category=a,b'])

      act(() => {
        result.current.filters.setShowUrgentOnly(true)
        result.current.filters.setMinRating(3)
      })
      act(() => {
        result.current.filters.clearFilters()
      })

      expect(result.current.filters.searchText).toBe('')
      expect(result.current.filters.selectedCategories).toEqual([])
      expect(result.current.filters.selectedSource).toBeNull()
      expect(result.current.filters.sentimentFilter).toBe('all')
      expect(result.current.filters.minRating).toBe(0)
      expect(result.current.filters.showUrgentOnly).toBe(false)
      expect([...result.current.searchParams.keys()]).toEqual([])
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
  })
})
