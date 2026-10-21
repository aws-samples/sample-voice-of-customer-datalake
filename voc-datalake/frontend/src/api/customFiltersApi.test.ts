import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  // Forward only the args actually passed, so a one-arg call (GET) asserts as
  // one arg rather than picking up an undefined second parameter.
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}))

import {
  getCustomFilters,
  saveCustomFilters,
  getCustomFieldCandidates,
} from './customFiltersApi'

describe('getCustomFilters', () => {
  beforeEach(() => mockFetchApi.mockReset())

  it('GETs the custom-filters settings endpoint', async () => {
    mockFetchApi.mockResolvedValue({ custom_filters: [{ key: 'region', label: 'Region' }] })
    const result = await getCustomFilters()
    expect(mockFetchApi).toHaveBeenCalledWith('/settings/custom-filters')
    expect(result.custom_filters).toEqual([{ key: 'region', label: 'Region' }])
  })
})

describe('saveCustomFilters', () => {
  beforeEach(() => mockFetchApi.mockReset())

  it('PUTs the full filter list in the request body', async () => {
    mockFetchApi.mockResolvedValue({ success: true, custom_filters: [] })
    await saveCustomFilters([{ key: 'region', label: 'Region' }, { key: 'plan' }])
    expect(mockFetchApi).toHaveBeenCalledWith(
      '/settings/custom-filters',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ custom_filters: [{ key: 'region', label: 'Region' }, { key: 'plan' }] }),
      }),
    )
  })

  it('can clear filters by sending an empty list', async () => {
    mockFetchApi.mockResolvedValue({ success: true, custom_filters: [] })
    await saveCustomFilters([])
    expect(mockFetchApi).toHaveBeenCalledWith(
      '/settings/custom-filters',
      expect.objectContaining({ body: JSON.stringify({ custom_filters: [] }) }),
    )
  })
})

describe('getCustomFieldCandidates', () => {
  beforeEach(() => mockFetchApi.mockReset())

  it('GETs the custom-field-candidates endpoint', async () => {
    mockFetchApi.mockResolvedValue({
      sampled_count: 6,
      is_partial: false,
      candidates: [
        { key: 'region', distinct_values: 2, coverage: 1.0, top_values: [{ value: 'EMEA', count: 3 }] },
      ],
    })
    const result = await getCustomFieldCandidates()
    expect(mockFetchApi).toHaveBeenCalledWith('/feedback/custom-field-candidates')
    expect(result.candidates[0].key).toBe('region')
    expect(result.candidates[0].top_values[0]).toEqual({ value: 'EMEA', count: 3 })
  })
})
