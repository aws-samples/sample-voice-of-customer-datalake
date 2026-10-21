import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const mockGetLatestDate = vi.fn()

vi.mock('../api/metricsLatestDateApi', () => ({
  getLatestDate: (basis: unknown) => mockGetLatestDate(basis),
}))

import { useEmptyWindowFallback, daysToReach } from './useEmptyWindowFallback'
import { ALL_TIME_DAYS } from '../api/client'

const API_ENDPOINT = 'https://api.example.com'
const SELECTED = { days: 7 }
const TODAY = new Date('2026-10-02T12:00:00Z')

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('daysToReach', () => {
  it('returns days to include a past date in a window ending today', () => {
    // 2026-09-21 is 11 days before 2026-10-02; a window reaching it needs 12.
    expect(daysToReach('2026-09-21', TODAY)).toBe(12)
  })

  it('returns 1 for today', () => {
    expect(daysToReach('2026-10-02', TODAY)).toBe(1)
  })

  it('returns 1 for a future date rather than a negative window', () => {
    expect(daysToReach('2026-10-10', TODAY)).toBe(1)
  })

  it('clamps to ALL_TIME_DAYS for a date older than the cap', () => {
    expect(daysToReach('2020-01-01', TODAY)).toBe(ALL_TIME_DAYS)
  })

  it('returns null for an unparseable date', () => {
    expect(daysToReach('not-a-date', TODAY)).toBeNull()
  })
})

describe('useEmptyWindowFallback', () => {
  beforeEach(() => {
    mockGetLatestDate.mockReset()
  })

  it('does not probe or fall back when the selected window is not empty', async () => {
    const { result } = renderHook(
      () => useEmptyWindowFallback(SELECTED, false, false, API_ENDPOINT, 'imported'),
      { wrapper: createWrapper() },
    )
    // Give any (incorrect) query a tick to fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockGetLatestDate).not.toHaveBeenCalled()
    expect(result.current.fallback).toBeNull()
    expect(result.current.effectiveDateParams).toEqual(SELECTED)
  })

  it('does not fall back while the primary query is still loading', async () => {
    renderHook(
      () => useEmptyWindowFallback(SELECTED, false, true, API_ENDPOINT, 'imported'),
      { wrapper: createWrapper() },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(mockGetLatestDate).not.toHaveBeenCalled()
  })

  it('widens to the latest date and reports a fallback when the window is empty', async () => {
    mockGetLatestDate.mockResolvedValue({ latest_date: '2026-09-21', date_basis: 'imported' })
    const { result } = renderHook(
      () => useEmptyWindowFallback(SELECTED, true, false, API_ENDPOINT, 'imported'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current.fallback).not.toBeNull())
    expect(mockGetLatestDate).toHaveBeenCalledWith('imported')
    expect(result.current.fallback?.latestDate).toBe('2026-09-21')
    // Widened window is larger than the selected 7 days and drives the queries.
    expect(result.current.effectiveDateParams.days).toBeGreaterThan(SELECTED.days)
  })

  it('does not fall back when the latest date is already inside the selected window', async () => {
    // Latest data is recent enough that the selected 7-day window already covers
    // it — an empty result then is honest (e.g. a filtered query), not stale.
    const recent = new Date()
    recent.setDate(recent.getDate() - 2)
    const iso = recent.toISOString().slice(0, 10)
    mockGetLatestDate.mockResolvedValue({ latest_date: iso, date_basis: 'imported' })
    const { result } = renderHook(
      () => useEmptyWindowFallback(SELECTED, true, false, API_ENDPOINT, 'imported'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(mockGetLatestDate).toHaveBeenCalled())
    // Settle, then assert no fallback.
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.fallback).toBeNull()
    expect(result.current.effectiveDateParams).toEqual(SELECTED)
  })

  it('does not fall back when there is no data at all (null latest date)', async () => {
    mockGetLatestDate.mockResolvedValue({ latest_date: null, date_basis: 'imported' })
    const { result } = renderHook(
      () => useEmptyWindowFallback(SELECTED, true, false, API_ENDPOINT, 'imported'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(mockGetLatestDate).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.fallback).toBeNull()
    expect(result.current.effectiveDateParams).toEqual(SELECTED)
  })

  it('probes on the review basis when that is the active basis', async () => {
    mockGetLatestDate.mockResolvedValue({ latest_date: '2026-09-20', date_basis: 'review' })
    renderHook(
      () => useEmptyWindowFallback(SELECTED, true, false, API_ENDPOINT, 'review'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(mockGetLatestDate).toHaveBeenCalledWith('review'))
  })

  it('stays disabled when the api endpoint is not configured', async () => {
    renderHook(
      () => useEmptyWindowFallback(SELECTED, true, false, undefined, 'imported'),
      { wrapper: createWrapper() },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(mockGetLatestDate).not.toHaveBeenCalled()
  })
})
