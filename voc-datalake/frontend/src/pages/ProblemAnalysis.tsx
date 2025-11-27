import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { 
  ChevronDown, ChevronRight, AlertTriangle, Lightbulb, 
  MessageSquare, TrendingUp, Filter, X
} from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import SentimentBadge from '../components/SentimentBadge'
import type { FeedbackItem } from '../api/client'

interface ProblemGroup {
  problem: string
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
}

interface CategoryGroup {
  category: string
  problems: ProblemGroup[]
  totalItems: number
  urgentCount: number
}

export default function ProblemAnalysis() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(new Set())
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)

  const { data: feedbackData, isLoading } = useQuery({
    queryKey: ['feedback-problems', days],
    queryFn: () => api.getFeedback({ days, limit: 500 }),
    enabled: !!config.apiEndpoint,
  })

  // Group feedback by category → problem → items
  const groupedData = useMemo(() => {
    if (!feedbackData?.items) return []
    
    const categoryMap = new Map<string, Map<string, ProblemGroup>>()
    
    feedbackData.items
      .filter(item => item.problem_summary) // Only items with problem analysis
      .filter(item => !showUrgentOnly || item.urgency === 'high')
      .filter(item => !selectedCategory || item.category === selectedCategory)
      .forEach(item => {
        const category = item.category || 'uncategorized'
        const problem = item.problem_summary || 'Unknown Issue'
        
        if (!categoryMap.has(category)) {
          categoryMap.set(category, new Map())
        }
        
        const problemMap = categoryMap.get(category)!
        if (!problemMap.has(problem)) {
          problemMap.set(problem, {
            problem,
            rootCause: item.problem_root_cause_hypothesis || null,
            items: [],
            avgSentiment: 0,
            urgentCount: 0,
          })
        }
        
        const group = problemMap.get(problem)!
        group.items.push(item)
        if (item.urgency === 'high') group.urgentCount++
        // Update root cause if we find one
        if (!group.rootCause && item.problem_root_cause_hypothesis) {
          group.rootCause = item.problem_root_cause_hypothesis
        }
      })
    
    // Calculate averages and convert to array
    const result: CategoryGroup[] = []
    
    categoryMap.forEach((problemMap, category) => {
      const problems: ProblemGroup[] = []
      let totalItems = 0
      let categoryUrgent = 0
      
      problemMap.forEach(group => {
        group.avgSentiment = group.items.reduce((sum, i) => sum + i.sentiment_score, 0) / group.items.length
        problems.push(group)
        totalItems += group.items.length
        categoryUrgent += group.urgentCount
      })
      
      // Sort problems by item count (most common first)
      problems.sort((a, b) => b.items.length - a.items.length)
      
      result.push({
        category,
        problems,
        totalItems,
        urgentCount: categoryUrgent,
      })
    })
    
    // Sort categories by total items
    result.sort((a, b) => b.totalItems - a.totalItems)
    
    return result
  }, [feedbackData, showUrgentOnly, selectedCategory])

  // Get unique categories for filter
  const allCategories = useMemo(() => {
    if (!feedbackData?.items) return []
    const cats = new Set(feedbackData.items.map(i => i.category).filter(Boolean))
    return Array.from(cats).sort()
  }, [feedbackData])

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const toggleProblem = (key: string) => {
    setExpandedProblems(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = () => {
    const allCats = new Set(groupedData.map(g => g.category))
    const allProbs = new Set<string>()
    groupedData.forEach(g => {
      g.problems.forEach(p => allProbs.add(`${g.category}:${p.problem}`))
    })
    setExpandedCategories(allCats)
    setExpandedProblems(allProbs)
  }

  const collapseAll = () => {
    setExpandedCategories(new Set())
    setExpandedProblems(new Set())
  }

  const totalProblems = groupedData.reduce((sum, g) => sum + g.problems.length, 0)
  const totalFeedback = groupedData.reduce((sum, g) => sum + g.totalItems, 0)
  const totalUrgent = groupedData.reduce((sum, g) => sum + g.urgentCount, 0)

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please configure your API endpoint in Settings</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <TrendingUp size={16} />
            <span className="text-sm">Categories</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{groupedData.length}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <AlertTriangle size={16} />
            <span className="text-sm">Unique Problems</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalProblems}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-2 text-gray-600 mb-1">
            <MessageSquare size={16} />
            <span className="text-sm">Feedback Items</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalFeedback}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-red-200 shadow-sm bg-red-50">
          <div className="flex items-center gap-2 text-red-600 mb-1">
            <AlertTriangle size={16} />
            <span className="text-sm">Urgent Issues</span>
          </div>
          <p className="text-2xl font-bold text-red-700">{totalUrgent}</p>
        </div>
      </div>

      {/* Filters & Controls */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Filter size={18} className="text-gray-500" />
            <select
              value={selectedCategory || ''}
              onChange={(e) => setSelectedCategory(e.target.value || null)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All Categories</option>
              {allCategories.map(cat => (
                <option key={cat} value={cat}>{cat.replace('_', ' ')}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showUrgentOnly}
                onChange={(e) => setShowUrgentOnly(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span>Urgent only</span>
            </label>
            {(selectedCategory || showUrgentOnly) && (
              <button
                onClick={() => { setSelectedCategory(null); setShowUrgentOnly(false) }}
                className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
              >
                <X size={14} />
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={expandAll} className="btn btn-secondary text-sm">
              Expand All
            </button>
            <button onClick={collapseAll} className="btn btn-secondary text-sm">
              Collapse All
            </button>
          </div>
        </div>
      </div>

      {/* Problem Tree */}
      {groupedData.length === 0 ? (
        <div className="card text-center py-12">
          <AlertTriangle size={48} className="mx-auto text-gray-300 mb-4" />
          <p className="text-gray-500">No problem analysis data found for the selected period</p>
          <p className="text-sm text-gray-400 mt-1">Try expanding the time range or adjusting filters</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedData.map((categoryGroup) => (
            <div key={categoryGroup.category} className="card p-0 overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(categoryGroup.category)}
                className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {expandedCategories.has(categoryGroup.category) ? (
                    <ChevronDown size={20} className="text-gray-500" />
                  ) : (
                    <ChevronRight size={20} className="text-gray-500" />
                  )}
                  <span className="font-semibold text-gray-900 capitalize">
                    {categoryGroup.category.replace('_', ' ')}
                  </span>
                  <span className="text-sm text-gray-500">
                    {categoryGroup.problems.length} problems • {categoryGroup.totalItems} reviews
                  </span>
                  {categoryGroup.urgentCount > 0 && (
                    <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                      {categoryGroup.urgentCount} urgent
                    </span>
                  )}
                </div>
              </button>

              {/* Problems List */}
              {expandedCategories.has(categoryGroup.category) && (
                <div className="divide-y divide-gray-100">
                  {categoryGroup.problems.map((problemGroup) => {
                    const problemKey = `${categoryGroup.category}:${problemGroup.problem}`
                    const isExpanded = expandedProblems.has(problemKey)
                    
                    return (
                      <div key={problemKey} className="bg-white">
                        {/* Problem Header */}
                        <button
                          onClick={() => toggleProblem(problemKey)}
                          className="w-full px-6 py-3 pl-12 flex items-start justify-between hover:bg-gray-50 transition-colors text-left"
                        >
                          <div className="flex items-start gap-3 flex-1">
                            {isExpanded ? (
                              <ChevronDown size={18} className="text-gray-400 mt-0.5 flex-shrink-0" />
                            ) : (
                              <ChevronRight size={18} className="text-gray-400 mt-0.5 flex-shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <AlertTriangle size={14} className="text-orange-500 flex-shrink-0" />
                                <span className="font-medium text-gray-800">{problemGroup.problem}</span>
                              </div>
                              {problemGroup.rootCause && (
                                <div className="flex items-start gap-2 text-sm text-gray-600">
                                  <Lightbulb size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
                                  <span className="line-clamp-2">{problemGroup.rootCause}</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                            <span className="text-sm text-gray-500">{problemGroup.items.length} reviews</span>
                            {problemGroup.urgentCount > 0 && (
                              <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                                {problemGroup.urgentCount} urgent
                              </span>
                            )}
                            <SentimentBadge 
                              sentiment={problemGroup.avgSentiment > 0 ? 'positive' : problemGroup.avgSentiment < -0.3 ? 'negative' : 'neutral'} 
                              score={problemGroup.avgSentiment} 
                            />
                          </div>
                        </button>

                        {/* Feedback Items */}
                        {isExpanded && (
                          <div className="px-6 pb-4 pl-20 space-y-3">
                            {problemGroup.items.map((item) => (
                              <Link
                                key={item.feedback_id}
                                to={`/feedback/${item.feedback_id}`}
                                className="block p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors border border-gray-100"
                              >
                                <div className="flex items-start justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-gray-700 capitalize">
                                      {item.source_platform.replace('_', ' ')}
                                    </span>
                                    {item.urgency === 'high' && (
                                      <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded">
                                        Urgent
                                      </span>
                                    )}
                                  </div>
                                  <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
                                </div>
                                <p className="text-sm text-gray-600 line-clamp-3">{item.original_text}</p>
                                <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                                  <span>{new Date(item.source_created_at).toLocaleDateString()}</span>
                                  {item.rating && <span>★ {item.rating}/5</span>}
                                  {item.persona_name && <span>{item.persona_name}</span>}
                                </div>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
