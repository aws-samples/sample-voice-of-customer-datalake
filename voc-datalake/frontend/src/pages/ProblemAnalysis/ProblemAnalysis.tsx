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

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  ChevronDown, ChevronRight, AlertTriangle,
} from 'lucide-react'
import {
  useState, useMemo, useCallback,
} from 'react'
import { useTranslation } from 'react-i18next'
import { getDaysFromRange } from '../../api/baseUrl'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { ProblemFilters } from './ProblemFilters'
import { buildGroupedData } from './problemGrouping'
import { ProblemStats } from './ProblemStats'
import { filterResolvedProblems } from './problemUtils'
import { SubcategoryRow } from './SubcategoryRow'
import type { SubcategoryGroup } from './problemGrouping'
import type { ResolvedProblem } from '../../api/types'

function buildSubcategoryPDFData(sub: SubcategoryGroup) {
  return {
    subcategory: sub.subcategory,
    totalItems: sub.totalItems,
    urgentCount: sub.urgentCount,
    problems: sub.problems.map((p) => ({
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
  const {
    timeRange, customDateRange, config,
  } = useConfigStore()
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
    queryFn: () => api.getEntities({
      days,
      limit: 100,
    }),
    enabled: config.apiEndpoint.length > 0,
  })

  const {
    data: feedbackData, isLoading,
  } = useQuery({
    queryKey: ['feedback-problems', days],
    queryFn: () => api.getFeedback({
      days,
      limit: 500,
    }),
    enabled: config.apiEndpoint.length > 0,
  })

  // Fetch resolved problems
  const { data: resolvedData } = useQuery({
    queryKey: ['resolved-problems'],
    queryFn: () => api.getResolvedProblems(),
    enabled: config.apiEndpoint.length > 0,
  })

  const resolvedProblemIds = useMemo(() => {
    if (!resolvedData?.resolved) return new Set<string>()
    return new Set(resolvedData.resolved.map((r) => r.problem_id))
  }, [resolvedData])

  // Resolve mutation with optimistic update
  const resolveMutation = useMutation({
    mutationFn: ({
      problemId, category, subcategory, problemText,
    }: {
      problemId: string;
      category: string;
      subcategory: string;
      problemText: string
    }) =>
      api.resolveProblem(problemId, {
        category,
        subcategory,
        problem_text: problemText,
      }),
    onMutate: async ({
      problemId, category, subcategory, problemText,
    }) => {
      setResolvingProblemId(problemId)
      await queryClient.cancelQueries({ queryKey: ['resolved-problems'] })
      const previous = queryClient.getQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'])
      queryClient.setQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'], (old) => ({
        resolved: [
          ...(old?.resolved ?? []),
          {
            problem_id: problemId,
            category,
            subcategory,
            problem_text: problemText,
            resolved_at: new Date().toISOString(),
            resolved_by: '',
          },
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
      void queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  // Unresolve mutation with optimistic update
  const unresolveMutation = useMutation({
    mutationFn: (problemId: string) => api.unresolveProblem(problemId),
    onMutate: async (problemId) => {
      setResolvingProblemId(problemId)
      await queryClient.cancelQueries({ queryKey: ['resolved-problems'] })
      const previous = queryClient.getQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'])
      queryClient.setQueryData<{ resolved: ResolvedProblem[] }>(['resolved-problems'], (old) => ({ resolved: (old?.resolved ?? []).filter((r) => r.problem_id !== problemId) }))
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['resolved-problems'], context.previous)
      }
    },
    onSettled: () => {
      setResolvingProblemId(null)
      void queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  const handleResolveProblem = useCallback((problemId: string, category: string, subcategory: string, problemText: string) => {
    resolveMutation.mutate({
      problemId,
      category,
      subcategory,
      problemText,
    })
  }, [resolveMutation])

  const handleUnresolveProblem = useCallback((problemId: string) => {
    unresolveMutation.mutate(problemId)
  }, [unresolveMutation])

  // Build dynamic sources list from entities
  const allSources = useMemo(() => {
    if (!entitiesData?.entities.sources) return []
    return Object.keys(entitiesData.entities.sources)
      .sort((a, b) => entitiesData.entities.sources[b] - entitiesData.entities.sources[a])
  }, [entitiesData])

  // Group feedback by category → subcategory → problem (with similarity) → items
  const groupedData = useMemo(() => {
    return buildGroupedData(feedbackData?.items, {
      showUrgentOnly,
      selectedCategory,
      selectedSubcategory,
      selectedSource,
      similarityThreshold,
    })
  }, [feedbackData, showUrgentOnly, selectedCategory, selectedSubcategory, selectedSource, similarityThreshold])

  // Apply resolved filter
  const filteredData = useMemo(() => {
    return filterResolvedProblems(groupedData, resolvedProblemIds, showResolved)
  }, [groupedData, resolvedProblemIds, showResolved])

  // Get unique categories from entities (dynamic)
  const allCategories = useMemo(() => {
    if (!entitiesData?.entities.categories) return []
    const categories = entitiesData.entities.categories
    return Object.keys(categories)
      .sort((a, b) => categories[b] - categories[a])
  }, [entitiesData])

  // Get unique subcategories from current data
  const allSubcategories = useMemo(() => {
    if (!feedbackData?.items) return []
    const subcats = new Set<string>()
    for (const item of feedbackData.items) {
      if (item.subcategory != null && item.subcategory !== '') subcats.add(item.subcategory)
    }
    return Array.from(subcats).sort((a, b) => a.localeCompare(b))
  }, [feedbackData])

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const toggleSubcategory = (key: string) => {
    setExpandedSubcategories((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleProblem = (key: string) => {
    setExpandedProblems((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const expandAll = () => {
    const allCats = new Set(filteredData.map((g) => g.category))
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
      const pdfCategories = filteredData.map((cat) => ({
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

  if (config.apiEndpoint === '') {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">{t('configureApi')}</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <output className="flex items-center justify-center h-full" aria-label="Loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </output>
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
                    {categoryGroup.category.replaceAll('_', ' ')}
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
