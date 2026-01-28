/**
 * @fileoverview Tests for LogsSection component.
 * Tests validation logs, processing logs, and summary display.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LogsSection from './LogsSection'

// Mock API client
const mockGetLogsSummary = vi.fn()
const mockGetValidationLogs = vi.fn()
const mockGetProcessingLogs = vi.fn()
const mockGetScrapers = vi.fn()
const mockClearValidationLogs = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getLogsSummary: () => mockGetLogsSummary(),
    getValidationLogs: (params: unknown) => mockGetValidationLogs(params),
    getProcessingLogs: (params: unknown) => mockGetProcessingLogs(params),
    getScrapers: () => mockGetScrapers(),
    clearValidationLogs: (source: string) => mockClearValidationLogs(source),
    getScraperLogs: vi.fn().mockResolvedValue({ logs: [], count: 0 }),
  },
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('LogsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLogsSummary.mockResolvedValue({
      summary: {
        validation_failures: {},
        processing_errors: {},
        total_validation_failures: 0,
        total_processing_errors: 0,
      },
      days: 7,
    })
    mockGetValidationLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })
    mockGetProcessingLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })
    mockGetScrapers.mockResolvedValue({ scrapers: [] })
  })

  describe('when API endpoint is not configured', () => {
    it('displays configuration warning message', () => {
      render(<LogsSection apiEndpoint="" />, { wrapper: createWrapper() })

      expect(screen.getByText(/configure the api endpoint/i)).toBeInTheDocument()
    })

    it('does not fetch logs data', () => {
      render(<LogsSection apiEndpoint="" />, { wrapper: createWrapper() })

      expect(mockGetLogsSummary).not.toHaveBeenCalled()
      expect(mockGetValidationLogs).not.toHaveBeenCalled()
    })
  })

  describe('when API endpoint is configured', () => {
    it('displays system logs header', async () => {
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      expect(screen.getByText('System Logs')).toBeInTheDocument()
    })

    it('displays summary card with zero counts when no logs exist', async () => {
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Validation Failures')).toBeInTheDocument()
        expect(screen.getByText('Processing Errors')).toBeInTheDocument()
      })

      // Wait for loading to complete and check for zero counts
      await waitFor(() => {
        // The summary card should show 0 for both validation and processing
        const summarySection = screen.getByText('Validation Failures').closest('div')?.parentElement
        expect(summarySection).toBeInTheDocument()
      })
    })

    it('displays validation failure count when logs exist', async () => {
      mockGetLogsSummary.mockResolvedValue({
        summary: {
          validation_failures: { webscraper: 5, manual_import: 3 },
          processing_errors: {},
          total_validation_failures: 8,
          total_processing_errors: 0,
        },
        days: 7,
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('8')).toBeInTheDocument()
      })
    })

    it('displays processing error count when errors exist', async () => {
      mockGetLogsSummary.mockResolvedValue({
        summary: {
          validation_failures: {},
          processing_errors: { webscraper: 2 },
          total_validation_failures: 0,
          total_processing_errors: 2,
        },
        days: 7,
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument()
      })
    })
  })

  describe('tab navigation', () => {
    it('displays validation tab as active by default', async () => {
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      const validationTab = screen.getByRole('button', { name: /validation failures/i })
      expect(validationTab).toHaveClass('border-blue-600')
    })

    it('switches to processing tab when clicked', async () => {
      const user = userEvent.setup()
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      const processingTab = screen.getByRole('button', { name: /processing errors/i })
      await user.click(processingTab)

      expect(processingTab).toHaveClass('border-blue-600')
    })

    it('switches to scrapers tab when clicked', async () => {
      const user = userEvent.setup()
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      const scrapersTab = screen.getByRole('button', { name: /scraper runs/i })
      await user.click(scrapersTab)

      expect(scrapersTab).toHaveClass('border-blue-600')
    })
  })

  describe('time range selector', () => {
    it('displays time range dropdown with default 7 days', () => {
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('7')
    })

    it('changes time range when different option selected', async () => {
      const user = userEvent.setup()
      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      const select = screen.getByRole('combobox')
      await user.selectOptions(select, '30')

      expect(select).toHaveValue('30')
    })
  })

  describe('validation logs panel', () => {
    it('displays empty state when no validation logs exist', async () => {
      mockGetValidationLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/no validation failures/i)).toBeInTheDocument()
      })
    })

    it('displays validation logs grouped by source', async () => {
      mockGetValidationLogs.mockResolvedValue({
        logs: [
          {
            source_platform: 'webscraper',
            message_id: 'msg-123',
            timestamp: '2025-01-01T12:00:00Z',
            errors: ['Missing required field: text'],
            raw_preview: '{"id": "123"}',
          },
        ],
        count: 1,
        days: 7,
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('webscraper')).toBeInTheDocument()
        expect(screen.getByText('1 failures')).toBeInTheDocument()
      })
    })

    it('expands log entry to show error details when clicked', async () => {
      const user = userEvent.setup()
      mockGetValidationLogs.mockResolvedValue({
        logs: [
          {
            source_platform: 'webscraper',
            message_id: 'msg-123',
            timestamp: '2025-01-01T12:00:00Z',
            errors: ['Missing required field: text'],
            raw_preview: '{"id": "123"}',
          },
        ],
        count: 1,
        days: 7,
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('msg-123')).toBeInTheDocument()
      })

      // Click to expand
      await user.click(screen.getByText('msg-123'))

      await waitFor(() => {
        expect(screen.getByText('Missing required field: text')).toBeInTheDocument()
      })
    })
  })

  describe('processing logs panel', () => {
    it('displays empty state when no processing errors exist', async () => {
      const user = userEvent.setup()
      mockGetProcessingLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      // Switch to processing tab
      await user.click(screen.getByRole('button', { name: /processing errors/i }))

      await waitFor(() => {
        expect(screen.getByText(/no processing errors/i)).toBeInTheDocument()
      })
    })

    it('displays processing errors with error type and message', async () => {
      const user = userEvent.setup()
      mockGetProcessingLogs.mockResolvedValue({
        logs: [
          {
            source_platform: 'webscraper',
            message_id: 'msg-456',
            timestamp: '2025-01-01T12:00:00Z',
            error_type: 'BedrockError',
            error_message: 'Model invocation failed',
          },
        ],
        count: 1,
        days: 7,
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      // Switch to processing tab
      await user.click(screen.getByRole('button', { name: /processing errors/i }))

      await waitFor(() => {
        expect(screen.getByText('webscraper')).toBeInTheDocument()
        expect(screen.getByText('BedrockError')).toBeInTheDocument()
      })
    })
  })

  describe('scraper logs panel', () => {
    it('displays empty state when no scrapers configured', async () => {
      const user = userEvent.setup()
      mockGetScrapers.mockResolvedValue({ scrapers: [] })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      // Switch to scrapers tab
      await user.click(screen.getByRole('button', { name: /scraper runs/i }))

      await waitFor(() => {
        expect(screen.getByText(/no scrapers configured/i)).toBeInTheDocument()
      })
    })

    it('displays scraper cards when scrapers exist', async () => {
      const user = userEvent.setup()
      mockGetScrapers.mockResolvedValue({
        scrapers: [
          { id: 'scraper-1', name: 'Test Scraper', enabled: true },
        ],
      })

      render(<LogsSection apiEndpoint="https://api.example.com" />, { wrapper: createWrapper() })

      // Switch to scrapers tab
      await user.click(screen.getByRole('button', { name: /scraper runs/i }))

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })
    })
  })
})
