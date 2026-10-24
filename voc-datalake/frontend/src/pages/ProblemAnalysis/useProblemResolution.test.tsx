/**
 * @fileoverview Tests for useProblemResolution — per-key pending (issue #159).
 *
 * Pending state must be scoped to the key being toggled: resolving one
 * problem must not lock every resolve button on the page, and rapid
 * double-clicks on the SAME key must still be dropped (SET/REMOVE race
 * protection).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  clientApiModule,
  expectNoPendingKeys,
  holdToggle,
  holdTwoToggles,
  problemAnalysisApiMocks,
  toggleAndExpectPending,
} from './problem-analysis-fixtures'
import { createQueryWrapper } from '../Categories/categories-fixtures'

vi.mock('../../api/client', () => clientApiModule())

import { useProblemResolution } from './useProblemResolution'

const { getResolvedProblems, setProblemResolved } = problemAnalysisApiMocks

function renderResolution() {
  return renderHook(() => useProblemResolution(true), { wrapper: createQueryWrapper() })
}

describe('useProblemResolution per-key pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getResolvedProblems.mockResolvedValue({ resolved: {} })
  })

  it('marks only the toggled key as pending', async () => {
    const { holder } = holdToggle()
    const { result } = renderResolution()

    await toggleAndExpectPending(result, 'cat|sub|a')
    expect(result.current.pendingKeys.has('cat|sub|b')).toBe(false)

    act(() => holder.resolve({ success: true }))
    await expectNoPendingKeys(result)
  })

  it('drops a second toggle of the SAME key while it is in flight', async () => {
    const { holder } = holdToggle()
    const { result } = renderResolution()

    await toggleAndExpectPending(result, 'cat|sub|a')
    act(() => result.current.toggleResolved('cat|sub|a', false))

    expect(setProblemResolved).toHaveBeenCalledTimes(1)
    act(() => holder.resolve({ success: true }))
    await expectNoPendingKeys(result)
  })

  it('allows toggling a DIFFERENT key while another is in flight', async () => {
    const [first, second] = holdTwoToggles()
    const { result } = renderResolution()

    await toggleAndExpectPending(result, 'cat|sub|a')
    await toggleAndExpectPending(result, 'cat|sub|b')
    expect(setProblemResolved).toHaveBeenCalledTimes(2)

    act(() => {
      first.holder.resolve({ success: true })
      second.holder.resolve({ success: true })
    })
    await expectNoPendingKeys(result)
  })

  it('clears the key from pending when the mutation fails', async () => {
    setProblemResolved.mockRejectedValue(new Error('boom'))

    const { result } = renderResolution()

    act(() => result.current.toggleResolved('cat|sub|a', true))

    await waitFor(() => expect(result.current.toggleFailed).toBe(true))
    // The key must be re-toggleable after a failure, not stuck pending.
    expect(result.current.pendingKeys.has('cat|sub|a')).toBe(false)
  })

  it('surfaces an early failure even when a later toggle succeeds', async () => {
    // Regression (review round 1): mutation.isError only reflects the LATEST
    // mutate() call, so key A's failure was masked once key B succeeded.
    const [failing, succeeding] = holdTwoToggles()
    const { result } = renderResolution()

    await toggleAndExpectPending(result, 'cat|sub|a')
    await toggleAndExpectPending(result, 'cat|sub|b')

    // B succeeds AFTER A fails — A's failure must still be visible.
    act(() => failing.holder.reject(new Error('boom')))
    await waitFor(() => expect(result.current.pendingKeys.has('cat|sub|a')).toBe(false))
    act(() => succeeding.holder.resolve({ success: true }))
    await expectNoPendingKeys(result)

    expect(result.current.toggleFailed).toBe(true)

    act(() => result.current.dismissToggleError())
    expect(result.current.toggleFailed).toBe(false)
  })
})
