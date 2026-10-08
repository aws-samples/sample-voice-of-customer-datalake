/**
 * @fileoverview Tests for LogsSection component.
 * Tests validation logs, processing logs, and summary display.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import LogsSection from './LogsSection'

const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin }))

// Mock API client
const mockGetLogsSummary = vi.fn<(...args: unknown[]) => unknown>()
const mockGetValidationLogs = vi.fn<(...args: unknown[]) => unknown>()
const mockGetProcessingLogs = vi.fn<(...args: unknown[]) => unknown>()
const mockGetScrapers = vi.fn<(...args: unknown[]) => unknown>()
const mockClearValidationLogs = vi.fn<(...args: unknown[]) => unknown>()

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

const API_ENDPOINT = 'https://api.example.com'

/** One webscraper validation failure, as `GET /logs/validation` returns it. */
const ONE_VALIDATION_FAILURE = {
  logs: [
    {
      source_platform: 'webscraper',
      message_id: 'msg-123',
      timestamp: '2025-01-01T12:00:00Z',
      errors: ['Missing required field: text'],
    },
  ],
  count: 1,
  days: 7,
}

function renderSection() {
  return renderWithQueryClient(<LogsSection apiEndpoint={API_ENDPOINT} />)
}

/** Mount the section and switch to the tab whose button matches `tabName`. */
async function renderOnTab(user: UserEvent, tabName: RegExp) {
  renderSection()
  await user.click(screen.getByRole('button', { name: tabName }))
}

describe('LogsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.isAdmin = true
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
      renderWithQueryClient(<LogsSection apiEndpoint="" />)

      expect(screen.getByText(/configure the api endpoint/i)).toBeInTheDocument()
    })

    it('does not fetch logs data', () => {
      renderWithQueryClient(<LogsSection apiEndpoint="" />)

      expect(mockGetLogsSummary).not.toHaveBeenCalled()
      expect(mockGetValidationLogs).not.toHaveBeenCalled()
    })
  })

  describe('when API endpoint is configured', () => {
    it('displays system logs header', async () => {
      renderSection()

      expect(screen.getByText('System Logs')).toBeInTheDocument()
    })

    it('labels the period select and marks the active sub-tab', () => {
      renderSection()

      expect(screen.getByRole('combobox', { name: 'Time period' })).toHaveValue('7')
      expect(screen.getByRole('button', { name: /Validation Failures/i })).toHaveAttribute('aria-pressed', 'true')
    })

    it('displays summary card with zero counts when no logs exist', async () => {
      renderSection()

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

      renderSection()

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

      renderSection()

      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument()
      })
    })
  })

  describe('tab navigation', () => {
    it('displays validation tab as active by default', async () => {
      renderSection()

      const validationTab = screen.getByRole('button', { name: /validation failures/i })
      expect(validationTab).toHaveClass('tab-active')
    })

    it('switches to processing tab when clicked', async () => {
      const user = userEvent.setup()
      renderSection()

      const processingTab = screen.getByRole('button', { name: /processing errors/i })
      await user.click(processingTab)

      expect(processingTab).toHaveClass('tab-active')
    })

    it('switches to scrapers tab when clicked', async () => {
      const user = userEvent.setup()
      renderSection()

      const scrapersTab = screen.getByRole('button', { name: /scraper runs/i })
      await user.click(scrapersTab)

      expect(scrapersTab).toHaveClass('tab-active')
    })
  })

  describe('time range selector', () => {
    it('displays time range dropdown with default 7 days', () => {
      renderSection()

      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('7')
    })

    it('changes time range when different option selected', async () => {
      const user = userEvent.setup()
      renderSection()

      const select = screen.getByRole('combobox')
      await user.selectOptions(select, '30')

      expect(select).toHaveValue('30')
    })
  })

  describe('validation logs panel', () => {
    it('displays empty state when no validation logs exist', async () => {
      mockGetValidationLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })

      renderSection()

      await waitFor(() => {
        expect(screen.getByText(/no validation failures/i)).toBeInTheDocument()
      })
    })

    it('displays validation logs grouped by source', async () => {
      mockGetValidationLogs.mockResolvedValue(ONE_VALIDATION_FAILURE)

      renderSection()

      await waitFor(() => {
        expect(screen.getByText('webscraper')).toBeInTheDocument()
        // Pluralised through i18n: one failure, not "1 failures"
        expect(screen.getByText('1 failure')).toBeInTheDocument()
      })
    })

    it('expands log entry to show error details when clicked', async () => {
      const user = userEvent.setup()
      mockGetValidationLogs.mockResolvedValue(ONE_VALIDATION_FAILURE)

      renderSection()

      await waitFor(() => {
        expect(screen.getByText('msg-123')).toBeInTheDocument()
      })

      // Click to expand
      await user.click(screen.getByText('msg-123'))

      await waitFor(() => {
        expect(screen.getByText('Missing required field: text')).toBeInTheDocument()
      })
    })

    it('renders the record shape and never a raw preview, even if an older API sends one', async () => {
      const user = userEvent.setup()
      mockGetValidationLogs.mockResolvedValue({
        ...ONE_VALIDATION_FAILURE,
        logs: [{
          ...ONE_VALIDATION_FAILURE.logs[0],
          raw_preview: '{"submitter_email": "jane.doe@example.com"}',
          record_keys: ['id', 'submitter_email', 'text'],
          text_length: 1,
        }],
      })

      renderSection()
      await user.click(await screen.findByText('msg-123'))

      expect(await screen.findByText('id, submitter_email, text')).toBeInTheDocument()
      expect(screen.getByText('Fields present:')).toBeInTheDocument()
      expect(screen.getByText('Text length: 1 character')).toBeInTheDocument()
      // Never rendered: neither the preview's PII nor a "raw preview" label.
      expect([screen.queryByText(/jane\.doe@example\.com/), screen.queryByText(/raw preview/i)])
        .toStrictEqual([null, null])
    })

    it('lets an admin clear a source', async () => {
      const user = userEvent.setup()
      mockGetValidationLogs.mockResolvedValue(ONE_VALIDATION_FAILURE)
      mockClearValidationLogs.mockResolvedValue({ success: true, deleted: 1 })

      renderSection()
      const clear = await screen.findByRole('button', { name: /clear/i })
      expect(clear).toBeEnabled()
      expect(clear).not.toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(clear)

      await waitFor(() => expect(mockClearValidationLogs).toHaveBeenCalledWith('webscraper'))
    })

    it('disables Clear for a non-admin: DELETE /logs/* is admin-only', async () => {
      const user = userEvent.setup()
      auth.isAdmin = false
      mockGetValidationLogs.mockResolvedValue(ONE_VALIDATION_FAILURE)

      renderSection()
      const clear = await screen.findByRole('button', { name: /clear/i })
      expect(clear).toBeDisabled()
      expect(clear).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(clear)

      expect(mockClearValidationLogs).not.toHaveBeenCalled()
    })
  })

  describe('processing logs panel', () => {
    it('displays empty state when no processing errors exist', async () => {
      const user = userEvent.setup()
      mockGetProcessingLogs.mockResolvedValue({ logs: [], count: 0, days: 7 })

      await renderOnTab(user, /processing errors/i)

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

      await renderOnTab(user, /processing errors/i)

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

      await renderOnTab(user, /scraper runs/i)

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

      await renderOnTab(user, /scraper runs/i)

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })
    })
  })
})
