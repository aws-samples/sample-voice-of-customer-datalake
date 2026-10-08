/**
 * @fileoverview Shared test support for the `src/pages/Categories` specs.
 *
 * Imports NO component from this directory: the module factories below are called
 * from hoisted `vi.mock(...)` blocks, and a module that both feeds those factories
 * and imports a consumer of the mocked module cannot finish evaluating. Specs must
 * import this file BEFORE the module under test.
 */
import { vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { FeedbackItem } from '../../api/types'

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

/**
 * A processed, positive `delivery` review scraped on 2026-01-01 — the one item
 * every list fixture in this directory starts from.
 */
export function feedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    feedback_id: '1',
    source_id: 's1',
    source_platform: 'webscraper',
    source_channel: 'review',
    original_text: 'Great delivery!',
    original_language: 'en',
    sentiment_label: 'positive',
    sentiment_score: 0.9,
    category: 'delivery',
    journey_stage: 'post_purchase',
    urgency: 'low',
    impact_area: 'delivery',
    source_created_at: '2026-01-01T10:00:00Z',
    processed_at: '2026-01-01T10:00:00Z',
    rating: 5,
    brand_name: 'test',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Module factories for `vi.mock`
// ---------------------------------------------------------------------------

/** A stub whose return is `unknown` so the module factory below is not "unsafe any". */
const apiStub = () => vi.fn<(...args: unknown[]) => unknown>()

/** One `vi.fn()` per `api.*` member the page, its analytics and its list hook call. */
export const categoriesApiMocks = {
  getCategories: apiStub(),
  getSentiment: apiStub(),
  getEntities: apiStub(),
  getFeedback: apiStub(),
  searchFeedback: apiStub(),
  getUrgentFeedback: apiStub(),
}

/** Module factory for `vi.mock('../../api/client', () => clientApiModule())`. */
export function clientApiModule() {
  return {
    api: {
      getCategories: (...args: unknown[]) => categoriesApiMocks.getCategories(...args),
      getSentiment: (...args: unknown[]) => categoriesApiMocks.getSentiment(...args),
      getEntities: (...args: unknown[]) => categoriesApiMocks.getEntities(...args),
      getFeedback: (...args: unknown[]) => categoriesApiMocks.getFeedback(...args),
      searchFeedback: (...args: unknown[]) => categoriesApiMocks.searchFeedback(...args),
      getUrgentFeedback: (...args: unknown[]) => categoriesApiMocks.getUrgentFeedback(...args),
    },
    getDateRangeParams: () => ({ days: 7 }),
  }
}

/** Module factory for `vi.mock('../../store/configStore', () => configStoreModule())`. */
export function configStoreModule() {
  return {
    useConfigStore: () => ({
      timeRange: '7d',
      config: { apiEndpoint: 'https://api.example.com' },
    }),
  }
}

/**
 * Module factory for `vi.mock('recharts', () => rechartsStubModule())`: the chart
 * primitives the sentiment gauge renders, reduced to pass-through containers so
 * jsdom never measures an SVG.
 */
export function rechartsStubModule() {
  const passThrough = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passThrough,
    PieChart: passThrough,
    Pie: () => null,
    Cell: () => null,
    Tooltip: () => null,
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * A render `wrapper` providing a fresh, retry-free QueryClient, inside a
 * MemoryRouter when `initialEntries` is given. Also used by the Problem
 * Analysis and Scrapers specs (one copy instead of three).
 */
export function createQueryWrapper(initialEntries?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <QueryClientProvider client={queryClient}>
      {initialEntries ? <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter> : children}
    </QueryClientProvider>
  )
  return Wrapper
}
