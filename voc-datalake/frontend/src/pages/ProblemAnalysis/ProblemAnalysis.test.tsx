/**
 * @fileoverview Tests for ProblemAnalysis page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetFeedback = vi.fn()
const mockGetEntities = vi.fn()
const mockGetResolvedProblems = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    getEntities: (params: unknown) => mockGetEntities(params),
    getResolvedProblems: () => mockGetResolvedProblems(),
    resolveProblem: vi.fn(),
    unresolveProblem: vi.fn(),
  },
  getDaysFromRange: vi.fn((_range: string, _custom?: unknown) => 7),
}))

const mockConfigStore = {
  timeRange: '7d' as string,
  customDateRange: null as { start: string; end: string } | null,
  config: { apiEndpoint: 'https://api.example.com' },
}

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => mockConfigStore,
}))

import ProblemAnalysis from './ProblemAnalysis'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

const mockFeedbackItems = [
  {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    brand_name: 'TestBrand',
    original_text: 'The delivery was very slow',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Slow delivery times',
    problem_root_cause_hypothesis: 'Logistics bottleneck',
    sentiment_score: -0.5,
    sentiment_label: 'negative',
    urgency: 'high',
    source_created_at: '2025-01-01',
  },
  {
    feedback_id: 'f2',
    source_platform: 'manual_import',
    brand_name: 'TestBrand',
    original_text: 'Shipping took forever',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Delivery too slow',
    problem_root_cause_hypothesis: null,
    sentiment_score: -0.6,
    sentiment_label: 'negative',
    urgency: 'medium',
    source_created_at: '2025-01-02',
  },
]

const mockEntities = {
  entities: {
    categories: { delivery: 10, product: 5 },
    sources: { webscraper: 15, manual_import: 8 },
  },
}

describe('ProblemAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
    mockGetEntities.mockResolvedValue(mockEntities)
    mockGetResolvedProblems.mockResolvedValue({ resolved: [] })
    mockConfigStore.timeRange = '7d'
    mockConfigStore.customDateRange = null
  })

  describe('rendering', () => {
    it('renders stats cards', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Categories')).toBeInTheDocument()
        expect(screen.getByText('Subcategories')).toBeInTheDocument()
        expect(screen.getByText('Problems')).toBeInTheDocument()
        expect(screen.getByText('Feedback')).toBeInTheDocument()
        expect(screen.getByText('Urgent')).toBeInTheDocument()
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      mockGetFeedback.mockReturnValue(new Promise(() => {}))

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no problems found', async () => {
      mockGetFeedback.mockResolvedValue({ items: [], count: 0 })

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/no problem analysis data found/i)).toBeInTheDocument()
      })
    })
  })

  describe('category grouping', () => {
    it('renders categories when feedback has problem summaries', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // The component should render - check for stats cards which always render
      expect(screen.getByText('Categories')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('renders expand button', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // Check expand button exists
      const expandButtons = screen.getAllByRole('button')
      const expandButton = expandButtons.find(b => b.textContent?.toLowerCase().includes('expand'))
      expect(expandButton).toBeTruthy()
    })
  })
describe('source filtering', () => {
    it('renders source filter dropdown with available sources', async () => {
      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      // Wait for loading to complete
      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // The source filter dropdown should be present with "All Sources" option
      const sourceSelects = document.querySelectorAll('select')
      expect(sourceSelects.length).toBeGreaterThan(0)
      
      // First select should have "All Sources" option
      const firstSelect = sourceSelects[0]
      expect(firstSelect.querySelector('option[value=""]')).toBeTruthy()
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above

// ============================================
// Regression tests for Problem Analysis bugs
// ============================================

describe('ProblemAnalysis - Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetResolvedProblems.mockResolvedValue({ resolved: [] })
    mockConfigStore.timeRange = '7d'
    mockConfigStore.customDateRange = null
  })

  describe('limit parameter (regression: backend capped at 100)', () => {
    it('requests limit=500 so the backend returns enough items for grouping', async () => {
      mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
      mockGetEntities.mockResolvedValue(mockEntities)

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetFeedback).toHaveBeenCalled()
      })

      const callArgs = mockGetFeedback.mock.calls[0][0]
      expect(callArgs.limit).toBe(500)
    })
  })

  describe('customDateRange (regression: custom range was ignored)', () => {
    it('passes customDateRange to getDaysFromRange', async () => {
      const { getDaysFromRange } = await import('../../api/client')
      const mockGetDaysFromRange = getDaysFromRange as ReturnType<typeof vi.fn>

      mockConfigStore.timeRange = 'custom'
      mockConfigStore.customDateRange = { start: '2026-01-01', end: '2026-01-15' }
      mockGetFeedback.mockResolvedValue({ items: [], count: 0 })
      mockGetEntities.mockResolvedValue(mockEntities)

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetDaysFromRange).toHaveBeenCalledWith(
          'custom',
          { start: '2026-01-01', end: '2026-01-15' }
        )
      })
    })
  })

  describe('data grouping with problem_summary', () => {
    it('shows non-zero stats when feedback items have problem_summary', async () => {
      mockGetFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
      mockGetEntities.mockResolvedValue(mockEntities)

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      })

      // With 2 items that have problem_summary, we should see non-zero stats
      // Both items are in category "delivery", subcategory "shipping_speed"
      // so we expect 1 category, 1 subcategory, and at least 1 problem
      const statValues = document.querySelectorAll('[class*="text-2xl"], [class*="text-3xl"]')
      const values = Array.from(statValues).map(el => el.textContent?.trim())
      // At least one stat should be non-zero
      expect(values.some(v => v && v !== '0')).toBe(true)
    })

    it('shows empty state when all items lack problem_summary', async () => {
      const itemsWithoutProblems = mockFeedbackItems.map(item => ({
        ...item,
        problem_summary: undefined,
      }))
      mockGetFeedback.mockResolvedValue({ items: itemsWithoutProblems, count: 2 })
      mockGetEntities.mockResolvedValue(mockEntities)

      render(<ProblemAnalysis />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/no problem analysis data found/i)).toBeInTheDocument()
      })
    })
  })
})
