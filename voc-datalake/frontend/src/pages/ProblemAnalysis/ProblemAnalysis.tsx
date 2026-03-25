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

import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import type { FeedbackItem, ResolvedProblem } from '../../api/client'
import { SubcategoryRow } from './SubcategoryRow'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { filterResolvedProblems } from './problemUtils'
import { ProblemFilters } from './ProblemFilters'
import { ProblemStats } from './ProblemStats'

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

// Check if keywords match any in a list above threshold
function matchesAnyKeywords(newKeywords: Set<string>, texts: string[], threshold: number): boolean {
  return texts.some(text => jaccardSimilarity(newKeywords, extractKeywords(text)) >= threshold)
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
    if (jaccardSimilarity(newKeywords, existingKeywords) >= threshold) {
      return existingProblem
    }
    if (matchesAnyKeywords(newKeywords, group.similarProblems, threshold)) {
      return existingProblem
    }
  }

  return null
}

function getOrCreateSubcategoryMap(
  categoryMap: Map<string, Map<string, Map<string, ProblemGroup>>>,
  category: string
): Map<string, Map<string, ProblemGroup>> {
  const existing = categoryMap.get(category)
  if (existing) return existing
  const newMap = new Map<string, Map<string, ProblemGroup>>()
  categoryMap.set(category, newMap)
  return newMap
}

function getOrCreateProblemMap(
  subcategoryMap: Map<string, Map<string, ProblemGroup>>,
  subcategory: string
): Map<string, ProblemGroup> {
  const existing = subcategoryMap.get(subcategory)
  if (existing) return existing
  const newMap = new Map<string, ProblemGroup>()
  subcategoryMap.set(subcategory, newMap)
  return newMap
}

function updateExistingGroup(group: ProblemGroup, item: FeedbackItem, problem: string, similarProblemKey: string): void {
  group.items.push(item)
  if (item.urgency === 'high') group.urgentCount++
  if (problem !== similarProblemKey && !group.similarProblems.includes(problem)) {
    group.similarProblems.push(problem)
  }
  if (!group.rootCause && item.problem_root_cause_hypothesis) {
    group.rootCause = item.problem_root_cause_hypothesis
  }
}

function addItemToProblemGroup(
  problemMap: Map<string, ProblemGroup>,
  item: FeedbackItem,
  problem: string,
  similarityThreshold: number
): void {
  const similarProblemKey = findSimilarProblem(problemMap, problem, similarityThreshold)

  if (similarProblemKey) {
    const group = problemMap.get(similarProblemKey)
    if (group) {
      updateExistingGroup(group, item, problem, similarProblemKey)
    }
  } else {
    problemMap.set(problem, {
      problem,
      similarProblems: [],
      rootCause: item.problem_root_cause_hypothesis || null,
      items: [item],
      avgSentiment: 0,
      urgentCount: item.urgency === 'high' ? 1 : 0,
    })
  }
}

function buildSubcategoryGroup(problemMap: Map<string, ProblemGroup>, subcategory: string): SubcategoryGroup {
  const problems: ProblemGroup[] = []

  for (const group of problemMap.values()) {
    group.avgSentiment = group.items.reduce((sum, i) => sum + i.sentiment_score, 0) / group.items.length
    problems.push(group)
  }

  problems.sort((a, b) => b.items.length - a.items.length)
  const totalItems = problems.reduce((sum, p) => sum + p.items.length, 0)
  const urgentCount = problems.reduce((sum, p) => sum + p.urgentCount, 0)
  return { subcategory, problems, totalItems, urgentCount }
}

function buildCategoryGroups(categoryMap: Map<string, Map<string, Map<string, ProblemGroup>>>): CategoryGroup[] {
  const result: CategoryGroup[] = []

  for (const [category, subcategoryMap] of categoryMap) {
    const subcategories: SubcategoryGroup[] = []

    for (const [subcategory, problemMap] of subcategoryMap) {
      subcategories.push(buildSubcategoryGroup(problemMap, subcategory))
    }

    subcategories.sort((a, b) => b.totalItems - a.totalItems)
    const categoryTotalItems = subcategories.reduce((sum, s) => sum + s.totalItems, 0)
    const categoryUrgent = subcategories.reduce((sum, s) => sum + s.urgentCount, 0)
    result.push({ category, subcategories, totalItems: categoryTotalItems, urgentCount: categoryUrgent })
  }

  result.sort((a, b) => b.totalItems - a.totalItems)
  return result
}

function buildSubcategoryPDFData(sub: SubcategoryGroup) {
  return {
    subcategory: sub.subcategory,
    totalItems: sub.totalItems,
    urgentCount: sub.urgentCount,
    problems: sub.problems.map(p => ({
      problem: p.problem,
      similarProblems: p.similarProblems,
      rootCause: p.rootCause,
      itemCount: p.items.length,
      avgSentiment: p.avgSentiment,
      urgentCount: p.urgentCount,
    })),
  }
}

export default function ProblemAnalysis() {
  const { timeRange, customDateRange, config } = useConfigStore()
  const { t } = useTranslation('problemAnalysis')
  const days = getDaysFromRange(timeRange, customDateRange)
  const queryClient = useQueryClient()
  
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [expandedSubcategories, setExpandedSubcategories] = useState<Set<string>>(new Set())
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(new Set())
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [similarityThreshold, setSimilarityThreshold] = useState(0.4)
  const [resolvingProblemId, setResolvingProblemId] = useState<string | null>(null)

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

  // Fetch resolved problems
  const { data: resolvedData } = useQuery({
    queryKey: ['resolved-problems'],
    queryFn: () => api.getResolvedProblems(),
    enabled: !!config.apiEndpoint,
  })

  const resolvedProblemIds = useMemo(() => {
    if (!resolvedData?.resolved) return new Set<string>()
    return new Set(resolvedData.resolved.map(r => r.problem_id))
  }, [resolvedData])

  // Resolve mutation with optimistic update
  const resolveMutation = useMutation({
    mutationFn: ({ problemId, category, subcategory, problemText }: { problemId: string; category: string; subcategory: string; problemText: string }) =>
      api.resolveProblem(problemId, { category, subcategory, problem_text: problemText }),
    onMutate: async ({ problemId, category, subcategory, problemText }) => {
      setResolvingProblemId(problemId)
      await queryClient.cancelQueries({ queryKey: ['resolved-problems'] })
      const previous = queryClient.getQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'])
      queryClient.setQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'], (old) => ({
        resolved: [
          ...(old?.resolved ?? []),
          { problem_id: problemId, category, subcategory, problem_text: problemText, resolved_at: new Date().toISOString(), resolved_by: '' },
        ],
      }))
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['resolved-problems'], context.previous)
      }
    },
    onSettled: () => {
      setResolvingProblemId(null)
      queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  // Unresolve mutation with optimistic update
  const unresolveMutation = useMutation({
    mutationFn: (problemId: string) => api.unresolveProblem(problemId),
    onMutate: async (problemId) => {
      setResolvingProblemId(problemId)
      await queryClient.cancelQueries({ queryKey: ['resolved-problems'] })
      const previous = queryClient.getQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'])
      queryClient.setQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'], (old) => ({
        resolved: (old?.resolved ?? []).filter(r => r.problem_id !== problemId),
      }))
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['resolved-problems'], context.previous)
      }
    },
    onSettled: () => {
      setResolvingProblemId(null)
      queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  const handleResolveProblem = useCallback((problemId: string, category: string, subcategory: string, problemText: string) => {
    resolveMutation.mutate({ problemId, category, subcategory, problemText })
  }, [resolveMutation])

  const handleUnresolveProblem = useCallback((problemId: string) => {
    unresolveMutation.mutate(problemId)
  }, [unresolveMutation])

  // Build dynamic sources list from entities
  const allSources = useMemo(() => {
    if (!entitiesData?.entities?.sources) return []
    return Object.keys(entitiesData.entities.sources)
      .sort((a, b) => (entitiesData.entities.sources[b] || 0) - (entitiesData.entities.sources[a] || 0))
  }, [entitiesData])

  // Group feedback by category → subcategory → problem (with similarity) → items
  const groupedData = useMemo(() => {
    if (!feedbackData?.items) return []

    const categoryMap = new Map<string, Map<string, Map<string, ProblemGroup>>>()

    const filteredItems = feedbackData.items
      .filter(item => item.problem_summary)
      .filter(item => !showUrgentOnly || item.urgency === 'high')
      .filter(item => !selectedCategory || item.category === selectedCategory)
      .filter(item => !selectedSubcategory || item.subcategory === selectedSubcategory)
      .filter(item => !selectedSource || item.source_platform === selectedSource)

    for (const item of filteredItems) {
      const category = item.category || 'uncategorized'
      const subcategory = item.subcategory || 'general'
      const problem = item.problem_summary || 'Unknown Issue'

      const subcategoryMap = getOrCreateSubcategoryMap(categoryMap, category)
      const problemMap = getOrCreateProblemMap(subcategoryMap, subcategory)
      addItemToProblemGroup(problemMap, item, problem, similarityThreshold)
    }

    return buildCategoryGroups(categoryMap)
  }, [feedbackData, showUrgentOnly, selectedCategory, selectedSubcategory, selectedSource, similarityThreshold])

  // Apply resolved filter
  const filteredData = useMemo(() => {
    return filterResolvedProblems(groupedData, resolvedProblemIds, showResolved)
  }, [groupedData, resolvedProblemIds, showResolved])

  // Get unique categories from entities (dynamic)
  const allCategories = useMemo(() => {
    if (!entitiesData?.entities?.categories) return []
    const categories = entitiesData.entities.categories
    return Object.keys(categories)
      .sort((a, b) => (categories[b] ?? 0) - (categories[a] ?? 0))
  }, [entitiesData])

  // Get unique subcategories from current data
  const allSubcategories = useMemo(() => {
    if (!feedbackData?.items) return []
    const subcats = new Set<string>()
    for (const item of feedbackData.items) {
      if (item.subcategory) subcats.add(item.subcategory)
    }
    return Array.from(subcats).sort((a, b) => a.localeCompare(b))
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
    const allCats = new Set(filteredData.map(g => g.category))
    const allSubs = new Set<string>()
    const allProbs = new Set<string>()
    for (const g of filteredData) {
      for (const s of g.subcategories) {
        allSubs.add(`${g.category}:${s.subcategory}`)
        for (const p of s.problems) {
          allProbs.add(`${g.category}:${s.subcategory}:${p.problem}`)
        }
      }
    }
    setExpandedCategories(allCats)
    setExpandedSubcategories(allSubs)
    setExpandedProblems(allProbs)
  }

  const collapseAll = () => {
    setExpandedCategories(new Set())
    setExpandedSubcategories(new Set())
    setExpandedProblems(new Set())
  }

  const exportPDF = () => {
    try {
      const pdfCategories = filteredData.map(cat => ({
        category: cat.category,
        totalItems: cat.totalItems,
        urgentCount: cat.urgentCount,
        subcategories: cat.subcategories.map(buildSubcategoryPDFData),
      }))
      generateProblemAnalysisPDF({
        categories: pdfCategories,
        timeRange,
        filters: {
          source: selectedSource,
          category: selectedCategory,
          subcategory: selectedSubcategory,
          urgentOnly: showUrgentOnly,
        },
      })
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    }
  }

  const totalSubcategories = filteredData.reduce((sum, g) => sum + g.subcategories.length, 0)
  const totalProblems = filteredData.reduce((sum, g) => 
    sum + g.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
  const totalFeedback = filteredData.reduce((sum, g) => sum + g.totalItems, 0)
  const totalUrgent = filteredData.reduce((sum, g) => sum + g.urgentCount, 0)

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">{t('configureApi')}</p>
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
      <ProblemStats
        categoryCount={filteredData.length}
        subcategoryCount={totalSubcategories}
        problemCount={totalProblems}
        feedbackCount={totalFeedback}
        urgentCount={totalUrgent}
      />

      <ProblemFilters
        allSources={allSources}
        allCategories={allCategories}
        allSubcategories={allSubcategories}
        selectedSource={selectedSource}
        selectedCategory={selectedCategory}
        selectedSubcategory={selectedSubcategory}
        showUrgentOnly={showUrgentOnly}
        showResolved={showResolved}
        resolvedCount={resolvedProblemIds.size}
        similarityThreshold={similarityThreshold}
        hasData={filteredData.length > 0}
        onSourceChange={setSelectedSource}
        onCategoryChange={setSelectedCategory}
        onSubcategoryChange={setSelectedSubcategory}
        onUrgentOnlyChange={setShowUrgentOnly}
        onShowResolvedChange={setShowResolved}
        onSimilarityChange={setSimilarityThreshold}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onExportPDF={exportPDF}
      />

      {/* Problem Tree */}
      {filteredData.length === 0 ? (
        <div className="card text-center py-8 sm:py-12">
          <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3 sm:mb-4 sm:w-12 sm:h-12" />
          <p className="text-gray-500 text-sm sm:text-base">{t('noDataTitle')}</p>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">{t('noDataHint')}</p>
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {filteredData.map((categoryGroup) => (
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
                    {t('tree.sub', { count: categoryGroup.subcategories.length })} • {t('tree.reviews', { count: categoryGroup.totalItems })}
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
                    return (
                      <SubcategoryRow
                        key={subcategoryKey}
                        categoryName={categoryGroup.category}
                        subcategoryGroup={subcategoryGroup}
                        isExpanded={expandedSubcategories.has(subcategoryKey)}
                        onToggle={() => toggleSubcategory(subcategoryKey)}
                        expandedProblems={expandedProblems}
                        onToggleProblem={toggleProblem}
                        resolvedProblemIds={resolvedProblemIds}
                        resolvingProblemId={resolvingProblemId}
                        onResolveProblem={handleResolveProblem}
                        onUnresolveProblem={handleUnresolveProblem}
                      />
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
