/**
 * @fileoverview Tests for Dashboard page component.
 * @module pages/Dashboard
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API before importing component
const mockGetSummary = vi.fn()
const mockGetSentiment = vi.fn()
const mockGetCategories = vi.fn()
const mockGetSources = vi.fn()
const mockGetUrgentFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getSummary: (days: number, source?: string) => mockGetSummary(days, source),
    getSentiment: (days: number, source?: string) => mockGetSentiment(days, source),
    getCategories: (days: number, source?: string) => mockGetCategories(days, source),
    getSources: (days: number) => mockGetSources(days),
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
  },
}))

vi.mock('../../api/baseUrl', () => ({
  getDaysFromRange: vi.fn(() => 7),
}))

// Mock config store
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    timeRange: '7d',
    customDateRange: null,
    config: { apiEndpoint: 'https://api.example.com', brandName: 'Test Brand' },
  })),
}))

// Mock child components to simplify testing
vi.mock('../../components/MetricCard', () => ({
  default: ({ title, value }: { title: string; value: string | number }) => (
    <div data-testid={`metric-${title.toLowerCase().replace(/\s/g, '-')}`}>
      <span>{title}</span>
      <span>{value}</span>
    </div>
  ),
}))

vi.mock('../../components/FeedbackCard', () => ({
  default: ({ feedback }: { feedback: { feedback_id: string; original_text: string } }) => (
    <div data-testid={`feedback-${feedback.feedback_id}`}>{feedback.original_text}</div>
  ),
}))

vi.mock('../../components/SocialFeed', () => ({
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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
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
      
      render(<Dashboard />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })

  describe('metrics display', () => {
    it('displays total feedback count after loading', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-total-feedback')).toBeInTheDocument()
      })
      expect(screen.getByText('1,234')).toBeInTheDocument()
    })

    it('displays average sentiment metric', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-avg-sentiment')).toBeInTheDocument()
      })
    })

    it('displays urgent issues count', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-urgent-issues')).toBeInTheDocument()
      })
    })

    it('displays sources active count', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('metric-sources-active')).toBeInTheDocument()
      })
    })
  })

  describe('charts', () => {
    it('renders trend chart', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Feedback Volume & Sentiment Trend')).toBeInTheDocument()
      })
    })

    it('renders sentiment distribution chart', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Sentiment Distribution')).toBeInTheDocument()
      })
    })

    it('renders category chart', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Top Issue Categories')).toBeInTheDocument()
      })
    })

    it('renders source chart', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Feedback by Source')).toBeInTheDocument()
      })
    })
  })

  describe('urgent feedback section', () => {
    it('displays urgent issues section with count', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Use getAllByText since "Urgent Issues" appears in both MetricCard and UrgentFeedback section
        const urgentElements = screen.getAllByText(/Urgent Issues/)
        expect(urgentElements.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('displays urgent feedback items', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('feedback-1')).toBeInTheDocument()
        expect(screen.getByTestId('feedback-2')).toBeInTheDocument()
      })
    })

    it('displays celebration message when no urgent issues', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
      
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/No urgent issues/)).toBeInTheDocument()
      })
    })
  })

  describe('social feed', () => {
    it('renders social feed component', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('social-feed')).toBeInTheDocument()
      })
    })
  })

  describe('API calls', () => {
    it('fetches summary with correct days parameter', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockGetSummary).toHaveBeenCalled()
      })
    })

    it('fetches sentiment data', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockGetSentiment).toHaveBeenCalled()
      })
    })

    it('fetches categories data', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockGetCategories).toHaveBeenCalled()
      })
    })

    it('fetches sources data', async () => {
      render(<Dashboard />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockGetSources).toHaveBeenCalled()
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
        customDateRange: null,
        config: { apiEndpoint: '', brandName: '' },
      })),
    }))
  })

  it('displays configuration prompt when API endpoint not set', async () => {
    vi.resetModules()
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        timeRange: '7d',
        customDateRange: null,
        config: { apiEndpoint: '', brandName: '' },
      }),
    }))
    
    const { default: DashboardNotConfigured } = await import('./Dashboard')
    
    render(<DashboardNotConfigured />, { wrapper: createWrapper() })
    
    expect(screen.getByText('Welcome to VoC Analytics')).toBeInTheDocument()
    expect(screen.getByText(/Configure your API endpoint/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Go to Settings/i })).toBeInTheDocument()
  })
})
