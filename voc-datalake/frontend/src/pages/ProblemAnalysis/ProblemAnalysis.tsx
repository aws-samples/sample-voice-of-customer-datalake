/**
 * @fileoverview Problem analysis page with hierarchical grouping.
 *
 * Features:
 * - Groups feedback by category > subcategory > problem
 * - Merges similar problems using text similarity
 * - Shows root cause hypotheses from AI analysis
 * - Urgency indicators and sentiment averages
 * - Expandable tree view for drill-down
 *
 * @module pages/ProblemAnalysis
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { 
  ChevronDown, ChevronRight, AlertTriangle, Lightbulb, 
  MessageSquare, TrendingUp, Filter, X, Layers
} from 'lucide-react'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import SentimentBadge from '../../components/SentimentBadge'
import type { FeedbackItem } from '../../api/client'

interface ProblemGroup {
  problem: string
  similarProblems: string[]  // Original problem texts that were merged
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
}

interface SubcategoryGroup {
  subcategory: string
  problems: ProblemGroup[]
  totalItems: number
  urgentCount: number
}

interface CategoryGroup {
  category: string
  subcategories: SubcategoryGroup[]
  totalItems: number
  urgentCount: number
}

// Normalize text for similarity comparison
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extract key words from text
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'although', 'though', 'after', 'before', 'when', 'whenever',
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
    'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'been', 'being', 'get', 'got', 'getting'])
  
  const words = normalizeText(text).split(' ')
  return new Set(words.filter(w => w.length > 2 && !stopWords.has(w)))
}

// Calculate Jaccard similarity between two sets
function jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  if (set1.size === 0 && set2.size === 0) return 1
  if (set1.size === 0 || set2.size === 0) return 0
  
  const intersection = new Set([...set1].filter(x => set2.has(x)))
  const union = new Set([...set1, ...set2])
  
  return intersection.size / union.size
}

// Find or create a similar problem group
function findSimilarProblem(
  problems: Map<string, ProblemGroup>,
  newProblem: string,
  threshold: number = 0.4
): string | null {
  const newKeywords = extractKeywords(newProblem)
  
  for (const [existingProblem, group] of problems) {
    const existingKeywords = extractKeywords(existingProblem)
    const similarity = jaccardSimilarity(newKeywords, existingKeywords)
    
    if (similarity >= threshold) {
      return existingProblem
    }
    
    // Also check against similar problems in the group
    for (const similar of group.similarProblems) {
      const similarKeywords = extractKeywords(similar)
      if (jaccardSimilarity(newKeywords, similarKeywords) >= threshold) {
        return existingProblem
      }
    }
  }
  
  return null
}

export default function ProblemAnalysis() {
  const { timeRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [expandedSubcategories, setExpandedSubcategories] = useState<Set<string>>(new Set())
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(new Set())
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)
  const [similarityThreshold, setSimilarityThreshold] = useState(0.4)

  // Fetch entities for dynamic sources and categories
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', days],
    queryFn: () => api.getEntities({ days, limit: 100 }),
    enabled: !!config.apiEndpoint,
  })

  const { data: feedbackData, isLoading } = useQuery({
    queryKey: ['feedback-problems', days],
    queryFn: () => api.getFeedback({ days, limit: 500 }),
    enabled: !!config.apiEndpoint,
  })

  // Build dynamic sources list from entities
  const allSources = useMemo(() => {
    if (!entitiesData?.entities?.sources) return []
    return Object.keys(entitiesData.entities.sources)
      .sort((a, b) => (entitiesData.entities.sources[b] || 0) - (entitiesData.entities.sources[a] || 0))
  }, [entitiesData])

  // Group feedback by category → subcategory → problem (with similarity) → items
  const groupedData = useMemo(() => {
    if (!feedbackData?.items) return []
    
    // Structure: category → subcategory → problems
    const categoryMap = new Map<string, Map<string, Map<string, ProblemGroup>>>()
    
    feedbackData.items
      .filter(item => item.problem_summary) // Only items with problem analysis
      .filter(item => !showUrgentOnly || item.urgency === 'high')
      .filter(item => !selectedCategory || item.category === selectedCategory)
      .filter(item => !selectedSubcategory || item.subcategory === selectedSubcategory)
      .filter(item => !selectedSource || item.brand_name === selectedSource)
      .forEach(item => {
        const category = item.category || 'uncategorized'
        const subcategory = item.subcategory || 'general'
        const problem = item.problem_summary || 'Unknown Issue'
        
        if (!categoryMap.has(category)) {
          categoryMap.set(category, new Map())
        }
        
        const subcategoryMap = categoryMap.get(category)!
        if (!subcategoryMap.has(subcategory)) {
          subcategoryMap.set(subcategory, new Map())
        }
        
        const problemMap = subcategoryMap.get(subcategory)!
        
        // Find similar problem or create new one
        const similarProblemKey = findSimilarProblem(problemMap, problem, similarityThreshold)
        
        if (similarProblemKey) {
          // Add to existing similar problem group
          const group = problemMap.get(similarProblemKey)!
          group.items.push(item)
          if (item.urgency === 'high') group.urgentCount++
          // Track the original problem text if different
          if (problem !== similarProblemKey && !group.similarProblems.includes(problem)) {
            group.similarProblems.push(problem)
          }
          // Update root cause if we find one
          if (!group.rootCause && item.problem_root_cause_hypothesis) {
            group.rootCause = item.problem_root_cause_hypothesis
          }
        } else {
          // Create new problem group
          problemMap.set(problem, {
            problem,
            similarProblems: [],
            rootCause: item.problem_root_cause_hypothesis || null,
            items: [item],
            avgSentiment: 0,
            urgentCount: item.urgency === 'high' ? 1 : 0,
          })
        }
      })
    
    // Calculate averages and convert to array
    const result: CategoryGroup[] = []
    
    categoryMap.forEach((subcategoryMap, category) => {
      const subcategories: SubcategoryGroup[] = []
      let categoryTotalItems = 0
      let categoryUrgent = 0
      
      subcategoryMap.forEach((problemMap, subcategory) => {
        const problems: ProblemGroup[] = []
        let subcategoryTotalItems = 0
        let subcategoryUrgent = 0
        
        problemMap.forEach(group => {
          group.avgSentiment = group.items.reduce((sum, i) => sum + i.sentiment_score, 0) / group.items.length
          problems.push(group)
          subcategoryTotalItems += group.items.length
          subcategoryUrgent += group.urgentCount
        })
        
        // Sort problems by item count (most common first)
        problems.sort((a, b) => b.items.length - a.items.length)
        
        subcategories.push({
          subcategory,
          problems,
          totalItems: subcategoryTotalItems,
          urgentCount: subcategoryUrgent,
        })
        
        categoryTotalItems += subcategoryTotalItems
        categoryUrgent += subcategoryUrgent
      })
      
      // Sort subcategories by total items
      subcategories.sort((a, b) => b.totalItems - a.totalItems)
      
      result.push({
        category,
        subcategories,
        totalItems: categoryTotalItems,
        urgentCount: categoryUrgent,
      })
    })
    
    // Sort categories by total items
    result.sort((a, b) => b.totalItems - a.totalItems)
    
    return result
  }, [feedbackData, showUrgentOnly, selectedCategory, selectedSubcategory, selectedSource, similarityThreshold])

  // Get unique categories from entities (dynamic)
  const allCategories = useMemo(() => {
    if (!entitiesData?.entities?.categories) return []
    return Object.keys(entitiesData.entities.categories)
      .sort((a, b) => (entitiesData.entities.categories[b] || 0) - (entitiesData.entities.categories[a] || 0))
  }, [entitiesData])

  // Get unique subcategories from current data
  const allSubcategories = useMemo(() => {
    if (!feedbackData?.items) return []
    const subcats = new Set<string>()
    feedbackData.items.forEach(item => {
      if (item.subcategory) subcats.add(item.subcategory)
    })
    return Array.from(subcats).sort()
  }, [feedbackData])

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const toggleSubcategory = (key: string) => {
    setExpandedSubcategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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
    const allSubs = new Set<string>()
    const allProbs = new Set<string>()
    groupedData.forEach(g => {
      g.subcategories.forEach(s => {
        allSubs.add(`${g.category}:${s.subcategory}`)
        s.problems.forEach(p => allProbs.add(`${g.category}:${s.subcategory}:${p.problem}`))
      })
    })
    setExpandedCategories(allCats)
    setExpandedSubcategories(allSubs)
    setExpandedProblems(allProbs)
  }

  const collapseAll = () => {
    setExpandedCategories(new Set())
    setExpandedSubcategories(new Set())
    setExpandedProblems(new Set())
  }

  const totalSubcategories = groupedData.reduce((sum, g) => sum + g.subcategories.length, 0)
  const totalProblems = groupedData.reduce((sum, g) => 
    sum + g.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
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
    <div className="space-y-4 sm:space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-600 mb-1">
            <TrendingUp size={14} className="sm:w-4 sm:h-4" />
            <span className="text-xs sm:text-sm">Categories</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold text-gray-900">{groupedData.length}</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-600 mb-1">
            <Layers size={14} className="sm:w-4 sm:h-4" />
            <span className="text-xs sm:text-sm">Subcategories</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold text-gray-900">{totalSubcategories}</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-600 mb-1">
            <AlertTriangle size={14} className="sm:w-4 sm:h-4" />
            <span className="text-xs sm:text-sm truncate">Problems</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold text-gray-900">{totalProblems}</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-gray-200 shadow-sm">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-600 mb-1">
            <MessageSquare size={14} className="sm:w-4 sm:h-4" />
            <span className="text-xs sm:text-sm">Feedback</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold text-gray-900">{totalFeedback}</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-red-200 shadow-sm bg-red-50 col-span-2 sm:col-span-1">
          <div className="flex items-center gap-1.5 sm:gap-2 text-red-600 mb-1">
            <AlertTriangle size={14} className="sm:w-4 sm:h-4" />
            <span className="text-xs sm:text-sm">Urgent</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold text-red-700">{totalUrgent}</p>
        </div>
      </div>

      {/* Filters & Controls */}
      <div className="card">
        <div className="flex flex-col gap-3 sm:gap-4">
          {/* Filter Row */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Filter size={16} className="text-gray-500 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
            <select
              value={selectedSource || ''}
              onChange={(e) => setSelectedSource(e.target.value || null)}
              className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
            >
              <option value="">All Sources</option>
              {allSources.map(source => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
            <select
              value={selectedCategory || ''}
              onChange={(e) => { setSelectedCategory(e.target.value || null); setSelectedSubcategory(null) }}
              className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
            >
              <option value="">All Categories</option>
              {allCategories.map(cat => (
                <option key={cat} value={cat}>{cat.replace('_', ' ')}</option>
              ))}
            </select>
            <select
              value={selectedSubcategory || ''}
              onChange={(e) => setSelectedSubcategory(e.target.value || null)}
              className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
            >
              <option value="">All Subcategories</option>
              {allSubcategories.map(sub => (
                <option key={sub} value={sub}>{sub.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          
          {/* Controls Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
                <input
                  type="checkbox"
                  checked={showUrgentOnly}
                  onChange={(e) => setShowUrgentOnly(e.target.checked)}
                  className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
                />
                <span>Urgent only</span>
              </label>
              {(selectedSource || selectedCategory || selectedSubcategory || showUrgentOnly) && (
                <button
                  onClick={() => { setSelectedSource(null); setSelectedCategory(null); setSelectedSubcategory(null); setShowUrgentOnly(false) }}
                  className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 active:scale-95"
                >
                  <X size={12} className="sm:w-[14px] sm:h-[14px]" />
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
              <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
                <span className="text-gray-500 hidden xs:inline">Similarity:</span>
                <select
                  value={similarityThreshold}
                  onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                  className="px-2 py-1 border border-gray-300 rounded text-xs sm:text-sm"
                  title="Higher = stricter matching, fewer merged groups"
                >
                  <option value={0.2}>Low</option>
                  <option value={0.4}>Med</option>
                  <option value={0.6}>High</option>
                  <option value={1.0}>Off</option>
                </select>
              </div>
              <div className="flex gap-1.5 sm:gap-2">
                <button onClick={expandAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
                  <span className="hidden xs:inline">Expand All</span>
                  <span className="xs:hidden">Expand</span>
                </button>
                <button onClick={collapseAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
                  <span className="hidden xs:inline">Collapse All</span>
                  <span className="xs:hidden">Collapse</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Problem Tree */}
      {groupedData.length === 0 ? (
        <div className="card text-center py-8 sm:py-12">
          <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3 sm:mb-4 sm:w-12 sm:h-12" />
          <p className="text-gray-500 text-sm sm:text-base">No problem analysis data found for the selected period</p>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">Try expanding the time range or adjusting filters</p>
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {groupedData.map((categoryGroup) => (
            <div key={categoryGroup.category} className="card p-0 overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(categoryGroup.category)}
                className="w-full px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between bg-gray-50 hover:bg-gray-100 active:bg-gray-200 transition-colors"
              >
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  {expandedCategories.has(categoryGroup.category) ? (
                    <ChevronDown size={18} className="text-gray-500 flex-shrink-0 sm:w-5 sm:h-5" />
                  ) : (
                    <ChevronRight size={18} className="text-gray-500 flex-shrink-0 sm:w-5 sm:h-5" />
                  )}
                  <span className="font-semibold text-gray-900 capitalize text-sm sm:text-base truncate">
                    {categoryGroup.category.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs sm:text-sm text-gray-500 hidden xs:inline whitespace-nowrap">
                    {categoryGroup.subcategories.length} sub • {categoryGroup.totalItems} reviews
                  </span>
                  {categoryGroup.urgentCount > 0 && (
                    <span className="px-1.5 sm:px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full flex-shrink-0">
                      {categoryGroup.urgentCount}
                    </span>
                  )}
                </div>
              </button>

              {/* Subcategories List */}
              {expandedCategories.has(categoryGroup.category) && (
                <div className="divide-y divide-gray-100">
                  {categoryGroup.subcategories.map((subcategoryGroup) => {
                    const subcategoryKey = `${categoryGroup.category}:${subcategoryGroup.subcategory}`
                    const isSubcategoryExpanded = expandedSubcategories.has(subcategoryKey)
                    
                    return (
                      <div key={subcategoryKey} className="bg-white">
                        {/* Subcategory Header */}
                        <button
                          onClick={() => toggleSubcategory(subcategoryKey)}
                          className="w-full px-3 sm:px-6 py-2.5 sm:py-3 pl-6 sm:pl-10 flex items-center justify-between hover:bg-gray-50 active:bg-gray-100 transition-colors"
                        >
                          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                            {isSubcategoryExpanded ? (
                              <ChevronDown size={16} className="text-gray-400 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
                            ) : (
                              <ChevronRight size={16} className="text-gray-400 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
                            )}
                            <Layers size={12} className="text-blue-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
                            <span className="font-medium text-gray-700 capitalize text-xs sm:text-sm truncate">
                              {subcategoryGroup.subcategory.replace(/_/g, ' ')}
                            </span>
                            <span className="text-xs text-gray-500 hidden xs:inline whitespace-nowrap">
                              {subcategoryGroup.problems.length} problems • {subcategoryGroup.totalItems} reviews
                            </span>
                            {subcategoryGroup.urgentCount > 0 && (
                              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full flex-shrink-0">
                                {subcategoryGroup.urgentCount}
                              </span>
                            )}
                          </div>
                        </button>

                        {/* Problems List */}
                        {isSubcategoryExpanded && (
                          <div className="divide-y divide-gray-50">
                            {subcategoryGroup.problems.map((problemGroup) => {
                              const problemKey = `${categoryGroup.category}:${subcategoryGroup.subcategory}:${problemGroup.problem}`
                              const isExpanded = expandedProblems.has(problemKey)
                              
                              return (
                                <div key={problemKey} className="bg-white">
                                  {/* Problem Header */}
                                  <button
                                    onClick={() => toggleProblem(problemKey)}
                                    className="w-full px-3 sm:px-6 py-2.5 sm:py-3 pl-10 sm:pl-16 flex flex-col sm:flex-row sm:items-start justify-between hover:bg-gray-50 active:bg-gray-100 transition-colors text-left gap-2"
                                  >
                                    <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
                                      {isExpanded ? (
                                        <ChevronDown size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
                                      ) : (
                                        <ChevronRight size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
                                      )}
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 sm:gap-2 mb-1 flex-wrap">
                                          <AlertTriangle size={12} className="text-orange-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
                                          <span className="font-medium text-gray-800 text-xs sm:text-sm">{problemGroup.problem}</span>
                                          {problemGroup.similarProblems.length > 0 && (
                                            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full" title={problemGroup.similarProblems.join(', ')}>
                                              +{problemGroup.similarProblems.length}
                                            </span>
                                          )}
                                        </div>
                                        {problemGroup.rootCause && (
                                          <div className="flex items-start gap-1.5 sm:gap-2 text-xs text-gray-600">
                                            <Lightbulb size={12} className="text-yellow-500 mt-0.5 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
                                            <span className="line-clamp-2">{problemGroup.rootCause}</span>
                                          </div>
                                        )}
                                        {problemGroup.similarProblems.length > 0 && isExpanded && (
                                          <div className="mt-2 text-xs text-gray-500">
                                            <span className="font-medium">Similar:</span>{' '}
                                            {problemGroup.similarProblems.slice(0, 2).join(' • ')}
                                            {problemGroup.similarProblems.length > 2 && ` (+${problemGroup.similarProblems.length - 2})`}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 sm:gap-3 ml-6 sm:ml-4 flex-shrink-0">
                                      <span className="text-xs text-gray-500">{problemGroup.items.length}</span>
                                      {problemGroup.urgentCount > 0 && (
                                        <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                                          {problemGroup.urgentCount}
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
                                    <div className="px-3 sm:px-6 pb-3 sm:pb-4 pl-12 sm:pl-24 space-y-2 sm:space-y-3">
                                      {problemGroup.items.map((item) => (
                                        <Link
                                          key={item.feedback_id}
                                          to={`/feedback/${item.feedback_id}`}
                                          className="block p-3 sm:p-4 bg-gray-50 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors border border-gray-100"
                                        >
                                          <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
                                            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                                              <span className="text-xs font-medium text-gray-700 capitalize">
                                                {item.source_platform.replace(/_/g, ' ')}
                                              </span>
                                              {item.urgency === 'high' && (
                                                <span className="px-1 py-0.5 bg-red-100 text-red-700 text-xs rounded">
                                                  Urgent
                                                </span>
                                              )}
                                            </div>
                                            <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
                                          </div>
                                          <p className="text-xs sm:text-sm text-gray-600 line-clamp-3">{item.original_text}</p>
                                          {item.problem_summary && item.problem_summary !== problemGroup.problem && (
                                            <p className="text-xs text-gray-400 mt-1 italic line-clamp-1">
                                              Original: {item.problem_summary}
                                            </p>
                                          )}
                                          <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-1.5 sm:mt-2 text-xs text-gray-400">
                                            <span>{new Date(item.source_created_at).toLocaleDateString()}</span>
                                            {item.rating && <span>★ {item.rating}/5</span>}
                                            {item.persona_name && <span className="hidden xs:inline">{item.persona_name}</span>}
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
