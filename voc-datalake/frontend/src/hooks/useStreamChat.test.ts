/**
 * @fileoverview Regression tests for useStreamChat hook.
 *
 * Covers issue #265 defect 2: stream error events must surface the server's
 * reason string, not fall through to "Unknown error".
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStreamChat } from './useStreamChat'

// ---------------------------------------------------------------------------
// Minimal stream-client mock — only what these tests need.
// ---------------------------------------------------------------------------

vi.mock('../api/streamClient', () => ({
  streamVocChat: vi.fn(),
  streamProjectChat: vi.fn(),
}))

import { streamVocChat } from '../api/streamClient'
import type { StreamEvent } from '../api/streamClient'

/**
 * Build an async generator that yields the given events then returns.
 *
 * Typed as `AsyncGenerator<StreamEvent>` so `vi.mocked(streamVocChat)` accepts
 * the value directly — the alternative would be an `as` cast on the mock,
 * which the repo bans.
 */
async function* makeStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event
}

describe('useStreamChat — error event field mapping (issue #265 defect 2)', () => {
  it('surfaces the `error` field from an error event, not `content`', async () => {
    // The server sends the reason in `error`.  The old code read `content`
    // so the reason was always missing and "Unknown error" was shown.
    const distinctMessage = 'History exceeds the 50-message server limit'

    vi.mocked(streamVocChat).mockReturnValue(
      makeStream([{ type: 'error', error: distinctMessage }])
    )

    const { result } = renderHook(() => useStreamChat())

    await act(async () => {
      await result.current.sendMessage('hello', {})
    })

    // The exact server-supplied reason must surface — asserting only that the
    // error is non-empty would pass on the buggy code too (it returns
    // "Unknown error"), so we check the actual text.
    expect(result.current.error).toBe(distinctMessage)
  })

  it('falls back to `content` when `error` is absent', async () => {
    // Some older error shapes only carry `content`; the hook must still
    // surface something meaningful rather than "Unknown error".
    const fallbackMessage = 'A content-only error'

    vi.mocked(streamVocChat).mockReturnValue(
      makeStream([{ type: 'error', content: fallbackMessage }])
    )

    const { result } = renderHook(() => useStreamChat())

    await act(async () => {
      await result.current.sendMessage('hello', {})
    })

    expect(result.current.error).toBe(fallbackMessage)
  })

  it('falls back to "Unknown error" when neither field is present', async () => {
    vi.mocked(streamVocChat).mockReturnValue(
      makeStream([{ type: 'error' }])
    )

    const { result } = renderHook(() => useStreamChat())

    await act(async () => {
      await result.current.sendMessage('hello', {})
    })

    expect(result.current.error).toBe('Unknown error')
  })
})
