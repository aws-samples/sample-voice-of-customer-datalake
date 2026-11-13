/**
 * The feedback read's api function: the series route, encoded, with no query; a
 * malformed answer rejects; its query key sits under the pins root.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prototypeFeedbackQueryKey, prototypePinsQueryKey } from './prototypePinsApi'
import { getPrototypeFeedback } from './prototypeFeedbackSchema'
import { FEEDBACK_ANSWER } from './prototype-feedback-fixtures'

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>() }))

vi.mock('./client', () => ({ fetchApi: mocks.fetchApi }))

describe('getPrototypeFeedback', () => {
  beforeEach(() => {
    mocks.fetchApi.mockReset().mockResolvedValue(FEEDBACK_ANSWER)
  })

  it('reads the series route, encoded, with no query', async () => {
    const feedback = await getPrototypeFeedback('proj 1', 'doc/3')
    expect(mocks.fetchApi).toHaveBeenCalledWith('/projects/proj%201/prototypes/doc%2F3/feedback')
    expect(feedback.pin_count).toBe(2)
  })

  it('rejects a malformed answer', async () => {
    mocks.fetchApi.mockResolvedValue({ pins: [] })
    await expect(getPrototypeFeedback('proj_1', 'doc_v3')).rejects.toThrow('malformed')
  })

  it('keys the view under the pins root, so a pin change refreshes it', () => {
    expect(prototypeFeedbackQueryKey('p', 'd')).toStrictEqual([...prototypePinsQueryKey('p', 'd'), 'feedback'])
  })
})
