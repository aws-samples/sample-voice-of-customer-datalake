/**
 * @fileoverview Tests for useCustomFilterControls — the config+candidates join
 * that builds the FilterBar custom-filter dropdowns (Phase 4d).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCustomFilterControls } from './useCustomFilterControls'

const mockGetCustomFilters = vi.fn()
const mockGetCustomFieldCandidates = vi.fn()

vi.mock('../../api/customFiltersApi', () => ({
  getCustomFilters: () => mockGetCustomFilters(),
  getCustomFieldCandidates: () => mockGetCustomFieldCandidates(),
}))

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useCustomFilterControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [{ key: 'region', label: 'Region' }] })
    mockGetCustomFieldCandidates.mockResolvedValue({
      sampled_count: 10,
      is_partial: false,
      candidates: [
        { key: 'region', distinct_values: 2, coverage: 1, top_values: [{ value: 'EMEA', count: 6 }, { value: 'APAC', count: 4 }] },
      ],
    })
  })

  it('returns no controls and never fetches without an API endpoint', () => {
    const { result } = renderHook(() => useCustomFilterControls(''), { wrapper: createWrapper() })
    expect(result.current).toEqual([])
    expect(mockGetCustomFilters).not.toHaveBeenCalled()
  })

  it('joins configured keys with their candidate values', async () => {
    const { result } = renderHook(
      () => useCustomFilterControls('https://api.example.com'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]).toEqual({ key: 'region', label: 'Region', values: ['EMEA', 'APAC'] })
  })

  it('renders a configured key with empty values when it has no candidate suggestions', async () => {
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [{ key: 'order_id', label: 'Order' }] })
    const { result } = renderHook(
      () => useCustomFilterControls('https://api.example.com'),
      { wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0]).toEqual({ key: 'order_id', label: 'Order', values: [] })
  })

  it('returns no controls when no filters are configured', async () => {
    mockGetCustomFilters.mockResolvedValue({ custom_filters: [] })
    const { result } = renderHook(
      () => useCustomFilterControls('https://api.example.com'),
      { wrapper: createWrapper() },
    )
    // Give the queries a tick to resolve, then assert still empty.
    await waitFor(() => expect(mockGetCustomFilters).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })
})
