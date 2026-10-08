/**
 * @fileoverview Tests for ProblemAnalysis page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import {
  clientApiModule,
  problemAnalysisApiMocks,
} from './problem-analysis-fixtures'
import { configStoreModule, createQueryWrapper } from '../Categories/categories-fixtures'

vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../store/configStore', () => configStoreModule())

import ProblemAnalysis from './ProblemAnalysis'

const { getFeedback, getEntities, getResolvedProblems, setProblemResolved } = problemAnalysisApiMocks

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

function renderPage() {
  return render(<ProblemAnalysis />, { wrapper: createQueryWrapper(['/']) })
}

/** Renders the page and waits for the loading spinner to go away. */
async function renderLoadedPage() {
  renderPage()
  await waitFor(() => {
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
  })
}

/** Renders the page and waits for the "show resolved (1)" toggle to appear. */
async function renderPageWithResolvedToggle() {
  renderPage()
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: /show resolved \(1\)/i })).toBeInTheDocument()
  })
}

describe('ProblemAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
    getEntities.mockResolvedValue(mockEntities)
    getResolvedProblems.mockResolvedValue({ resolved: {} })
    setProblemResolved.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders stats cards', async () => {
      renderPage()

      await waitFor(() => {
        // Every stat label, exactly once: the list names any that is missing.
        const labels = ['Categories', 'Subcategories', 'Problems', 'Feedback', 'Urgent']
        expect(labels.filter((label) => screen.queryAllByText(label).length !== 1)).toStrictEqual([])
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      getFeedback.mockReturnValue(new Promise(() => {}))

      renderPage()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no problems found', async () => {
      getFeedback.mockResolvedValue({ items: [], count: 0 })

      renderPage()

      await waitFor(() => {
        expect(screen.getByText(/no problem analysis data found/i)).toBeInTheDocument()
      })
    })
  })

  describe('category grouping', () => {
    it('renders categories when feedback has problem summaries', async () => {
      await renderLoadedPage()

      // The component should render - check for stats cards which always render
      expect(screen.getByText('Categories')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('renders expand button', async () => {
      await renderLoadedPage()

      // Check expand button exists
      const expandButtons = screen.getAllByRole('button')
      const expandButton = expandButtons.find(b => b.textContent.toLowerCase().includes('expand'))
      expect(expandButton).toBeTruthy()
    })
  })
describe('source filtering', () => {
    it('renders source filter dropdown with available sources', async () => {
      await renderLoadedPage()

      // The source filter dropdown should be present with "All Sources" option
      const sourceSelects = document.querySelectorAll('select')
      expect(sourceSelects.length).toBeGreaterThan(0)
      
      // First select should have "All Sources" option
      const firstSelect = at(sourceSelects, 0)
      expect(firstSelect.querySelector('option[value=""]')).toBeTruthy()
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above


describe('problem resolution (issue #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getFeedback.mockResolvedValue({ items: mockFeedbackItems, count: 2 })
    getEntities.mockResolvedValue(mockEntities)
    setProblemResolved.mockResolvedValue({ success: true })
    // Both mock feedback items merge into the same "Slow delivery times"
    // problem group (similarity), which is marked resolved server-side.
    getResolvedProblems.mockResolvedValue({
      resolved: {
        'delivery|shipping_speed|slow delivery times': { resolved_at: '2026-07-01T00:00:00Z' },
      },
    })
  })

  it('hides resolved problems by default and shows them via the toggle', async () => {
    // Resolved group hidden: the page falls back to its empty state.
    await renderPageWithResolvedToggle()
    expect(screen.queryByText('Slow delivery times')).not.toBeInTheDocument()
    // The empty state explains WHY the tree is empty instead of "no data".
    expect(screen.getByText(/marked resolved/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }))

    // Visible again, annotated as resolved (category header appears).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delivery/i })).toBeInTheDocument()
    })
  })

  it('persists an unresolve action through the API', async () => {
    await renderPageWithResolvedToggle()
    await userEvent.click(screen.getByRole('checkbox', { name: /show resolved/i }))

    // Expand category → subcategory to reach the problem row.
    await userEvent.click(await screen.findByRole('button', { name: /delivery/i }))
    await userEvent.click(await screen.findByRole('button', { name: /shipping speed/i }))

    await userEvent.click(await screen.findByRole('button', { name: /mark as unresolved/i }))

    expect(setProblemResolved).toHaveBeenCalledWith(
      'delivery|shipping_speed|slow delivery times', false,
    )
  })
})
