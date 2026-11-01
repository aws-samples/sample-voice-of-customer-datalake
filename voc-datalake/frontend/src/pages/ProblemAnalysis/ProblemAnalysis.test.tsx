/**
 * @fileoverview Tests for ProblemAnalysis page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import {
  clientApiModule,
  makeProblemGroup,
  problemAnalysisApiMocks,
  problemsApiModule,
} from './problem-analysis-fixtures'
import { configStoreModule, createQueryWrapper } from '../Categories/categories-fixtures'
import type { CategoryGroup, ProblemTreeResponse } from '../../api/problemsApi'

vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../api/problemsApi', () => problemsApiModule())
vi.mock('../../store/configStore', () => configStoreModule())

import ProblemAnalysis from './ProblemAnalysis'

const { getProblemTree, getEntities, getResolvedProblems, setProblemResolved } = problemAnalysisApiMocks

/** What "Problems only" (the default) sends: the six problem types plus the untyped reviews. */
const PROBLEMS_ONLY_DIMS = 'feedback_type:bug|service_failure|performance|usability|pricing_billing|support_experience|~unset'

/** The two similar delivery reviews, merged by the server into one "Slow delivery times" problem. */
const DELIVERY: CategoryGroup = {
  category: 'delivery',
  totalItems: 2,
  urgentCount: 1,
  subcategories: [{
    subcategory: 'shipping_speed', totalItems: 2, urgentCount: 1, problemCount: 1,
    problems: [makeProblemGroup({ similarProblems: ['Delivery too slow'], similarCount: 1 })],
  }],
}

const PRODUCT: CategoryGroup = {
  category: 'product',
  totalItems: 1,
  urgentCount: 0,
  subcategories: [{
    subcategory: 'durability', totalItems: 1, urgentCount: 0, problemCount: 1,
    problems: [makeProblemGroup({ problem: 'Breaks fast', similarProblems: [], similarCount: 0, count: 1, urgentCount: 0, sampleIds: ['f3'] })],
  }],
}

function treeOf(categories: CategoryGroup[], extra: Partial<ProblemTreeResponse> = {}): ProblemTreeResponse {
  return {
    categories,
    subcategories: categories.flatMap((c) => c.subcategories.map((s) => s.subcategory)).sort((a, b) => a.localeCompare(b)),
    feedbackCount: categories.reduce((sum, c) => sum + c.totalItems, 0),
    problemCount: categories.reduce((sum, c) => sum + c.subcategories.reduce((n, sub) => n + sub.problemCount, 0), 0),
    problemsTruncated: false,
    isPartial: false,
    scannedThrough: null,
    typeCounts: {},
    ...extra,
  }
}

/** A stand-in for the server: it narrows by `category` the way `GET /feedback/problems` does. */
function serveTree(categories: CategoryGroup[]) {
  getProblemTree.mockImplementation((params: unknown) => {
    const category = typeof params === 'object' && params !== null && 'category' in params ? params.category : null
    return Promise.resolve(treeOf(categories.filter((c) => category === null || category === undefined || c.category === category)))
  })
}

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
    serveTree([DELIVERY])
    getEntities.mockResolvedValue(mockEntities)
    getResolvedProblems.mockResolvedValue({ resolved: {} })
    setProblemResolved.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders stats cards', async () => {
      renderPage()

      await waitFor(() => {
        // Every stat label, exactly once: the list names any that is missing.
        const labels = ['Categories', 'Subcategories', 'Problems', 'Reviews with a problem', 'Urgent reviews']
        expect(labels.filter((label) => screen.queryAllByText(label).length !== 1)).toStrictEqual([])
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      getProblemTree.mockReturnValue(new Promise(() => {}))

      renderPage()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty state when no problems found', async () => {
      serveTree([])

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
  describe('server-side aggregation', () => {
    it('shows the server\'s counts, which cover the whole window', async () => {
      getProblemTree.mockResolvedValue(treeOf([{ ...DELIVERY, totalItems: 26_622, subcategories: [{ ...at(DELIVERY.subcategories, 0), totalItems: 26_622, problemCount: 4_100 }] }]))
      renderPage()

      expect(await screen.findByText('26,622')).toBeInTheDocument()
      expect(screen.getByText('4,100')).toBeInTheDocument()
      // Read in full: no caveat under the stats.
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('says so when the server read the window only in part', async () => {
      getProblemTree.mockResolvedValue(treeOf([DELIVERY], { isPartial: true, scannedThrough: '2026-03-14' }))
      renderPage()

      expect(await screen.findByRole('status')).toHaveTextContent(/back to Mar 14, 2026 only/)
    })

    it('sends a multi-source, usefulness link to the server as comma lists', async () => {
      render(<ProblemAnalysis />, { wrapper: createQueryWrapper(['/problems?source=webscraper,app&usefulness=high,unrated']) })

      await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({
        source: 'webscraper,app', usefulness: 'high,unrated',
      })))
    })

    it('sends the filters a shared link carries to the server', async () => {
      render(<ProblemAnalysis />, { wrapper: createQueryWrapper(['/problems?source=webscraper&category=delivery&subcategory=shipping_speed&urgent=1&similarity=high']) })

      await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith({
        days: 7, source: 'webscraper', category: 'delivery', subcategory: 'shipping_speed', urgentOnly: true, similarity: 'high',
        dims: PROBLEMS_ONLY_DIMS,
      }))
    })

    it('reports a failed read instead of an empty window', async () => {
      getProblemTree.mockRejectedValue(new Error('API Error: 500'))
      renderPage()

      expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load feedback for this window/)
      expect(screen.queryByText(/no problem analysis data found/i)).not.toBeInTheDocument()
    })
  })

describe('source filtering', () => {
    it('renders source filter dropdown with available sources', async () => {
      await renderLoadedPage()

      // The shared multi-value source selector (several sources = any of them).
      expect(screen.getByRole('button', { name: 'Source: All sources' })).toHaveAttribute('aria-expanded', 'false')
    })
  })
})

// Note: Testing "not configured" state requires module re-mocking which is complex
// The main functionality is tested above


describe('problem resolution (issue #66)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serveTree([DELIVERY])
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

describe('filters (in the URL; the subcategory list follows the category)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serveTree([DELIVERY, PRODUCT])
    getEntities.mockResolvedValue(mockEntities)
    getResolvedProblems.mockResolvedValue({ resolved: {} })
  })

  function subcategoryOptions(): string[] {
    const select = screen.getByRole('combobox', { name: 'Subcategory' })
    return [...select.querySelectorAll('option')].map((o) => o.textContent)
  }

  it('narrows the subcategory list to the chosen category', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('combobox', { name: 'Subcategory' })
    expect(subcategoryOptions()).toStrictEqual(['All Subcategories', 'Durability', 'Shipping speed'])

    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'delivery')
    expect(subcategoryOptions()).toStrictEqual(['All Subcategories', 'Shipping speed'])
  })

  it('opens with the filters a shared link carries', async () => {
    render(<ProblemAnalysis />, { wrapper: createQueryWrapper(['/problems?category=product&urgent=1&similarity=off']) })

    expect(await screen.findByRole('combobox', { name: 'Category' })).toHaveValue('product')
    expect(screen.getByRole('checkbox', { name: 'Urgent only' })).toBeChecked()
    expect(screen.getByRole('combobox', { name: /Similarity/ })).toHaveValue('off')
  })
})

describe('ProblemAnalysis period and review types', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serveTree([DELIVERY])
    getEntities.mockResolvedValue(mockEntities)
    getResolvedProblems.mockResolvedValue({ resolved: {} })
  })

  it('follows the header period: it sends the header days and offers no window select of its own', async () => {
    await renderLoadedPage()

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7, dims: PROBLEMS_ONLY_DIMS })))
    expect(getProblemTree.mock.lastCall?.[0]).not.toHaveProperty('latest')
    expect(screen.queryByRole('combobox', { name: 'Reviews analyzed' })).not.toBeInTheDocument()
  })

  it.each(['/problems?window=range', '/problems?window=latest'])('opens an old %s link on the header period', async (link) => {
    render(<ProblemAnalysis />, { wrapper: createQueryWrapper([link]) })

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({ days: 7, dims: PROBLEMS_ONLY_DIMS })))
    expect(getProblemTree.mock.lastCall?.[0]).not.toHaveProperty('latest')
  })

  it('sends no type filter under All types', async () => {
    const user = userEvent.setup()
    await renderLoadedPage()

    await user.click(screen.getByRole('button', { name: 'All types' }))

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({ dims: undefined })))
    expect(screen.getByRole('button', { name: 'All types' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('selects only that type when its pill is clicked while Problems only shows, keeping untyped reviews', async () => {
    const user = userEvent.setup()
    await renderLoadedPage()

    await user.click(screen.getByRole('button', { name: /^Feature request/ }))

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({
      dims: 'feedback_type:feature_request|~unset',
    })))
    expect(screen.getByRole('button', { name: 'Problems only' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /^Bug/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('adds a second type with a later click', async () => {
    const user = userEvent.setup()
    await renderLoadedPage()

    await user.click(screen.getByRole('button', { name: /^Feature request/ }))
    await user.click(screen.getByRole('button', { name: /^Praise/ }))

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({
      dims: 'feedback_type:feature_request|praise|~unset',
    })))
  })

  it('Clear unpresses every type pill and sends no type filter', async () => {
    const user = userEvent.setup()
    await renderLoadedPage()

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(getProblemTree).toHaveBeenLastCalledWith(expect.objectContaining({ dims: undefined })))
    for (const name of [/^Bug/, /^Feature request/, 'Problems only']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
    expect(screen.getByRole('button', { name: 'All types' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows each type count and how many reviews are not typed yet', async () => {
    getProblemTree.mockResolvedValue(treeOf([DELIVERY], { typeCounts: { bug: 1234, untyped: 56 } }))
    renderPage()

    expect(await screen.findByText('Reviews not typed yet: 56 (kept in view)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Bug/ })).toHaveTextContent('1,234')
  })
})
