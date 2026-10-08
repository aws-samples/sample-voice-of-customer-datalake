import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { categoriesApiMocks, clientApiModule, createQueryWrapper } from './categories-fixtures'

vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../hooks/useCategories', () => ({ useCategoryAdmits: () => () => true }))

import { useCategoryAnalytics } from './useCategoryAnalytics'

function sentimentWith(percentages: Record<string, number>) {
  return { period_days: 7, total: 10, breakdown: {}, percentages }
}

function renderAnalytics() {
  return renderHook(() => useCategoryAnalytics({ days: 7 }, null, 'https://api.example.com'), {
    wrapper: createQueryWrapper(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  categoriesApiMocks.getCategories.mockResolvedValue({ period_days: 7, categories: {} })
  categoriesApiMocks.getEntities.mockResolvedValue({ entities: {} })
})

describe('useCategoryAnalytics avgSentiment (positive % minus negative %)', () => {
  it('is the difference of the two percentages', async () => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({ positive: 60, negative: 25, neutral: 15 }))
    const { result } = renderAnalytics()
    await waitFor(() => expect(result.current.avgSentiment).toBe(35))
  })

  it('counts a label missing from the percentages as 0%', async () => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({ positive: 40, neutral: 60 }))
    const { result } = renderAnalytics()
    await waitFor(() => expect(result.current.avgSentiment).toBe(40))
  })

  it('keeps a present 0% as 0, so a feed with no positives is net negative', async () => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({ positive: 0, negative: 10, neutral: 90 }))
    const { result } = renderAnalytics()
    await waitFor(() => expect(result.current.avgSentiment).toBe(-10))
  })

  it('is 0 while there is no sentiment response yet', () => {
    categoriesApiMocks.getSentiment.mockReturnValue(new Promise(() => {}))
    const { result } = renderAnalytics()
    expect(result.current.avgSentiment).toBe(0)
  })
})

describe('useCategoryAnalytics entities reads (QA perf: one request, not two)', () => {
  function renderFor(source: string | null) {
    return renderHook(() => useCategoryAnalytics({ days: 7 }, source, 'https://api.example.com'), {
      wrapper: createQueryWrapper(),
    })
  }

  it.each([null, ''])('asks once when no source is selected (%j)', async (source) => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({}))
    categoriesApiMocks.getEntities.mockResolvedValue({ entities: { sources: { webscraper: 3 }, issues: { 'late delivery': 2 } } })
    const { result } = renderFor(source)

    await waitFor(() => expect(result.current.allSources).toStrictEqual(['webscraper']))
    expect(result.current.wordCloudData.map((w) => w.word)).toContain('late')
    expect(categoriesApiMocks.getEntities).toHaveBeenCalledExactlyOnceWith({ days: 7, limit: 50, source: undefined })
  })

  it('still reads the filtered and the all-sources entities when a source is selected', async () => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({}))
    renderFor('webscraper')

    await waitFor(() => expect(categoriesApiMocks.getEntities).toHaveBeenCalledTimes(2))
    expect(categoriesApiMocks.getEntities).toHaveBeenCalledWith({ days: 7, limit: 50, source: 'webscraper' })
    expect(categoriesApiMocks.getEntities).toHaveBeenCalledWith({ days: 7, limit: 50 })
  })
})

describe('useCategoryAnalytics categoryData (D-14: colours by rank)', () => {
  it('ranks largest first with ties broken by name, and gives each its rank colour for print', async () => {
    categoriesApiMocks.getSentiment.mockResolvedValue(sentimentWith({}))
    categoriesApiMocks.getCategories.mockResolvedValue({
      period_days: 7,
      categories: { water_taste: 2, refunds: 5, cartridge_quality: 9, app_connectivity: 5 },
    })
    const { result } = renderAnalytics()

    await waitFor(() => expect(result.current.categoryData).toHaveLength(4))
    // Kiro Light --chart-1..4: the print/PDF palette (pinned to index.css by types.test.ts).
    expect(result.current.categoryData).toStrictEqual([
      { name: 'cartridge_quality', value: 9, color: '#8e48ff' },
      { name: 'app_connectivity', value: 5, color: '#4194e0' },
      { name: 'refunds', value: 5, color: '#359f95' },
      { name: 'water_taste', value: 2, color: '#c97c49' },
    ])
  })
})
