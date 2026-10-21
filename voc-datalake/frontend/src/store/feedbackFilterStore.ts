/**
 * Per-page feedback filters, remembered across navigation and reloads.
 *
 * Each page keeps its OWN selection (Dashboard, Categories and Problem Analysis
 * answer different questions), but all three use one shape and one panel. The
 * persisted copy is validated on load, so a corrupt or older localStorage value
 * degrades to "no filters" instead of crashing a page.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { z } from 'zod'
import { EMPTY_FEEDBACK_FILTERS, normalizeFeedbackFilters } from '../api/feedbackFilters'
import type { FeedbackFilterState } from '../api/feedbackFilters'

export const FILTER_PAGES = ['dashboard', 'categories', 'problemAnalysis'] as const
export type FilterPage = (typeof FILTER_PAGES)[number]

type PageFilters = Record<FilterPage, FeedbackFilterState>

interface FeedbackFilterStore {
  pages: PageFilters
  setPageFilters: (page: FilterPage, next: FeedbackFilterState) => void
  updatePageFilters: (page: FilterPage, patch: Partial<FeedbackFilterState>) => void
  clearPageFilters: (page: FilterPage) => void
}

function emptyPages(): PageFilters {
  return { dashboard: EMPTY_FEEDBACK_FILTERS, categories: EMPTY_FEEDBACK_FILTERS, problemAnalysis: EMPTY_FEEDBACK_FILTERS }
}

const PersistedSchema = z.object({ pages: z.record(z.string(), z.unknown()).catch({}) }).catch({ pages: {} })

/** Rebuild every page slot from untrusted persisted state. */
export function restorePages(persisted: unknown): PageFilters {
  const { pages } = PersistedSchema.parse(persisted ?? {})
  const restored = emptyPages()
  for (const page of FILTER_PAGES) {
    restored[page] = normalizeFeedbackFilters(pages[page])
  }
  return restored
}

export const useFeedbackFilterStore = create<FeedbackFilterStore>()(
  persist(
    (set) => ({
      pages: emptyPages(),
      setPageFilters: (page, next) => set((state) => ({ pages: { ...state.pages, [page]: next } })),
      updatePageFilters: (page, patch) =>
        set((state) => ({ pages: { ...state.pages, [page]: { ...state.pages[page], ...patch } } })),
      clearPageFilters: (page) => set((state) => ({ pages: { ...state.pages, [page]: EMPTY_FEEDBACK_FILTERS } })),
    }),
    {
      name: 'voc-feedback-filters',
      version: 1,
      partialize: (state) => ({ pages: state.pages }),
      merge: (persisted, current) => ({ ...current, pages: restorePages(persisted) }),
    },
  ),
)

export interface PageFiltersApi {
  readonly filters: FeedbackFilterState
  readonly setFilters: (next: FeedbackFilterState) => void
  readonly updateFilters: (patch: Partial<FeedbackFilterState>) => void
  readonly clearFilters: () => void
}

/** One page's filters and its setters. */
export function usePageFilters(page: FilterPage): PageFiltersApi {
  const filters = useFeedbackFilterStore((state) => state.pages[page])
  const setPageFilters = useFeedbackFilterStore((state) => state.setPageFilters)
  const updatePageFilters = useFeedbackFilterStore((state) => state.updatePageFilters)
  const clearPageFilters = useFeedbackFilterStore((state) => state.clearPageFilters)
  return {
    filters,
    setFilters: (next) => setPageFilters(page, next),
    updateFilters: (patch) => updatePageFilters(page, patch),
    clearFilters: () => clearPageFilters(page),
  }
}
