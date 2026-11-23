/**
 * @fileoverview First insights' reads (useFirstInsights.ts): this import's items only (a reviews import's tag, a
 * survey's form channel), the summary polled until every row is analysed, then the sentiment split, the top three
 * categories, three quotes and a survey's NPS from its Results; none analysed in the window: imported before.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createQueryWrapper } from '@test/query-client'

type Read = (...args: unknown[]) => Promise<unknown>
const getSummary = vi.fn<Read>()
const getSentiment = vi.fn<Read>()
const getCategories = vi.fn<Read>()
const getFeedback = vi.fn<Read>()
const getResults = vi.fn<Read>()
vi.mock('../../../api/client', () => ({ api: {
  getSummary: (...args: unknown[]) => getSummary(...args),
  getSentiment: (...args: unknown[]) => getSentiment(...args),
  getCategories: (...args: unknown[]) => getCategories(...args),
  getFeedback: (...args: unknown[]) => getFeedback(...args),
} }))
vi.mock('../../../api/feedbackFormsV2Api', () => ({ feedbackFormsV2Api: {
  getResults: (...args: unknown[]) => getResults(...args),
} }))
import { useFirstInsights } from './useFirstInsights'
import type { ImportOutcome } from './useImportWizard'

const SURVEY: ImportOutcome = { target: 'survey', accepted: 4, refused: [], refusedCount: 0, filter: { channel: 'form_ff_1' },
  source: 'feedback_form', formId: 'ff_1', npsQuestionIds: ['q_nps'] }
const REVIEWS: ImportOutcome = { target: 'reviews', accepted: 3, refused: [], refusedCount: 0,
  filter: { tag: 'import-2026-11-21-abcd' }, source: 'manual_import', npsQuestionIds: [] }

describe('useFirstInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSentiment.mockResolvedValue({ percentages: { positive: 75, negative: 25 } })
    getCategories.mockResolvedValue({ categories: { a: 1, b: 5, c: 3, d: 2 } })
    getFeedback.mockResolvedValue({ items: [{ feedback_id: 'f1', original_text: 'One' }, { feedback_id: 'f2', original_text: 'Two' }] })
    getResults.mockResolvedValue({ questions: { q_nps: { distribution: { 10: 2, 9: 1, 3: 1 } } } })
  })

  it('reads a survey once every row is analysed, its NPS from the form', async () => {
    getSummary.mockResolvedValue({ total_feedback: 4 })
    const { result } = renderHook(() => useFirstInsights(SURVEY), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(result.current.nps).toBe(50))
    expect(result.current).toMatchObject({ processed: 4, ready: true, slow: false, sentiment: { positive: 75, negative: 25 },
      categories: [['b', 5], ['c', 3], ['d', 2]], quotes: [{ id: 'f1', text: 'One' }, { id: 'f2', text: 'Two' }] })
    expect(getResults).toHaveBeenCalledWith('ff_1', expect.objectContaining({ days: null, includeTest: false }))
  })

  it("reads only the survey form's channel", async () => {
    getSummary.mockResolvedValue({ total_feedback: 4 })
    const { result } = renderHook(() => useFirstInsights(SURVEY), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(result.current.quotes).toHaveLength(2))
    expect(getSummary).toHaveBeenCalledWith({ days: 7 }, 'feedback_form', { channel: 'form_ff_1' })
    expect(getFeedback).toHaveBeenCalledWith({ days: 7, source: 'feedback_form', channel: 'form_ff_1', limit: 3 })
  })

  it('waits while rows are still being analysed, and reads a reviews import by its tag', async () => {
    getSummary.mockResolvedValue({ total_feedback: 1 })
    const { result } = renderHook(() => useFirstInsights(REVIEWS), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(result.current.processed).toBe(1))
    expect(result.current).toMatchObject({ ready: false, nps: null })
    expect(getSummary).toHaveBeenCalledWith({ days: 7 }, 'manual_import', { tag: 'import-2026-11-21-abcd' })
    expect(getResults).not.toHaveBeenCalled()
  })

  it('says the rows were imported before when the window ends with none analysed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      getSummary.mockResolvedValue({ total_feedback: 0 })
      const { result } = renderHook(() => useFirstInsights(REVIEWS), { wrapper: createQueryWrapper() })
      await waitFor(() => expect(getSummary).toHaveBeenCalledWith({ days: 7 }, 'manual_import', { tag: 'import-2026-11-21-abcd' }))
      expect(result.current).toMatchObject({ alreadyImported: false, ready: false })
      act(() => { vi.advanceTimersByTime(5 * 60 * 1000) })
      await waitFor(() => expect(result.current).toMatchObject({ alreadyImported: true, ready: false, slow: false }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps saying a survey is slow when the window ends with none analysed: its rows are never imported before (Q33)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      getSummary.mockResolvedValue({ total_feedback: 0 })
      const { result } = renderHook(() => useFirstInsights(SURVEY), { wrapper: createQueryWrapper() })
      await waitFor(() => expect(getSummary).toHaveBeenCalledWith({ days: 7 }, 'feedback_form', { channel: 'form_ff_1' }))
      act(() => { vi.advanceTimersByTime(5 * 60 * 1000) })
      await waitFor(() => expect(result.current).toMatchObject({ alreadyImported: false, ready: false, slow: true }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads nothing more before the first row is analysed', async () => {
    getSummary.mockResolvedValue({ total_feedback: 0 })
    const { result } = renderHook(() => useFirstInsights(REVIEWS), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(getSummary).toHaveBeenCalledWith({ days: 7 }, 'manual_import', { tag: 'import-2026-11-21-abcd' }))
    expect(result.current).toMatchObject({ processed: 0, ready: false, categories: [], quotes: [] })
    expect(getSentiment).not.toHaveBeenCalled()
  })
})
