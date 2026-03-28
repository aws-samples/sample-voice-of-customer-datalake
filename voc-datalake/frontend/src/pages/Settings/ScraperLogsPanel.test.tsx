/**
 * @fileoverview Tests for ScraperLogsPanel — regression for latestRun.status crash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetScrapers = vi.fn()
const mockGetScraperLogs = vi.fn()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    getScrapers: () => mockGetScrapers(),
  },
}))

vi.mock('../../api/client', () => ({
  api: {
    getScraperLogs: (...args: unknown[]) => mockGetScraperLogs(...args),
  },
}))

import { ScraperLogsPanel } from './ScraperLogsPanel'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('ScraperLogsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders scraper names without crashing when no logs exist yet', async () => {
    mockGetScrapers.mockResolvedValue({
      scrapers: [
        { id: 's1', name: 'My Scraper', enabled: true, base_url: 'https://example.com', urls: [], frequency_minutes: 60, pagination: { enabled: false, max_pages: 1 } },
      ],
    })

    render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('My Scraper')).toBeInTheDocument()
    })
  })

  /**
   * Regression test for: TypeError: Cannot read properties of undefined (reading 'status')
   * When logs array is empty, latestRun (logs[0]) is undefined.
   * Accessing latestRun.status crashed the component.
   */
  it('does not crash when latestRun is undefined (empty logs)', async () => {
    mockGetScrapers.mockResolvedValue({
      scrapers: [
        { id: 's1', name: 'My Scraper', enabled: true, base_url: 'https://example.com', urls: [], frequency_minutes: 60, pagination: { enabled: false, max_pages: 1 } },
      ],
    })
    mockGetScraperLogs.mockResolvedValue({ logs: [], count: 0 })

    render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('My Scraper')).toBeInTheDocument()
    })

    // Expand the card to trigger the logs query
    const user = userEvent.setup()
    await user.click(screen.getByText('My Scraper'))

    // Should show "no runs" message, not crash
    await waitFor(() => {
      expect(screen.getByText(/no runs/i)).toBeInTheDocument()
    })
  })

  it('shows status badge after expanding and loading logs', async () => {
    mockGetScrapers.mockResolvedValue({
      scrapers: [
        { id: 's1', name: 'My Scraper', enabled: true, base_url: 'https://example.com', urls: [], frequency_minutes: 60, pagination: { enabled: false, max_pages: 1 } },
      ],
    })
    mockGetScraperLogs.mockResolvedValue({
      logs: [{
        run_id: 'r1', status: 'completed', started_at: '2026-01-01T00:00:00Z',
        pages_scraped: 3, items_found: 10, errors: [],
      }],
      count: 1,
    })

    render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('My Scraper')).toBeInTheDocument()
    })

    // Before expansion, no status badge should be visible
    expect(screen.queryByText('completed')).not.toBeInTheDocument()

    // Expand to trigger log fetch
    const user = userEvent.setup()
    await user.click(screen.getByText('My Scraper'))

    // After expansion and query resolution, log entries should show status
    await waitFor(() => {
      expect(screen.getAllByText('completed').length).toBeGreaterThan(0)
    })
  })

  it('shows loading state when getScrapers is pending', () => {
    mockGetScrapers.mockReturnValue(new Promise(() => {}))

    render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('shows empty state when getScrapers returns empty list', async () => {
    mockGetScrapers.mockResolvedValue({ scrapers: [] })

    render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText(/no scrapers configured/i)).toBeInTheDocument()
    })
  })

  it('renders gracefully when getScrapers returns error', async () => {
    mockGetScrapers.mockRejectedValue(new Error('Service unavailable'))

    const { container } = render(<ScraperLogsPanel days={7} />, { wrapper: createWrapper() })

    // After error, loading state should disappear and component should not crash
    await waitFor(() => {
      // eslint-disable-next-line testing-library/no-node-access
      expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
    })
  })
})
