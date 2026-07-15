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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useProblemResolution } from './useProblemResolution'

const mockGetResolvedProblems = vi.fn()
const mockSetProblemResolved = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getResolvedProblems: (...args: unknown[]) => mockGetResolvedProblems(...args),
    setProblemResolved: (...args: unknown[]) => mockSetProblemResolved(...args),
  },
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

/** A promise the test resolves manually, to hold a mutation in flight. */
function deferred<T>() {
  const holder: { resolve: (value: T) => void } = { resolve: () => undefined }
  const promise = new Promise<T>((resolve) => {
    holder.resolve = resolve
  })
  return { promise, holder }
}

describe('useProblemResolution per-key pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetResolvedProblems.mockResolvedValue({ resolved: {} })
  })

  it('marks only the toggled key as pending', async () => {
    const { promise, holder } = deferred<{ success: boolean }>()
    mockSetProblemResolved.mockReturnValue(promise)

    const { result } = renderHook(() => useProblemResolution(true), { wrapper: createWrapper() })

    act(() => result.current.toggleResolved('cat|sub|a', true))

    await waitFor(() => expect(result.current.pendingKeys.has('cat|sub|a')).toBe(true))
    expect(result.current.pendingKeys.has('cat|sub|b')).toBe(false)

    act(() => holder.resolve({ success: true }))
    await waitFor(() => expect(result.current.pendingKeys.size).toBe(0))
  })

  it('drops a second toggle of the SAME key while it is in flight', async () => {
    const { promise, holder } = deferred<{ success: boolean }>()
    mockSetProblemResolved.mockReturnValue(promise)

    const { result } = renderHook(() => useProblemResolution(true), { wrapper: createWrapper() })

    act(() => result.current.toggleResolved('cat|sub|a', true))
    await waitFor(() => expect(result.current.pendingKeys.has('cat|sub|a')).toBe(true))
    act(() => result.current.toggleResolved('cat|sub|a', false))

    expect(mockSetProblemResolved).toHaveBeenCalledTimes(1)
    act(() => holder.resolve({ success: true }))
    await waitFor(() => expect(result.current.pendingKeys.size).toBe(0))
  })

  it('allows toggling a DIFFERENT key while another is in flight', async () => {
    const first = deferred<{ success: boolean }>()
    const second = deferred<{ success: boolean }>()
    mockSetProblemResolved
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { result } = renderHook(() => useProblemResolution(true), { wrapper: createWrapper() })

    act(() => result.current.toggleResolved('cat|sub|a', true))
    await waitFor(() => expect(result.current.pendingKeys.has('cat|sub|a')).toBe(true))
    act(() => result.current.toggleResolved('cat|sub|b', true))

    await waitFor(() => expect(result.current.pendingKeys.has('cat|sub|b')).toBe(true))
    expect(mockSetProblemResolved).toHaveBeenCalledTimes(2)

    act(() => {
      first.holder.resolve({ success: true })
      second.holder.resolve({ success: true })
    })
    await waitFor(() => expect(result.current.pendingKeys.size).toBe(0))
  })

  it('clears the key from pending when the mutation fails', async () => {
    mockSetProblemResolved.mockRejectedValue(new Error('boom'))

    const { result } = renderHook(() => useProblemResolution(true), { wrapper: createWrapper() })

    act(() => result.current.toggleResolved('cat|sub|a', true))

    await waitFor(() => expect(result.current.toggleFailed).toBe(true))
    // The key must be re-toggleable after a failure, not stuck pending.
    expect(result.current.pendingKeys.has('cat|sub|a')).toBe(false)
  })
})
