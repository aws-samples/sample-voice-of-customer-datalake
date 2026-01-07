import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock API
const mockGetCategories = vi.fn()
const mockGetSentiment = vi.fn()
const mockGetEntities = vi.fn()
const mockGetFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
    getSentiment: (...args: unknown[]) => mockGetSentiment(...args),
    getEntities: (...args: unknown[]) => mockGetEntities(...args),
    getFeedback: (...args: unknown[]) => mockGetFeedback(...args),
  },
}))

import { useCategoriesData, useFeedbackData } from './useCategoriesData'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const mockCategoriesResponse = {
  categories: {
    delivery: 50,
    customer_support: 30,
    pricing: 20,
  },
}

const mockSentimentResponse = {
  breakdown: { positive: 60, neutral: 25, negative: 15 },
  percentages: { positive: 60, neutral: 25, negative: 15 },
}

const mockEntitiesResponse = {
  entities: {
    issues: { 'slow delivery': 20, 'damaged package': 15 },
    categories: { delivery: 50, pricing: 20 },
    sources: { twitter: 40, trustpilot: 30, google_reviews: 10 },
  },
}

const mockFeedbackResponse = {
  items: [
    {
      feedback_id: '1',
      source_platform: 'twitter',
      original_text: 'Great delivery!',
      sentiment_label: 'positive',
      category: 'delivery',
      rating: 5,
      brand_name: 'twitter',
      problem_summary: null,
    },
    {
      feedback_id: '2',
      source_platform: 'trustpilot',
      original_text: 'Slow support',
      sentiment_label: 'negative',
      category: 'customer_support',
      rating: 2,
      brand_name: 'trustpilot',
      problem_summary: 'slow response time',
    },
  ],
  count: 2,
}

describe('useCategoriesData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategories.mockResolvedValue(mockCategoriesResponse)
    mockGetSentiment.mockResolvedValue(mockSentimentResponse)
    mockGetEntities.mockResolvedValue(mockEntitiesResponse)
  })

  it('returns loading state initially', () => {
    mockGetCategories.mockReturnValue(new Promise(() => {}))
    mockGetSentiment.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    expect(result.current.isLoading).toBe(true)
  })

  it('returns category data sorted by value descending', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.categoryData).toHaveLength(3)
    expect(result.current.categoryData[0].name).toBe('delivery')
    expect(result.current.categoryData[0].value).toBe(50)
    expect(result.current.categoryData[1].name).toBe('customer_support')
    expect(result.current.categoryData[2].name).toBe('pricing')
  })

  it('calculates total issues correctly', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.totalIssues).toBe(100) // 50 + 30 + 20
  })

  it('returns sentiment data with colors and percentages', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.sentimentData).toHaveLength(3)
    const positive = result.current.sentimentData.find(s => s.name === 'positive')
    expect(positive?.value).toBe(60)
    expect(positive?.percentage).toBe(60)
    expect(positive?.color).toBe('#22c55e')
  })

  it('calculates average sentiment correctly', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // avgSentiment = positive - negative = 60 - 15 = 45
    expect(result.current.avgSentiment).toBe(45)
  })

  it('returns all sources sorted by count', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.allSources).toEqual(['twitter', 'trustpilot', 'google_reviews'])
  })

  it('builds word cloud data from issues and categories', async () => {
    const { result } = renderHook(() => useCategoriesData(7, null, 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.wordCloudData.length).toBeGreaterThan(0)
    // Should include words from issues (filtering stop words and short words)
    const words = result.current.wordCloudData.map(w => w.word)
    expect(words).toContain('delivery')
  })

  it('filters by source when provided', async () => {
    renderHook(() => useCategoriesData(7, 'twitter', 'https://api.example.com'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(mockGetCategories).toHaveBeenCalledWith(7, 'twitter')
      expect(mockGetSentiment).toHaveBeenCalledWith(7, 'twitter')
    })
  })

  it('does not fetch when apiEndpoint is empty', () => {
    renderHook(() => useCategoriesData(7, null, ''), {
      wrapper: createWrapper(),
    })

    expect(mockGetCategories).not.toHaveBeenCalled()
    expect(mockGetSentiment).not.toHaveBeenCalled()
  })
})

describe('useFeedbackData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedback.mockResolvedValue(mockFeedbackResponse)
  })

  it('returns loading state initially when shouldFetch is true', () => {
    mockGetFeedback.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'all', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    expect(result.current.isLoading).toBe(true)
  })

  it('does not fetch when shouldFetch is false', () => {
    renderHook(
      () => useFeedbackData(7, null, [], 'all', [], 0, 'https://api.example.com', false),
      { wrapper: createWrapper() }
    )

    expect(mockGetFeedback).not.toHaveBeenCalled()
  })

  it('returns filtered feedback data', async () => {
    const { result } = renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'all', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.feedbackData?.items).toHaveLength(2)
  })

  it('filters by minimum rating', async () => {
    const { result } = renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'all', [], 4, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Only item with rating >= 4 should pass
    expect(result.current.filteredFeedback).toHaveLength(1)
    expect(result.current.filteredFeedback[0].feedback_id).toBe('1')
  })

  it('filters by multiple categories', async () => {
    const { result } = renderHook(
      () => useFeedbackData(7, null, ['delivery', 'pricing'], 'all', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Only delivery category item should pass (pricing not in mock data)
    expect(result.current.filteredFeedback).toHaveLength(1)
  })

  it('filters by keywords in text', async () => {
    const { result } = renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'all', ['slow'], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Only item with 'slow' in text or problem_summary
    expect(result.current.filteredFeedback).toHaveLength(1)
    expect(result.current.filteredFeedback[0].feedback_id).toBe('2')
  })

  it('filters by source', async () => {
    const { result } = renderHook(
      () => useFeedbackData(7, 'twitter', ['delivery'], 'all', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Only twitter source should pass
    expect(result.current.filteredFeedback).toHaveLength(1)
    expect(result.current.filteredFeedback[0].source_platform).toBe('twitter')
  })

  it('passes sentiment filter to API', async () => {
    renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'negative', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(mockGetFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ sentiment: 'negative' })
      )
    })
  })

  it('does not pass sentiment filter when set to all', async () => {
    renderHook(
      () => useFeedbackData(7, null, ['delivery'], 'all', [], 0, 'https://api.example.com', true),
      { wrapper: createWrapper() }
    )

    await waitFor(() => {
      expect(mockGetFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ sentiment: undefined })
      )
    })
  })
})
