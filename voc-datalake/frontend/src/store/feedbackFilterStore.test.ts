import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { EMPTY_FEEDBACK_FILTERS } from '../api/feedbackFilters'
import { FILTER_PAGES, restorePages, useFeedbackFilterStore, usePageFilters } from './feedbackFilterStore'

const DELIVERY = { ...EMPTY_FEEDBACK_FILTERS, categories: ['delivery'] }

beforeEach(() => {
  useFeedbackFilterStore.setState({ pages: restorePages({}) })
})

describe('restorePages', () => {
  it('gives every page an empty slot for missing or garbage persisted state', () => {
    for (const persisted of [undefined, null, 'x', { pages: 'nope' }, { pages: [] }]) {
      const pages = restorePages(persisted)
      for (const page of FILTER_PAGES) {
        expect(pages[page]).toEqual(EMPTY_FEEDBACK_FILTERS)
      }
    }
  })

  it('restores valid slots and repairs malformed ones independently', () => {
    const pages = restorePages({
      pages: {
        dashboard: DELIVERY,
        categories: { sources: 'webscraper', urgentOnly: true },
        unknownPage: DELIVERY,
      },
    })
    expect(pages.dashboard).toEqual(DELIVERY)
    expect(pages.categories).toEqual({ ...EMPTY_FEEDBACK_FILTERS, urgentOnly: true })
    expect(pages.problemAnalysis).toEqual(EMPTY_FEEDBACK_FILTERS)
    expect(Object.keys(pages).sort()).toEqual([...FILTER_PAGES].sort())
  })
})

describe('useFeedbackFilterStore', () => {
  it('keeps each page independent', () => {
    useFeedbackFilterStore.getState().setPageFilters('dashboard', DELIVERY)

    const { pages } = useFeedbackFilterStore.getState()
    expect(pages.dashboard).toEqual(DELIVERY)
    expect(pages.categories).toEqual(EMPTY_FEEDBACK_FILTERS)
    expect(pages.problemAnalysis).toEqual(EMPTY_FEEDBACK_FILTERS)
  })

  it('merges a patch into one page and clears one page', () => {
    const store = useFeedbackFilterStore.getState()
    store.setPageFilters('categories', DELIVERY)
    store.updatePageFilters('categories', { urgentOnly: true })
    expect(useFeedbackFilterStore.getState().pages.categories).toEqual({ ...DELIVERY, urgentOnly: true })

    store.setPageFilters('dashboard', DELIVERY)
    store.clearPageFilters('categories')
    expect(useFeedbackFilterStore.getState().pages.categories).toEqual(EMPTY_FEEDBACK_FILTERS)
    expect(useFeedbackFilterStore.getState().pages.dashboard).toEqual(DELIVERY)
  })

  it('persists only the page slots under its storage key', () => {
    useFeedbackFilterStore.getState().setPageFilters('problemAnalysis', DELIVERY)

    // The suite's localStorage is a spy that stores nothing (test/setup.ts), so
    // inspect what persist WROTE rather than reading it back.
    const writes = vi.mocked(localStorage.setItem).mock.calls.filter(([key]) => key === 'voc-feedback-filters')
    expect(writes.length).toBeGreaterThan(0)
    const persisted: unknown = JSON.parse(writes[writes.length - 1][1])
    expect(persisted).toEqual({
      state: { pages: expect.objectContaining({ problemAnalysis: DELIVERY }) },
      version: 1,
    })
  })

  it('upgrades a remembered single-value custom filter to the multi-select shape on reload', async () => {
    // What a browser saved before custom fields became multi-select.
    vi.mocked(localStorage.getItem).mockReturnValueOnce(JSON.stringify({
      state: { pages: { categories: { ...EMPTY_FEEDBACK_FILTERS, customFields: { tier: 'Gold' } } } },
      version: 1,
    }))

    await useFeedbackFilterStore.persist.rehydrate()

    expect(useFeedbackFilterStore.getState().pages.categories.customFields).toEqual({ tier: ['Gold'] })
  })

  it('rehydrates through the validating merge, so a corrupt slot cannot crash a page', async () => {
    vi.mocked(localStorage.getItem).mockReturnValueOnce(JSON.stringify({
      state: { pages: { dashboard: DELIVERY, categories: { sources: 42 } } },
      version: 1,
    }))

    await useFeedbackFilterStore.persist.rehydrate()

    const { pages } = useFeedbackFilterStore.getState()
    expect(pages.dashboard).toEqual(DELIVERY)
    expect(pages.categories).toEqual(EMPTY_FEEDBACK_FILTERS)
    expect(pages.problemAnalysis).toEqual(EMPTY_FEEDBACK_FILTERS)
  })
})

describe('usePageFilters', () => {
  it('reads and writes only its own page', () => {
    const { result } = renderHook(() => usePageFilters('dashboard'))

    act(() => result.current.setFilters(DELIVERY))
    expect(result.current.filters).toEqual(DELIVERY)

    act(() => result.current.updateFilters({ sentiments: ['negative'] }))
    expect(result.current.filters).toEqual({ ...DELIVERY, sentiments: ['negative'] })
    expect(useFeedbackFilterStore.getState().pages.categories).toEqual(EMPTY_FEEDBACK_FILTERS)

    act(() => result.current.clearFilters())
    expect(result.current.filters).toEqual(EMPTY_FEEDBACK_FILTERS)
  })
})
