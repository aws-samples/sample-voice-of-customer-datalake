/**
 * @fileoverview Fake timers for a tooltip suite (Tooltip, InfoTip, TruncatedText): on for the whole file, and after
 * each test every tooltip closed (Escape) and the skip window over, so the next test opens with the full delay.
 *
 * @module test/tooltipTimers
 */
import { act, fireEvent } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { SKIP_DELAY_MS } from '../components/Tooltip/tooltipTiming'

/** Move the fake clock on by `ms`, inside `act`. */
export const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})

export function tooltipTimersForSuite(): void {
  beforeAll(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    advance(SKIP_DELAY_MS * 2)
  })
  afterAll(() => {
    vi.useRealTimers()
  })
}
