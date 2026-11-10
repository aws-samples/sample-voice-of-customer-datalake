/**
 * Home used to fetch the default window's `/metrics/summary` twice on load: once
 * for the sidebar badge (the shell, default range: 14 days since 5.47.00) and once
 * for the metric tiles (their 14-day comparison window) under a second key. Both now resolve to one cache entry, and the app policy
 * keeps the shell's reads (summary, brand) from refetching when the tab
 * regains focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider, focusManager } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'

const mockGetSummary = vi.fn<(range: unknown) => Promise<unknown>>()
const mockGetBrandSettings = vi.fn<() => Promise<unknown>>()
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    api: { getSummary: (range: unknown) => mockGetSummary(range), getBrandSettings: () => mockGetBrandSettings() },
  }
})

import { getDateRangeParams } from '../api/client'
import { createAppQueryClient } from '../api/queryPolicies'
import { useConfigStore } from '../store/configStore'
import { DEFAULT_TIME_RANGE } from '../store/timeRanges'
import { useBrandName } from './useBrandSettings'
import { useSummaryQuery } from './useSummaryQuery'

const API = 'https://api.example.com'

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/** What Layout and Home's tiles mount together on Home under the default range. */
function useHomeShell() {
  const shell = useSummaryQuery(getDateRangeParams(DEFAULT_TIME_RANGE), API)
  const tiles = useSummaryQuery({ days: 14 }, API) // Home's MetricTiles comparison window (7 days x 2)
  const brand = useBrandName(API)
  return { shell, tiles, brand }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSummary.mockResolvedValue({ total_feedback: 5, urgent_count: 1 })
  mockGetBrandSettings.mockResolvedValue({ brand_name: 'Acme' })
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: API } }))
})

afterEach(() => { focusManager.setFocused() })

describe('Home shell reads', () => {
  it('fetches the default 14-day summary once for the sidebar and the tiles', async () => {
    const { result } = renderHook(useHomeShell, { wrapper: wrapperFor(createAppQueryClient()) })
    await waitFor(() => expect(result.current.tiles.data).toBeDefined())
    expect(result.current.shell.data).toBe(result.current.tiles.data)
    expect(mockGetSummary).toHaveBeenCalledTimes(1)
  })

  it('does not refetch the summary or the brand when the tab regains focus', async () => {
    const { result } = renderHook(useHomeShell, { wrapper: wrapperFor(createAppQueryClient()) })
    await waitFor(() => expect(result.current.brand.brandName).toBe('Acme'))
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    expect(mockGetSummary).toHaveBeenCalledTimes(1)
    expect(mockGetBrandSettings).toHaveBeenCalledTimes(1)
  })
})
