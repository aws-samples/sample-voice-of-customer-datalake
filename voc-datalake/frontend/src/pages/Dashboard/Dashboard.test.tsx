/**
 * @fileoverview Tests for Dashboard page component.
 * @module pages/Dashboard
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
// The copy under test, read from the locale file the app itself renders from —
// the same source src/test/setup.ts loads into i18next.
import enCommon from '../../../public/locales/en/common.json'
import enDashboard from '../../../public/locales/en/dashboard.json'

// Mock API before importing component
const mockGetSummary = vi.fn<(...args: unknown[]) => unknown>()
const mockGetSentiment = vi.fn<(...args: unknown[]) => unknown>()
const mockGetCategories = vi.fn<(...args: unknown[]) => unknown>()
const mockGetSources = vi.fn<(...args: unknown[]) => unknown>()
const mockGetUrgentFeedback = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getSummary: (days: number, source?: string) => mockGetSummary(days, source),
    getSentiment: (days: number, source?: string) => mockGetSentiment(days, source),
    getCategories: (days: number, source?: string) => mockGetCategories(days, source),
    getSources: (days: number) => mockGetSources(days),
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
  },
  getDateRangeParams: () => ({ days: 7 }),
}))

// Mock config store
const { mockSetTimeRange, mockSetCustomDays } = vi.hoisted(() => ({
  mockSetTimeRange: vi.fn(),
  mockSetCustomDays: vi.fn(),
}))
vi.mock('../../store/configStore', () => import('@test/page-mocks').then((m) => m.configStoreHookMock({
  timeRange: '7d',
  customDays: null,
  config: { apiEndpoint: 'https://api.example.com', brandName: 'Test Brand' },
  setTimeRange: mockSetTimeRange,
  setCustomDays: mockSetCustomDays,
})))

// Mock child components to simplify testing.
//
// `hint` is forwarded, not dropped: it is the only user-visible statement that a
// total is a lower bound rather than exact, and a mock that swallows it lets the
// hint be deleted — or left as an untranslated literal — with this suite green.
// MetricCard's own test covers what it DOES with the value (title + aria-label);
// here it just has to be reachable.
vi.mock('../../components/MetricCard/MetricCard', () => ({
  default: ({ title, value, hint }: { title: string; value: string | number; hint?: string }) => (
    <div data-testid={`metric-${title.toLowerCase().replace(/\s/g, '-')}`}>
      <span>{title}</span>
      <span>{value}</span>
      {hint && <span data-testid="metric-hint">{hint}</span>}
    </div>
  ),
}))

vi.mock('../../components/FeedbackCard/FeedbackCard', () => ({
  default: ({ feedback }: { feedback: { feedback_id: string; original_text: string } }) => (
    <div data-testid={`feedback-${feedback.feedback_id}`}>{feedback.original_text}</div>
  ),
}))

vi.mock('../../components/SocialFeed/SocialFeed', () => ({
  default: () => <div data-testid="social-feed">Social Feed</div>,
}))

// Mock recharts to avoid rendering issues in tests
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: () => <div data-testid="line-chart">Line Chart</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  PieChart: () => <div data-testid="pie-chart">Pie Chart</div>,
  Pie: () => null,
  Cell: () => null,
  BarChart: () => <div data-testid="bar-chart">Bar Chart</div>,
  Bar: () => null,
}))

import Dashboard from './Dashboard'
import { clickLoadFailedRetry } from '@test/loadFailed'

/** Renders `ui` (the page by default) with a no-retry query client inside its router. */
function renderDashboard(ui: React.ReactElement = <Dashboard />) {
  return renderWithQueryClient(<TestRouter initialEntries={['/']}>{ui}</TestRouter>)
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({
      total_feedback: 1234,
      avg_sentiment: 0.65,
      urgent_count: 5,
      daily_totals: [{ date: '2025-01-01', count: 100 }],
      daily_sentiment: [{ date: '2025-01-01', avg_sentiment: 0.5, count: 100 }],
    })
    mockGetSentiment.mockResolvedValue({
      breakdown: { positive: 60, negative: 20, neutral: 15, mixed: 5 },
      percentages: { positive: 60, negative: 20, neutral: 15, mixed: 5 },
    })
    mockGetCategories.mockResolvedValue({
      categories: { delivery: 50, support: 30, quality: 20 },
    })
    mockGetSources.mockResolvedValue({
      sources: { webscraper: 100, manual_import: 50 },
    })
    mockGetUrgentFeedback.mockResolvedValue({
      count: 3,
      items: [
        { feedback_id: '1', original_text: 'Urgent issue 1', urgency: 'high' },
        { feedback_id: '2', original_text: 'Urgent issue 2', urgency: 'high' },
      ],
    })
  })

  describe('loading state', () => {
    it('displays loading indicator while fetching data', () => {
      mockGetSummary.mockReturnValue(new Promise(() => {}))
      
      renderDashboard()
      
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })

  describe('load failed', () => {
    it('says the summary could not be loaded instead of showing the empty state', async () => {
      mockGetSummary.mockRejectedValue(new Error('Failed to fetch'))

      renderDashboard()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(enCommon.loadFailed.message)
      expect(screen.queryByText(enDashboard.onboarding.heading)).not.toBeInTheDocument()
      expect(screen.queryByText(enDashboard.windowEmpty.heading)).not.toBeInTheDocument()
      // The all-time check behind the empty states is never asked.
      expect(mockGetSummary).toHaveBeenCalledTimes(1)
    })

    it('recovers in place when Try again succeeds', async () => {
      mockGetSummary.mockRejectedValueOnce(new Error('API Error: 500'))
      const user = userEvent.setup()
      renderDashboard()

      await clickLoadFailedRetry(user)

      expect(await screen.findByText('1,234')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('metrics display', () => {
    it('displays total feedback count after loading', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-total-feedback')).toBeInTheDocument()
      })
      expect(screen.getByText('1,234')).toBeInTheDocument()
    })

    it('marks totals as approximate when the metrics scan was partial', async () => {
      mockGetSummary.mockResolvedValue({
        total_feedback: 1234,
        avg_sentiment: 0.65,
        urgent_count: 5,
        is_partial: true,
        daily_totals: [{ date: '2025-01-01', count: 100 }],
        daily_sentiment: [{ date: '2025-01-01', avg_sentiment: 0.5, count: 100 }],
      })

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('~1,234')).toBeInTheDocument()
      })
      expect(screen.getByText('~5')).toBeInTheDocument()
      // The `~` alone does not say WHY, so the hint carries the meaning. The
      // expected copy is READ from the English locale file rather than pasted
      // here — the repo's lockstep idiom — so editing the wording is one change
      // instead of two. A missing or misspelled key still fails, because i18next
      // renders the key name and that is not what the file says.
      //
      // getAllByTestId, and no assertion on how MANY: more than one card carries
      // the hint, a getByTestId would fail on the second rather than on the thing
      // under test, and a count would be a tripwire on unrelated card edits.
      const hints = screen.getAllByTestId('metric-hint')
      expect(hints.length).toBeGreaterThan(0)
      for (const hint of hints) {
        expect(hint).toHaveTextContent(enCommon.partialCountsHint)
      }
    })

    it('does not hint at approximation when the window was read in full', async () => {
      // The positive control for the case above. Without it the hint could be
      // rendered unconditionally — a permanent "approximate" is as uninformative
      // as never showing it, and both read as "ignore this".
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('1,234')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('metric-hint')).not.toBeInTheDocument()
    })

    it('displays average sentiment metric', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-avg-sentiment')).toBeInTheDocument()
      })
    })

    it('displays urgent issues count', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-urgent-issues')).toBeInTheDocument()
      })
    })

    it('displays sources active count', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-sources-active')).toBeInTheDocument()
      })
    })
  })

  describe('charts', () => {
    it('renders trend chart', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Feedback Volume & Sentiment Trend')).toBeInTheDocument()
      })
    })

    it('renders sentiment distribution chart', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Sentiment Distribution')).toBeInTheDocument()
      })
    })

    it('renders category chart', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Top Issue Categories')).toBeInTheDocument()
      })
    })

    it('renders source chart', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Feedback by Source')).toBeInTheDocument()
      })
    })
  })

  describe('urgent feedback section', () => {
    it('displays urgent issues section with count', async () => {
      renderDashboard()
      
      await waitFor(() => {
        // Use getAllByText since "Urgent Issues" appears in both MetricCard and UrgentFeedback section
        const urgentElements = screen.getAllByText(/Urgent Issues/)
        expect(urgentElements.length).toBeGreaterThanOrEqual(1)
      })
    })

    /**
     * A summary claiming `urgentCount` urgent items while the preview page
     * carries exactly two — the divergence both heading cases are about.
     */
    function loadDivergingUrgentCounts(urgentCount: number) {
      mockGetSummary.mockResolvedValue({
        total_feedback: 1234,
        avg_sentiment: 0.65,
        urgent_count: urgentCount,
        daily_totals: [{ date: '2025-01-01', count: 100 }],
        daily_sentiment: [{ date: '2025-01-01', avg_sentiment: 0.5, count: 100 }],
      })
      mockGetUrgentFeedback.mockResolvedValue({
        count: 2,
        items: [
          { feedback_id: '1', original_text: 'Urgent issue 1', urgency: 'high' },
          { feedback_id: '2', original_text: 'Urgent issue 2', urgency: 'high' },
        ],
      })
    }

    // Design audit: Urgent Issues showed "11268" beside Total Feedback's "16,809".
    it('groups the urgent metric digits like the total', async () => {
      loadDivergingUrgentCounts(11268)
      renderDashboard()
      expect(await screen.findByText((11268).toLocaleString())).toBeInTheDocument()
    })

    // Regression: the heading used to report the preview list's `count`, which
    // is one page's length and is clamped by the limit the list was fetched
    // with. It must report the summary aggregate instead. The fixtures diverge
    // on purpose — summary says 5 urgent, the preview page says 3.
    it('reports the summary total in the urgent heading, not the preview page size', async () => {
      // Own the divergence rather than inheriting it from shared fixtures: 11
      // urgent items exist, the preview page carries 2. The heading must say 11.
      loadDivergingUrgentCounts(11)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('Urgent Issues (11)')).toBeInTheDocument()
      })
      expect(screen.queryByText('Urgent Issues (2)')).not.toBeInTheDocument()
    })

    // The heading and the list come from different sources (exact METRIC#urgent
    // aggregate vs. windowed scan), so the heading must never claim fewer items
    // than are visible beneath it. A stale or un-backfilled aggregate reads 0
    // while the scan still returns items — and 0 is not nullish, so `??` would
    // not catch it. This is the reachable case; a summary *failure* instead
    // swaps the whole dashboard for its empty state.
    it('never reports fewer urgent items than it renders', async () => {
      loadDivergingUrgentCounts(0)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('Urgent Issues (2)')).toBeInTheDocument()
      })
      expect(screen.queryByText('Urgent Issues (0)')).not.toBeInTheDocument()
    })

    // Pins the fetch limit to the render cap so the two cannot drift apart again.
    it('renders no more urgent cards than the preview limit fetches', async () => {
      const many = Array.from({ length: 9 }, (_, i) => ({
        feedback_id: String(i),
        original_text: `Urgent issue ${i}`,
        urgency: 'high',
      }))
      mockGetUrgentFeedback.mockResolvedValue({ count: many.length, items: many })

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('Urgent issue 0')).toBeInTheDocument()
      })
      // URGENT_PREVIEW_LIMIT is 5; the 6th item must not render.
      expect(screen.queryByText('Urgent issue 5')).not.toBeInTheDocument()
      // Pin the fetch side too, so the request limit and the render cap cannot
      // drift apart in opposite directions and still satisfy this test.
      expect(mockGetUrgentFeedback).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }))
    })

    it('displays urgent feedback items', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('feedback-1')).toBeInTheDocument()
        expect(screen.getByTestId('feedback-2')).toBeInTheDocument()
      })
    })

    it('displays celebration message when no urgent issues', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText(/No urgent issues/)).toBeInTheDocument()
      })
    })
  })

  describe('social feed', () => {
    it('renders social feed component', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('social-feed')).toBeInTheDocument()
      })
    })
  })

  describe('API calls', () => {
    it('fetches summary with correct days parameter', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(mockGetSummary).toHaveBeenCalledWith({ days: 7 }, undefined)
      })
    })

    it('fetches sentiment data', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(mockGetSentiment).toHaveBeenCalledWith({ days: 7 }, undefined)
      })
    })

    it('fetches categories data', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(mockGetCategories).toHaveBeenCalledWith({ days: 7 }, undefined)
      })
    })

    it('fetches sources data', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(mockGetSources).toHaveBeenCalledWith({ days: 7 })
      })
    })
  })
})

describe('Dashboard not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: vi.fn(() => ({
        timeRange: '7d',
        customDays: null,
        config: { apiEndpoint: '', brandName: '' },
      })),
    }))
  })

  it('displays configuration prompt when API endpoint not set', async () => {
    vi.resetModules()
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        timeRange: '7d',
        customDays: null,
        config: { apiEndpoint: '', brandName: '' },
      }),
    }))
    
    const { default: DashboardNotConfigured } = await import('./Dashboard')
    
    renderDashboard(<DashboardNotConfigured />)
    
    expect(screen.getByText('Welcome to VoC Analytics')).toBeInTheDocument()
    expect(screen.getByText(/Configure your API endpoint/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Go to Settings/i })).toBeInTheDocument()
  })
})

/** Every mock cleared, and every breakdown answering empty. */
function resetToEmptyBreakdowns() {
  vi.clearAllMocks()
  mockGetSentiment.mockResolvedValue({ breakdown: {}, percentages: {} })
  mockGetCategories.mockResolvedValue({ categories: {} })
  mockGetSources.mockResolvedValue({ sources: {} })
  mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
}

describe('empty-state onboarding (P11)', () => {
  beforeEach(resetToEmptyBreakdowns)

  it('shows a compact empty state that points to Home when there is no feedback', async () => {
    mockGetSummary.mockResolvedValue({
      total_feedback: 0,
      avg_sentiment: 0,
      urgent_count: 0,
      daily_totals: [],
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText(/get your feedback flowing/i)).toBeInTheDocument()
    })
    // The compact empty state links to the Home guide (/) rather than
    // duplicating the full onboarding cards, which now live on Home.
    const homeLink = screen.getByRole('link', { name: /start here/i })
    expect(homeLink).toHaveAttribute('href', '/')
    expect(screen.queryByText('Collect reviews')).not.toBeInTheDocument()
    // The normal dashboard widgets are not rendered in the empty state.
    expect(screen.queryByText('Feedback Volume & Sentiment Trend')).not.toBeInTheDocument()
  })

  it('shows the normal dashboard when feedback exists', async () => {
    mockGetSummary.mockResolvedValue({
      total_feedback: 42,
      avg_sentiment: 0.5,
      urgent_count: 0,
      daily_totals: [{ date: '2025-01-01', count: 42 }],
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText('Feedback Volume & Sentiment Trend')).toBeInTheDocument()
    })
    expect(screen.queryByText(/get your feedback flowing/i)).not.toBeInTheDocument()
  })
})

describe('window empty vs workspace empty (E2E F4)', () => {
  /** The production shape: nothing in the window, 16,799 items all time, newest 2026-06-15. */
  const ALL_TIME_SUMMARY = {
    total_feedback: 16799,
    avg_sentiment: 0.1,
    urgent_count: 12,
    daily_totals: [
      { date: '2026-06-14', count: 40 },
      { date: '2026-06-16', count: 0 },
      { date: '2026-06-15', count: 21 },
      { date: '2025-01-02', count: 16738 },
    ],
    daily_sentiment: [],
  }
  const EMPTY_WINDOW = { total_feedback: 0, avg_sentiment: 0, urgent_count: 0, daily_totals: [], daily_sentiment: [] }

  /** Answer `/metrics/summary` per window: 0 for `days=0`, the empty window for anything else. */
  function summaryByWindow(allTime: unknown) {
    mockGetSummary.mockImplementation((range: unknown) => {
      const days = typeof range === 'object' && range !== null && 'days' in range ? range.days : undefined
      if (days === 0) return allTime instanceof Error ? Promise.reject(allTime) : Promise.resolve(allTime)
      return Promise.resolve(EMPTY_WINDOW)
    })
  }

  beforeEach(resetToEmptyBreakdowns)

  it('names the newest feedback date and the all-time count instead of calling the workspace empty', async () => {
    summaryByWindow(ALL_TIME_SUMMARY)

    renderDashboard()

    expect(await screen.findByRole('heading', { name: 'No feedback in this time range' })).toBeInTheDocument()
    expect(screen.getByText(
      'Your workspace has 16799 feedback items. The newest is from June 15, 2026, outside the selected range.',
    )).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /start here/i })).not.toBeInTheDocument()
  })

  it('asks the all-time summary with only `days` widened to 0', async () => {
    summaryByWindow(ALL_TIME_SUMMARY)

    renderDashboard()

    await screen.findByRole('heading', { name: 'No feedback in this time range' })
    expect(mockGetSummary).toHaveBeenCalledWith({ days: 0 }, undefined)
  })

  it('"Show all time" switches the selector to the All time preset in one click', async () => {
    summaryByWindow(ALL_TIME_SUMMARY)
    renderDashboard()

    const button = await screen.findByRole('button', { name: 'Show all time' })
    button.click()

    expect(mockSetTimeRange).toHaveBeenCalledWith('all')
    expect(mockSetCustomDays).toHaveBeenCalledWith(null)
  })

  it('shows the welcome state only when the all-time total is 0', async () => {
    summaryByWindow(EMPTY_WINDOW)

    renderDashboard()

    expect(await screen.findByText(/get your feedback flowing/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show all time' })).not.toBeInTheDocument()
  })

  it('never claims the workspace is empty when the all-time check fails', async () => {
    summaryByWindow(new Error('502'))

    renderDashboard()

    expect(await screen.findByRole('heading', { name: 'No feedback in this time range' })).toBeInTheDocument()
    expect(screen.getByText('Nothing was collected in the selected range. Older feedback may exist.')).toBeInTheDocument()
    expect(screen.queryByText(/get your feedback flowing/i)).not.toBeInTheDocument()
  })
})
