import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { categoryColors, getSentimentColor } from './types'
import type { CategoryData, SentimentData, WordCloudItem } from './types'

const STOP_WORDS = ['with', 'that', 'this', 'from', 'have', 'been', 'were', 'they', 'their', 'about', 'would', 'could', 'should', 'very', 'more', 'some', 'than', 'when', 'what', 'which', 'there', 'other']

export function useCategoriesData(days: number, selectedSource: string | null, apiEndpoint: string) {
  const enabled = !!apiEndpoint

  const { data: categories, isLoading: categoriesLoading } = useQuery({
    queryKey: ['categories', days, selectedSource],
    queryFn: () => api.getCategories(days, selectedSource || undefined),
    enabled,
  })

  const { data: sentiment, isLoading: sentimentLoading } = useQuery({
    queryKey: ['sentiment', days, selectedSource],
    queryFn: () => api.getSentiment(days, selectedSource || undefined),
    enabled,
  })

  const { data: entities } = useQuery({
    queryKey: ['entities', days, selectedSource],
    queryFn: () => api.getEntities({ days, limit: 50, source: selectedSource || undefined }),
    enabled,
  })

  const { data: allEntities } = useQuery({
    queryKey: ['entities-all-sources', days],
    queryFn: () => api.getEntities({ days, limit: 50 }),
    enabled,
  })

  const allSources = useMemo(() => {
    if (!allEntities?.entities?.sources) return []
    return Object.keys(allEntities.entities.sources)
      .sort((a, b) => (allEntities.entities.sources[b] || 0) - (allEntities.entities.sources[a] || 0))
  }, [allEntities])

  const categoryData: CategoryData[] = useMemo(() => {
    if (!categories) return []
    return Object.entries(categories.categories)
      .map(([name, value]) => ({ 
        name, 
        value,
        color: categoryColors[name] || categoryColors.other
      }))
      .sort((a, b) => b.value - a.value)
  }, [categories])

  const sentimentData: SentimentData[] = useMemo(() => {
    if (!sentiment) return []
    return Object.entries(sentiment.breakdown).map(([name, value]) => ({
      name,
      value,
      color: getSentimentColor(name),
      percentage: sentiment.percentages[name] ?? 0
    }))
  }, [sentiment])

  const wordCloudData: WordCloudItem[] = useMemo(() => {
    if (!entities?.entities) return []
    const issuesData = entities.entities.issues || {}
    const categoriesData = entities.entities.categories || {}
    const wordCounts: Record<string, number> = {}
    
    Object.entries(issuesData).forEach(([issue, count]) => {
      const words = issue.toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOP_WORDS.includes(w))
      
      words.forEach(word => {
        const countNum = typeof count === 'number' ? count : 0
        wordCounts[word] = (wordCounts[word] ?? 0) + countNum
      })
    })
    
    Object.entries(categoriesData).forEach(([cat, count]) => {
      const word = cat.replace('_', ' ')
      const countNum = typeof count === 'number' ? count : 0
      wordCounts[word] = (wordCounts[word] ?? 0) + countNum
    })
    
    return Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([word, count]) => ({ word, count }))
  }, [entities])

  const totalIssues = categoryData.reduce((sum, c) => sum + c.value, 0)
  const avgSentiment = sentiment ? (sentiment.percentages.positive || 0) - (sentiment.percentages.negative || 0) : 0
  const isLoading = categoriesLoading || sentimentLoading

  return {
    categoryData,
    sentimentData,
    wordCloudData,
    allSources,
    totalIssues,
    avgSentiment,
    isLoading,
    sentiment,
  }
}

export function useFeedbackData(
  days: number,
  selectedSource: string | null,
  selectedCategories: string[],
  sentimentFilter: string,
  selectedKeywords: string[],
  minRating: number,
  apiEndpoint: string,
  shouldFetch: boolean
) {
  const { data: feedbackData, isLoading } = useQuery({
    queryKey: ['feedback', days, selectedCategories, sentimentFilter, selectedKeywords, selectedSource],
    queryFn: () => api.getFeedback({ 
      days, 
      source: selectedSource || undefined,
      category: selectedCategories.length === 1 ? selectedCategories[0] : undefined,
      sentiment: sentimentFilter !== 'all' ? sentimentFilter : undefined,
      limit: 100 
    }),
    enabled: !!apiEndpoint && shouldFetch,
  })

  const filteredFeedback = useMemo(() => {
    if (!feedbackData?.items) return []
    return feedbackData.items.filter(item => {
      if (minRating > 0 && (!item.rating || item.rating < minRating)) return false
      if (selectedCategories.length > 1 && !selectedCategories.includes(item.category)) return false
      if (selectedSource && item.source_platform !== selectedSource) return false
      if (selectedKeywords.length > 0) {
        const text = (item.original_text + ' ' + (item.problem_summary || '')).toLowerCase()
        const hasKeyword = selectedKeywords.some(kw => text.includes(kw.toLowerCase()))
        if (!hasKeyword) return false
      }
      return true
    })
  }, [feedbackData, minRating, selectedCategories, selectedKeywords, selectedSource])

  return { feedbackData, filteredFeedback, isLoading }
}
