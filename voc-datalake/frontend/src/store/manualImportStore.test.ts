/**
 * @fileoverview Tests for manualImportStore Zustand store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useManualImportStore } from './manualImportStore'

const initialState = {
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
  step: 'input' as const,
}

describe('manualImportStore', () => {
  beforeEach(() => {
    useManualImportStore.setState(initialState)
  })

  describe('setSourceUrl', () => {
    it('sets source URL and updates lastUpdated', () => {
      const { setSourceUrl } = useManualImportStore.getState()

      setSourceUrl('https://example.com/review/example.com')

      const state = useManualImportStore.getState()
      expect(state.sourceUrl).toBe('https://example.com/review/example.com')
      expect(state.lastUpdated).not.toBeNull()
    })
  })

  describe('setRawText', () => {
    it('sets raw text and updates lastUpdated', () => {
      const { setRawText } = useManualImportStore.getState()

      setRawText('Review 1: Great product!')

      const state = useManualImportStore.getState()
      expect(state.rawText).toBe('Review 1: Great product!')
      expect(state.lastUpdated).not.toBeNull()
    })
  })

  describe('setParsedReviews', () => {
    it('sets parsed reviews array', () => {
      const { setParsedReviews } = useManualImportStore.getState()
      const reviews = [
        { text: 'Great!', rating: 5, author: 'John', date: '2026-01-01', title: 'Amazing' },
      ]

      setParsedReviews(reviews)

      const state = useManualImportStore.getState()
      expect(state.parsedReviews).toStrictEqual(reviews)
    })
  })

  describe('updateReview', () => {
    it('updates review at specific index', () => {
      const { setParsedReviews, updateReview } = useManualImportStore.getState()
      setParsedReviews([
        { text: 'Original', rating: 3, author: null, date: null, title: null },
      ])

      updateReview(0, { text: 'Updated', rating: 5 })

      const state = useManualImportStore.getState()
      expect(state.parsedReviews[0].text).toBe('Updated')
      expect(state.parsedReviews[0].rating).toBe(5)
    })

    it('preserves other review fields when updating', () => {
      const { setParsedReviews, updateReview } = useManualImportStore.getState()
      setParsedReviews([
        { text: 'Original', rating: 3, author: 'John', date: '2026-01-01', title: 'Title' },
      ])

      updateReview(0, { rating: 5 })

      const state = useManualImportStore.getState()
      expect(state.parsedReviews[0].text).toBe('Original')
      expect(state.parsedReviews[0].author).toBe('John')
      expect(state.parsedReviews[0].rating).toBe(5)
    })
  })

  describe('deleteReview', () => {
    it('removes review at specific index', () => {
      const { setParsedReviews, deleteReview } = useManualImportStore.getState()
      setParsedReviews([
        { text: 'Review 1', rating: 5, author: null, date: null, title: null },
        { text: 'Review 2', rating: 4, author: null, date: null, title: null },
      ])

      deleteReview(0)

      const state = useManualImportStore.getState()
      expect(state.parsedReviews).toHaveLength(1)
      expect(state.parsedReviews[0].text).toBe('Review 2')
    })
  })

  describe('addEmptyReview', () => {
    it('adds empty review to the list', () => {
      const { addEmptyReview } = useManualImportStore.getState()

      addEmptyReview()

      const state = useManualImportStore.getState()
      expect(state.parsedReviews).toHaveLength(1)
      expect(state.parsedReviews[0]).toStrictEqual({
        text: '',
        rating: null,
        author: null,
        date: null,
        title: null,
      })
    })

    it('appends to existing reviews', () => {
      const { setParsedReviews, addEmptyReview } = useManualImportStore.getState()
      setParsedReviews([
        { text: 'Existing', rating: 5, author: null, date: null, title: null },
      ])

      addEmptyReview()

      const state = useManualImportStore.getState()
      expect(state.parsedReviews).toHaveLength(2)
      expect(state.parsedReviews[0].text).toBe('Existing')
      expect(state.parsedReviews[1].text).toBe('')
    })
  })

  describe('UI state actions', () => {
    it('sets modal open state', () => {
      const { setIsModalOpen } = useManualImportStore.getState()

      setIsModalOpen(true)

      expect(useManualImportStore.getState().isModalOpen).toBe(true)
    })

    it('sets processing state', () => {
      const { setIsProcessing } = useManualImportStore.getState()

      setIsProcessing(true)

      expect(useManualImportStore.getState().isProcessing).toBe(true)
    })

    it('sets processing error', () => {
      const { setProcessingError } = useManualImportStore.getState()

      setProcessingError('Failed to parse')

      expect(useManualImportStore.getState().processingError).toBe('Failed to parse')
    })

    it('sets step', () => {
      const { setStep } = useManualImportStore.getState()

      setStep('preview')

      expect(useManualImportStore.getState().step).toBe('preview')
    })
  })

  describe('clearDraft', () => {
    it('clears all draft data but preserves UI state', () => {
      const state = useManualImportStore.getState()
      state.setSourceUrl('https://example.com')
      state.setRawText('Some text')
      state.setParsedReviews([{ text: 'Review', rating: 5, author: null, date: null, title: null }])
      state.setJobId('job-123')
      state.setSourceOrigin('webscraper')

      state.clearDraft()

      const newState = useManualImportStore.getState()
      expect(newState.sourceUrl).toBe('')
      expect(newState.rawText).toBe('')
      expect(newState.parsedReviews).toStrictEqual([])
      expect(newState.jobId).toBeNull()
    })

    it('clears source origin and lastUpdated on clearDraft', () => {
      const state = useManualImportStore.getState()
      state.setSourceUrl('https://example.com')
      state.setRawText('Some text')
      state.setParsedReviews([{ text: 'Review', rating: 5, author: null, date: null, title: null }])
      state.setJobId('job-123')
      state.setSourceOrigin('webscraper')

      state.clearDraft()

      const newState = useManualImportStore.getState()
      expect(newState.sourceOrigin).toBeNull()
      expect(newState.lastUpdated).toBeNull()
    })
  })

  describe('resetModal', () => {
    it('resets modal UI state', () => {
      const state = useManualImportStore.getState()
      state.setIsModalOpen(true)
      state.setIsProcessing(true)
      state.setProcessingError('Error')
      state.setStep('preview')

      state.resetModal()

      const newState = useManualImportStore.getState()
      expect(newState.isModalOpen).toBe(false)
      expect(newState.isProcessing).toBe(false)
      expect(newState.processingError).toBeNull()
      expect(newState.step).toBe('input')
    })
  })
})
