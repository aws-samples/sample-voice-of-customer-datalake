/**
 * @fileoverview For the specs that check a self-clearing note ("Saved!", a success banner) cancels its timer when
 * the view goes away: a timer left behind fires after the test environment is torn down and fails the run with an
 * unhandled error.
 */
import { cleanup } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * Run `show` (which renders and makes the note appear), then unmount everything: whether a `ms` timer was started,
 * and whether it was still pending before the unmount and cancelled by it.
 */
export async function timerOnCleanup(ms: number, show: () => Promise<unknown>) {
  const set = vi.spyOn(globalThis, 'setTimeout')
  const clear = vi.spyOn(globalThis, 'clearTimeout')
  try {
    await show()
    const index = set.mock.calls.findIndex(([, delay]) => delay === ms)
    const id: unknown = set.mock.results[index]?.value
    const cleared = () => clear.mock.calls.some(([cancelled]) => cancelled === id)
    const pendingBefore = index >= 0 && !cleared()
    cleanup()
    return { started: index >= 0, pendingBefore, cancelledByCleanup: cleared() }
  } finally {
    set.mockRestore()
    clear.mockRestore()
  }
}
