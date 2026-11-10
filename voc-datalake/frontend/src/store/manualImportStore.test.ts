/**
 * @fileoverview Tests for manualImportStore Zustand store.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { MANUAL_IMPORT_MAX_CHARACTERS, useManualImportStore } from './manualImportStore'
import { at } from '@test/defined'

describe('manualImportStore', () => {
  beforeEach(() => {
    // The store's own initial state (zustand v5), so the reset cannot drift from it.
    useManualImportStore.setState(useManualImportStore.getInitialState())
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
      expect(at(state.parsedReviews, 0).text).toBe('Updated')
      expect(at(state.parsedReviews, 0).rating).toBe(5)
    })

    it('preserves other review fields when updating', () => {
      const { setParsedReviews, updateReview } = useManualImportStore.getState()
      setParsedReviews([
        { text: 'Original', rating: 3, author: 'John', date: '2026-01-01', title: 'Title' },
      ])

      updateReview(0, { rating: 5 })

      const state = useManualImportStore.getState()
      expect(at(state.parsedReviews, 0).text).toBe('Original')
      expect(at(state.parsedReviews, 0).author).toBe('John')
      expect(at(state.parsedReviews, 0).rating).toBe(5)
    })

    it('ignores an out-of-range index instead of inserting a partial review', () => {
      const { setParsedReviews, updateReview } = useManualImportStore.getState()
      const reviews = [{ text: 'Only', rating: 3, author: null, date: null, title: null }]
      setParsedReviews(reviews)

      updateReview(1, { text: 'Ghost' })
      updateReview(-1, { text: 'Ghost' })

      expect(useManualImportStore.getState().parsedReviews).toStrictEqual(reviews)
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
      expect(at(state.parsedReviews, 0).text).toBe('Review 2')
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
      expect(at(state.parsedReviews, 0).text).toBe('Existing')
      expect(at(state.parsedReviews, 1).text).toBe('')
    })
  })

  describe('UI state actions', () => {
    it('sets modal open state', () => {
      const { setIsModalOpen } = useManualImportStore.getState()

      setIsModalOpen(true)

      expect(useManualImportStore.getState().isModalOpen).toBe(true)
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

      expect(useManualImportStore.getState()).toMatchObject({
        sourceUrl: '',
        rawText: '',
        parsedReviews: [],
        jobId: null,
        sourceOrigin: null,
        lastUpdated: null,
      })
    })
  })

  describe('resetModal', () => {
    it('resets modal UI state', () => {
      const state = useManualImportStore.getState()
      state.setIsModalOpen(true)
      state.setProcessingError('Error')
      state.setStep('preview')

      state.resetModal()

      const newState = useManualImportStore.getState()
      expect(newState.isModalOpen).toBe(false)
      expect(newState.processingError).toBeNull()
      expect(newState.step).toBe('input')
    })
  })
})

/**
 * Wave 4 live finding: "Paste reviews" opened with "your draft was longer than 10,000
 * characters, so it was cleared" — for a draft stored in an earlier session. An
 * over-limit text is no longer stored, and one already stored is dropped on load
 * without a notice; the notice is only for a clear made in this session.
 */
describe('manualImportStore over-limit drafts', () => {
  const tooLong = 'x'.repeat(MANUAL_IMPORT_MAX_CHARACTERS + 1)
  const options = () => useManualImportStore.persist.getOptions()

  it('never stores a text over the limit, but keeps one within it', () => {
    const state = useManualImportStore.getState()
    const partialize = options().partialize
    expect(partialize?.({ ...state, rawText: tooLong })).toMatchObject({ rawText: '' })
    expect(partialize?.({ ...state, rawText: 'Great shop' })).toMatchObject({ rawText: 'Great shop' })
  })

  it('drops a stored over-limit draft on load, with no notice', () => {
    const current = useManualImportStore.getState()
    const merged = options().merge?.({ rawText: tooLong, sourceUrl: 'https://shop.example.com' }, current)
    expect(merged).toMatchObject({ rawText: '', sourceUrl: '', draftDropped: false })
  })
})
