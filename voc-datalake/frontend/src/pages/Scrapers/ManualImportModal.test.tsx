/**
 * @fileoverview Tests for ManualImportModal component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManualImportModal from './ManualImportModal'
import { useManualImportStore } from '../../store/manualImportStore'

// Mock API client
const mockStartManualImportParse = vi.fn()
const mockGetManualImportStatus = vi.fn()
const mockConfirmManualImport = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    startManualImportParse: (...args: unknown[]) => mockStartManualImportParse(...args),
    getManualImportStatus: (...args: unknown[]) => mockGetManualImportStatus(...args),
    confirmManualImport: (...args: unknown[]) => mockConfirmManualImport(...args),
  },
}))

describe('ManualImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store to initial state
    useManualImportStore.setState({
      sourceUrl: '',
      rawText: '',
      parsedReviews: [],
      unparsedSections: [],
      jobId: null,
      sourceOrigin: null,
      lastUpdated: null,
      isModalOpen: false,
      isProcessing: false,
      processingError: null,
      step: 'input',
    })
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

      const closeButtons = screen.getAllByRole('button')
      const xButton = closeButtons.find(btn => btn.querySelector('svg'))
      if (xButton) {
        await user.click(xButton)
      }

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
      const user = userEvent.setup()
      mockStartManualImportParse.mockResolvedValue({
        success: true,
        job_id: 'job-123',
        source_origin: 'webscraper',
      })

      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      await user.click(parseButton)

      expect(mockStartManualImportParse).toHaveBeenCalledWith(
        'https://example.com/reviews',
        'Great product! 5 stars'
      )
    })

    it('shows error when parse fails', async () => {
      const user = userEvent.setup()
      mockStartManualImportParse.mockResolvedValue({
        success: false,
        message: 'Invalid URL',
      })

      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      await user.click(parseButton)

      await waitFor(() => {
        expect(screen.getByText(/invalid url/i)).toBeInTheDocument()
      })
    })

    it('shows error when parse throws exception', async () => {
      const user = userEvent.setup()
      mockStartManualImportParse.mockRejectedValue(new Error('Network error'))

      render(<ManualImportModal />)

      const parseButton = screen.getByRole('button', { name: /parse reviews/i })
      await user.click(parseButton)

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

    it('calls confirmManualImport when Import is clicked', async () => {
      const user = userEvent.setup()
      mockConfirmManualImport.mockResolvedValue({ success: true, imported_count: 1 })
      
      // Mock window.location.reload
      const reloadMock = vi.fn()
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
      })

      render(<ManualImportModal />)

      const importButton = screen.getByRole('button', { name: /import 1 review/i })
      await user.click(importButton)

      await waitFor(() => {
        expect(mockConfirmManualImport).toHaveBeenCalledWith('job-123', [
          { text: 'Great product!', rating: 5, author: 'John', date: '2026-01-05', title: 'Amazing' },
        ])
      })
    })

    it('shows error when confirm fails', async () => {
      const user = userEvent.setup()
      mockConfirmManualImport.mockResolvedValue({
        success: false,
        message: 'Import failed',
      })

      render(<ManualImportModal />)

      const importButton = screen.getByRole('button', { name: /import 1 review/i })
      await user.click(importButton)

      await waitFor(() => {
        expect(useManualImportStore.getState().processingError).toBe('Import failed')
      })
    })

    it('shows error when confirm throws exception', async () => {
      const user = userEvent.setup()
      mockConfirmManualImport.mockRejectedValue(new Error('Network error'))

      render(<ManualImportModal />)

      const importButton = screen.getByRole('button', { name: /import 1 review/i })
      await user.click(importButton)

      await waitFor(() => {
        expect(useManualImportStore.getState().processingError).toBe('Failed to import reviews')
      })
    })

    it('filters out empty reviews before confirming', async () => {
      const user = userEvent.setup()
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: 'job-123',
        parsedReviews: [
          { text: 'Valid review', rating: 5, author: null, date: null, title: null },
          { text: '', rating: null, author: null, date: null, title: null }, // Empty - should be filtered
          { text: '   ', rating: null, author: null, date: null, title: null }, // Whitespace only - should be filtered
        ],
      })
      mockConfirmManualImport.mockResolvedValue({ success: true, imported_count: 1 })

      render(<ManualImportModal />)

      const importButton = screen.getByRole('button', { name: /import 1 review/i })
      await user.click(importButton)

      await waitFor(() => {
        expect(mockConfirmManualImport).toHaveBeenCalledWith('job-123', [
          { text: 'Valid review', rating: 5, author: null, date: null, title: null },
        ])
      })
    })

    it('does not call confirm when jobId is null', async () => {
      const user = userEvent.setup()
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'preview',
        jobId: null,
        parsedReviews: [
          { text: 'Review', rating: 5, author: null, date: null, title: null },
        ],
      })

      render(<ManualImportModal />)

      const importButton = screen.getByRole('button', { name: /import 1 review/i })
      await user.click(importButton)

      expect(mockConfirmManualImport).not.toHaveBeenCalled()
    })
  })

  describe('polling', () => {
    it('polls for status when in processing step', async () => {
      mockGetManualImportStatus.mockResolvedValue({ status: 'processing' })
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'processing',
        jobId: 'job-123',
      })

      render(<ManualImportModal />)

      await waitFor(() => {
        expect(mockGetManualImportStatus).toHaveBeenCalledWith('job-123')
      })
    })

    it('transitions to preview when completed', async () => {
      mockGetManualImportStatus.mockResolvedValue({
        status: 'completed',
        reviews: [{ text: 'Parsed review', rating: 5, author: null, date: null, title: null }],
        unparsed_sections: [],
        source_origin: 'webscraper',
      })
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'processing',
        jobId: 'job-123',
      })

      render(<ManualImportModal />)

      await waitFor(() => {
        expect(useManualImportStore.getState().step).toBe('preview')
      })
    })

    it('shows error when polling returns failed', async () => {
      mockGetManualImportStatus.mockResolvedValue({
        status: 'failed',
        error: 'Parsing failed',
      })
      useManualImportStore.setState({
        isModalOpen: true,
        step: 'processing',
        jobId: 'job-123',
      })

      render(<ManualImportModal />)

      await waitFor(() => {
        expect(useManualImportStore.getState().step).toBe('input')
        expect(useManualImportStore.getState().processingError).toBe('Parsing failed')
      })
    })
  })
})
