/**
 * @fileoverview Tests for ManualImportModal component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import ManualImportModal from './ManualImportModal'
import { useManualImportStore } from '../../store/manualImportStore'
import { ApiError } from '../../lib/errors'

// Mock API client
const mockStartManualImportParse = vi.fn<(...args: unknown[]) => unknown>()
const mockGetManualImportStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockConfirmManualImport = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    startManualImportParse: (...args: unknown[]) => mockStartManualImportParse(...args),
    getManualImportStatus: (...args: unknown[]) => mockGetManualImportStatus(...args),
    confirmManualImport: (...args: unknown[]) => mockConfirmManualImport(...args),
  },
}))

/** Render the modal and click the button whose accessible name matches `name`. */
async function renderAndClick(name: RegExp) {
  const user = userEvent.setup()
  render(<ManualImportModal />)
  await user.click(screen.getByRole('button', { name }))
  return user
}

const clickParse = () => renderAndClick(/parse reviews/i)
const clickImportOne = () => renderAndClick(/import 1 review/i)

type ConfirmResolver = (value: { success: boolean }) => void

/** Make confirmManualImport hang until the returned holder's `resolve` is called. */
function makeConfirmPending() {
  const pending: { resolve: ConfirmResolver | null } = { resolve: null }
  mockConfirmManualImport.mockReturnValue(
    new Promise<{ success: boolean }>((resolve) => {
      pending.resolve = resolve
    })
  )
  return pending
}

/** Put the store in the processing step for `job-123` with the given poll result, then render. */
function renderProcessingWithStatus(status: Record<string, unknown>) {
  mockGetManualImportStatus.mockResolvedValue(status)
  useManualImportStore.setState({
    isModalOpen: true,
    step: 'processing',
    jobId: 'job-123',
  })
  render(<ManualImportModal />)
}

describe('ManualImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store to initial state
    useManualImportStore.setState(useManualImportStore.getInitialState())
  })

  describe('when modal is closed', () => {
    it('renders nothing when isModalOpen is false', () => {
      render(<ManualImportModal />)

      expect(screen.queryByText('Manual Import')).not.toBeInTheDocument()
    })
  })

  describe('when modal is open - input step', () => {
    beforeEach(() => {
      useManualImportStore.setState({ isModalOpen: true, step: 'input' })
    })

    it('renders modal with title', () => {
      render(<ManualImportModal />)

      expect(screen.getByText('Manual Import')).toBeInTheDocument()
    })

    it('renders source URL input field', () => {
      render(<ManualImportModal />)

      expect(screen.getByPlaceholderText(/example.com\/reviews/i)).toBeInTheDocument()
    })

    it('renders paste reviews textarea', () => {
      render(<ManualImportModal />)

      expect(screen.getByPlaceholderText(/paste the reviews/i)).toBeInTheDocument()
    })

    it('displays character counter', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/0 \/ 10,000/)).toBeInTheDocument()
    })

    it('updates character counter when text is entered', async () => {
      const user = userEvent.setup()
      render(<ManualImportModal />)

      const textarea = screen.getByPlaceholderText(/paste the reviews/i)
      await user.type(textarea, 'Hello')

      expect(screen.getByText(/5 \/ 10,000/)).toBeInTheDocument()
    })

    it('shows detected source when valid URL is entered', async () => {
      const user = userEvent.setup()
      render(<ManualImportModal />)

      const urlInput = screen.getByPlaceholderText(/example.com\/reviews/i)
      await user.type(urlInput, 'https://g2.com/products/example/reviews')

      expect(screen.getByText(/Detected: G2/i)).toBeInTheDocument()
    })

    it('disables Parse button when URL is empty', () => {
      useManualImportStore.setState({ rawText: 'Some review text' })
      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      expect(parseButton).toBeDisabled()
    })

    it('disables Parse button when text is empty', () => {
      useManualImportStore.setState({ sourceUrl: 'https://example.com' })
      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      expect(parseButton).toBeDisabled()
    })

    it('enables Parse button when both URL and text are provided', () => {
      useManualImportStore.setState({
        sourceUrl: 'https://example.com',
        rawText: 'Some review text',
      })
      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      expect(parseButton).not.toBeDisabled()
    })

    it('shows error when text exceeds max characters', async () => {
      const longText = 'a'.repeat(10001)
      useManualImportStore.setState({ rawText: longText })
      render(<ManualImportModal />)

      expect(screen.getByText(/exceeds maximum/i)).toBeInTheDocument()
    })

    it('closes modal when Cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<ManualImportModal />)

      const cancelButton = screen.getByRole('button', { name: /cancel/i })
      await user.click(cancelButton)

      expect(useManualImportStore.getState().isModalOpen).toBe(false)
    })

    it('closes modal when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<ManualImportModal />)

      // The close button should be accessible via aria-label or similar
      const closeButton = at(screen.getAllByRole('button'), 0)
      await user.click(closeButton)

      expect(useManualImportStore.getState().isModalOpen).toBe(false)
    })
  })

  describe('when modal is open - processing step', () => {
    beforeEach(() => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'processing',
        jobId: 'test-job-123',
      })
    })

    it('shows processing message', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/parsing reviews with ai/i)).toBeInTheDocument()
    })

    it('shows time estimate message', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/30-60 seconds/i)).toBeInTheDocument()
    })
  })

  describe('when modal is open - preview step', () => {
    beforeEach(() => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: 'test-job-123',
        sourceOrigin: 'webscraper',
        parsedReviews: [
          { text: 'Great product!', rating: 5, author: 'John', date: '2026-01-05', title: 'Amazing' },
          { text: 'Good service', rating: 4, author: 'Jane', date: '2026-01-04', title: null },
        ],
        unparsedSections: [],
      })
    })

    it('shows review count', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/2 reviews found/i)).toBeInTheDocument()
    })

    it('shows source origin', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/Source: webscraper/i)).toBeInTheDocument()
    })

    it('renders review cards', () => {
      render(<ManualImportModal />)

      expect(screen.getByDisplayValue('Great product!')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Good service')).toBeInTheDocument()
    })

    it('shows Add Review Manually button', () => {
      render(<ManualImportModal />)

      expect(screen.getByRole('button', { name: /add review manually/i })).toBeInTheDocument()
    })

    it('shows Import button with review count', () => {
      render(<ManualImportModal />)

      expect(screen.getByRole('button', { name: /import 2 reviews/i })).toBeInTheDocument()
    })

    it('shows Back button', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/back to edit/i)).toBeInTheDocument()
    })

    it('goes back to input step when Back is clicked', async () => {
      const user = userEvent.setup()
      render(<ManualImportModal />)

      const backButton = screen.getByText(/back to edit/i)
      await user.click(backButton)

      expect(useManualImportStore.getState().step).toBe('input')
    })
  })

  describe('when no reviews are parsed', () => {
    beforeEach(() => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        parsedReviews: [],
        unparsedSections: ['Some unparsed text'],
      })
    })

    it('shows no reviews detected message', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/no reviews detected/i)).toBeInTheDocument()
    })

    it('shows warning about unparsed content', () => {
      render(<ManualImportModal />)

      expect(screen.getByText(/no reviews could be detected/i)).toBeInTheDocument()
    })
  })

  describe('API interactions', () => {
    beforeEach(() => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'input',
        sourceUrl: 'https://example.com/reviews',
        rawText: 'Great product! 5 stars',
      })
    })

    it('calls startManualImportParse when Parse is clicked', async () => {
      mockStartManualImportParse.mockResolvedValue({
        success: true,
        job_id: 'job-123',
        source_origin: 'webscraper',
      })

      await clickParse()

      expect(mockStartManualImportParse).toHaveBeenCalledWith(
        'https://example.com/reviews',
        'Great product! 5 stars'
      )
    })

    it('shows error when parse fails', async () => {
      mockStartManualImportParse.mockResolvedValue({
        success: false,
        error: 'Source URL is required',
      })

      await clickParse()

      await waitFor(() => {
        expect(screen.getByText(/source url is required/i)).toBeInTheDocument()
      })
    })

    it('shows error when parse throws exception', async () => {
      mockStartManualImportParse.mockRejectedValue(new Error('Network error'))

      await clickParse()

      await waitFor(() => {
        expect(screen.getByText(/failed to start parsing/i)).toBeInTheDocument()
      })
    })
  })

  describe('confirm flow', () => {
    beforeEach(() => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: 'job-123',
        sourceOrigin: 'webscraper',
        parsedReviews: [
          { text: 'Great product!', rating: 5, author: 'John', date: '2026-01-05', title: 'Amazing' },
        ],
        unparsedSections: [],
      })
    })

    // This suite shares ONE jsdom across every test file (`singleFork` in
    // vitest.config.ts), so a `window.location` replaced here and left in place
    // leaks into every file that runs after this one — where `location.origin` is
    // then undefined. It cost the room-vote QR tests an afternoon: they passed
    // alone and failed in the full run, because the component reads the live
    // origin to build the address a phone opens.
    //
    // Captured in `beforeEach` rather than at collection time, and for the same
    // reason the restore exists at all: at collection this file has not run yet,
    // but earlier FILES have, so a snapshot taken then could preserve a value one
    // of them leaked. Taken per test, it is whatever was in place immediately
    // before this test replaced it.
    const originalLocation: { value: Location } = { value: window.location }

    beforeEach(() => {
      originalLocation.value = window.location
    })

    afterEach(() => {
      Object.defineProperty(window, 'location', { value: originalLocation.value, writable: true })
    })

    it('calls confirmManualImport when Import is clicked', async () => {
      mockConfirmManualImport.mockResolvedValue({ success: true, imported_count: 1 })

      // Mock window.location.reload
      const reloadMock = vi.fn()
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
      })

      await clickImportOne()

      await waitFor(() => {
        expect(mockConfirmManualImport).toHaveBeenCalledWith('job-123', [
          { text: 'Great product!', rating: 5, author: 'John', date: '2026-01-05', title: 'Amazing' },
        ])
      })
    })

    it('shows error when confirm fails', async () => {
      mockConfirmManualImport.mockResolvedValue({
        success: false,
        error: 'Failed to import reviews',
      })

      await clickImportOne()

      await waitFor(() => {
        expect(useManualImportStore.getState().processingError).toBe('Failed to import reviews')
      })
    })

    it('shows error when confirm throws exception', async () => {
      mockConfirmManualImport.mockRejectedValue(new Error('Network error'))

      await clickImportOne()

      await waitFor(() => {
        expect(useManualImportStore.getState().processingError).toBe('Failed to import reviews')
      })
    })

    /**
     * The confirm route answers 400 "Reviews 1, 2 … are missing dates" for any
     * dateless review, and the AI parse leaves the date empty when the pasted text
     * has none. The preview used to enable Import anyway and swallow the error
     * (it was rendered only on the input step), so the click silently did nothing
     * (QA s1, production 2.13.00).
     */
    const withUndated = () => useManualImportStore.setState({
      parsedReviews: [
        { text: 'Dated review', rating: null, author: null, date: '2026-01-05', title: null },
        { text: 'Undated review', rating: null, author: null, date: null, title: null },
      ],
    })

    it('blocks Import and says why while a review has no date', () => {
      withUndated()
      render(<ManualImportModal />)
      expect(screen.getByRole('button', { name: /import 2 reviews/i })).toBeDisabled()
      expect(screen.getByText('1 review needs a date before the import can run.')).toBeInTheDocument()
      expect(at(screen.getAllByLabelText('Review date (required)'), 1)).toHaveAttribute('aria-invalid', 'true')
    })

    it('enables Import once every review has a date', async () => {
      withUndated()
      const user = userEvent.setup()
      render(<ManualImportModal />)
      await user.type(at(screen.getAllByLabelText('Review date (required)'), 1), '2026-01-06')
      expect(screen.getByRole('button', { name: /import 2 reviews/i })).toBeEnabled()
      expect(screen.queryByText(/needs a date/)).not.toBeInTheDocument()
    })

    /**
     * The parse now gives a review with no date in the text the import date and
     * flags it (`date_defaulted`, manual_import_processor.py), so a plain paste
     * imports in one click — and the preview says which dates were filled in.
     */
    describe('dates the parse defaulted to the import date', () => {
      const withDefaulted = () => useManualImportStore.setState({
        parsedReviews: [
          { text: 'Dated review', rating: null, author: null, date: '2026-01-05', date_defaulted: false, title: null },
          { text: 'Undated review', rating: null, author: null, date: '2026-10-06', date_defaulted: true, title: null },
        ],
      })

      it('lets Import run and says the import date was used', () => {
        withDefaulted()
        render(<ManualImportModal />)
        expect(screen.getByRole('button', { name: /import 2 reviews/i })).toBeEnabled()
        expect(screen.getByText(
          "1 review had no date in the text, so it uses today's import date. You can change it below.",
        )).toBeInTheDocument()
        const defaulted = at(screen.getAllByLabelText('Review date (required)'), 1)
        expect(defaulted).toHaveValue('2026-10-06')
        expect(defaulted).toHaveAccessibleDescription('No date found: set to the import date')
      })

      it('keeps the date editable, and an edited date is no longer called a default', async () => {
        withDefaulted()
        const user = userEvent.setup()
        render(<ManualImportModal />)
        const defaulted = at(screen.getAllByLabelText('Review date (required)'), 1)
        await user.clear(defaulted)
        await user.type(defaulted, '2026-09-30')

        expect(at(useManualImportStore.getState().parsedReviews, 1)).toMatchObject({ date: '2026-09-30', date_defaulted: false })
        expect(screen.queryByText(/had no date in the text/)).not.toBeInTheDocument()
        expect(screen.queryByText('No date found: set to the import date')).not.toBeInTheDocument()
      })
    })

    it("shows the server's reason in the preview when confirm is refused", async () => {
      mockConfirmManualImport.mockRejectedValue(new ApiError(400, 'Review 1 is missing a date. All reviews must have a date.'))

      await clickImportOne()

      expect(await screen.findByRole('alert')).toHaveTextContent('Review 1 is missing a date. All reviews must have a date.')
      expect(screen.getByRole('button', { name: /import 1 review/i })).toBeEnabled()
    })

    it('filters out empty reviews before confirming', async () => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: 'job-123',
        parsedReviews: [
          { text: 'Valid review', rating: 5, author: null, date: '2026-01-06', title: null },
          { text: '', rating: null, author: null, date: null, title: null }, // Empty - should be filtered
          { text: '   ', rating: null, author: null, date: null, title: null }, // Whitespace only - should be filtered
        ],
      })
      mockConfirmManualImport.mockResolvedValue({ success: true, imported_count: 1 })

      await clickImportOne()

      await waitFor(() => {
        expect(mockConfirmManualImport).toHaveBeenCalledWith('job-123', [
          { text: 'Valid review', rating: 5, author: null, date: '2026-01-06', title: null },
        ])
      })
    })

    it('does not call confirm when jobId is null', async () => {
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: null,
        parsedReviews: [
          { text: 'Review', rating: 5, author: null, date: null, title: null },
        ],
      })

      await clickImportOne()

      expect(mockConfirmManualImport).not.toHaveBeenCalled()
    })

    it('shows Importing... state while confirm is in flight', async () => {
      // Regression: previously isConfirming was tracked via useRef, which
      // mutates without re-rendering, so the button never showed the loading
      // state. After moving to useState, the button should re-render to show
      // the spinner + "Importing..." label while the API call is pending.
      const pending = makeConfirmPending()

      await clickImportOne()

      // While the promise is unresolved, the button label should change.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /importing/i })).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /import 1 review/i })).not.toBeInTheDocument()

      // Resolve so the test can clean up.
      pending.resolve?.({ success: false })
    })

    it('prevents double-submit when import button is clicked twice rapidly', async () => {
      // The disabled + "Importing…" button (driven by the isConfirming state)
      // is what blocks the second click; the in-handler guard alone can't,
      // because the second click's closure still sees the pre-update state.
      const pending = makeConfirmPending()

      const user = await clickImportOne()

      // Second click should be a no-op while the first is in flight.
      const importingButton = await screen.findByRole('button', { name: /importing/i })
      await user.click(importingButton)

      expect(mockConfirmManualImport).toHaveBeenCalledTimes(1)

      pending.resolve?.({ success: false })
    })
  })

  describe('polling', () => {
    it('polls for status when in processing step', async () => {
      renderProcessingWithStatus({ status: 'processing' })

      await waitFor(() => {
        expect(mockGetManualImportStatus).toHaveBeenCalledWith('job-123')
      })
    })

    it('transitions to preview when completed', async () => {
      renderProcessingWithStatus({
        status: 'completed',
        reviews: [{ text: 'Parsed review', rating: 5, author: null, date: null, title: null }],
        unparsed_sections: [],
        source_origin: 'webscraper',
      })

      await waitFor(() => {
        expect(useManualImportStore.getState().step).toBe('preview')
      })
    })

    it('shows error when polling returns failed', async () => {
      renderProcessingWithStatus({
        status: 'failed',
        error: 'Parsing failed',
      })

      await waitFor(() => {
        expect(useManualImportStore.getState().step).toBe('input')
        expect(useManualImportStore.getState().processingError).toBe('Parsing failed')
      })
    })
  })
})
