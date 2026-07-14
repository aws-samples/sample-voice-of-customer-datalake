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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { 
  ChevronDown, ChevronRight, AlertTriangle, 
  MessageSquare, TrendingUp, Filter, X, Layers, FileDown
} from 'lucide-react'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import type { FeedbackItem } from '../../api/client'
import { SubcategoryRow } from './SubcategoryRow'
import { applyResolution } from './problemResolution'
import type { CategoryGroup, ProblemGroup, SubcategoryGroup } from './problemResolution'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'


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

// Map the in-memory grouping tree to the PDF export shape
// (the problem level uses itemCount instead of the full items array).
function toPDFCategories(groups: CategoryGroup[]) {
  return groups.map((c) => ({
    category: c.category,
    totalItems: c.totalItems,
    urgentCount: c.urgentCount,
    subcategories: c.subcategories.map((s) => ({
      subcategory: s.subcategory,
      totalItems: s.totalItems,
      urgentCount: s.urgentCount,
      problems: s.problems.map((p) => ({
        problem: p.problem,
        similarProblems: p.similarProblems,
        rootCause: p.rootCause,
        itemCount: p.items.length,
        avgSentiment: p.avgSentiment,
        urgentCount: p.urgentCount,
      })),
    })),
  }))
}

// Rendered when persisting a resolve/unresolve fails; kept out of the page
// component so the conditional doesn't count against its complexity budget.
function ResolveErrorBanner({ show }: { readonly show: boolean }) {
  const { t } = useTranslation('common')
  if (!show) return null
  return (
    <div className="card bg-red-50 border border-red-200 text-red-700 text-sm py-2 px-3" role="alert">
      {t('problemResolution.saveFailed')}
    </div>
  )
}

export default function ProblemAnalysis() {
  const { t } = useTranslation('common')
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [expandedSubcategories, setExpandedSubcategories] = useState<Set<string>>(new Set())
  const [expandedProblems, setExpandedProblems] = useState<Set<string>>(new Set())
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [similarityThreshold, setSimilarityThreshold] = useState(0.4)
  const queryClient = useQueryClient()

  // Fetch entities for dynamic sources and categories
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 100 }),
    enabled: !!config.apiEndpoint,
  })

  const { data: feedbackData, isLoading } = useQuery({
    queryKey: ['feedback-problems', dateParams],
    queryFn: () => api.getFeedback({ ...dateParams, limit: 500 }),
    enabled: !!config.apiEndpoint,
  })

  // Resolved problems are shared across users (issue #66); resolving one
  // clears it from everyone's default view.
  const { data: resolvedData } = useQuery({
    queryKey: ['resolved-problems'],
    queryFn: () => api.getResolvedProblems(),
    enabled: !!config.apiEndpoint,
  })

  const toggleResolvedMutation = useMutation({
    mutationFn: ({ key, resolved }: { key: string; resolved: boolean }) =>
      api.setProblemResolved(key, resolved),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['resolved-problems'] })
    },
  })

  const handleToggleResolved = (key: string, resolved: boolean) => {
    // Serialize toggles: a rapid double-click would race SET/REMOVE for the
    // same key server-side. The mutation error state renders a banner below.
    if (toggleResolvedMutation.isPending) return
    toggleResolvedMutation.mutate({ key, resolved })
  }

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

  // Annotate problem groups with their shared resolved status and hide the
  // resolved ones unless requested; category/subcategory totals are
  // recomputed so headers reflect what is actually shown (issue #66).
  const resolvedMap = useMemo(() => resolvedData?.resolved ?? {}, [resolvedData])
  const { visible: visibleData, resolvedCount } = useMemo(
    () => applyResolution(groupedData, resolvedMap, showResolved),
    [groupedData, resolvedMap, showResolved],
  )

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
    const allCats = new Set(visibleData.map(g => g.category))
    const allSubs = new Set<string>()
    const allProbs = new Set<string>()
    for (const g of visibleData) {
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

  const totalSubcategories = visibleData.reduce((sum, g) => sum + g.subcategories.length, 0)
  const totalProblems = visibleData.reduce((sum, g) => 
    sum + g.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
  const totalFeedback = visibleData.reduce((sum, g) => sum + g.totalItems, 0)
  const totalUrgent = visibleData.reduce((sum, g) => sum + g.urgentCount, 0)

  const exportPDF = () => {
    if (visibleData.length === 0) return
    try {
      generateProblemAnalysisPDF({
        categories: toPDFCategories(visibleData),
        timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
        filters: {
          source: selectedSource,
          category: selectedCategory,
          subcategory: selectedSubcategory,
          urgentOnly: showUrgentOnly,
        },
      })
    } catch {
      // PDF generation is best-effort (e.g. popup blocked)
    }
  }

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
          <p className="text-xl sm:text-2xl font-bold text-gray-900">{visibleData.length}</p>
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
              <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                  className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
                />
                {/* Counts resolved problems within the CURRENT filters
                    (what the toggle would reveal), not the global store. */}
                <span>{t('problemResolution.showResolved', { total: resolvedCount })}</span>
              </label>
              {(selectedSource || selectedCategory || selectedSubcategory || showUrgentOnly || showResolved) && (
                <button
                  onClick={() => { setSelectedSource(null); setSelectedCategory(null); setSelectedSubcategory(null); setShowUrgentOnly(false); setShowResolved(false) }}
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
                <button
                  onClick={exportPDF}
                  disabled={visibleData.length === 0}
                  className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t('exportPdfTooltip')}
                >
                  <FileDown size={14} />
                  {t('exportPdfShort')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ResolveErrorBanner show={toggleResolvedMutation.isError} />

      {/* Problem Tree */}
      {visibleData.length === 0 ? (
        <div className="card text-center py-8 sm:py-12">
          <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3 sm:mb-4 sm:w-12 sm:h-12" />
          <p className="text-gray-500 text-sm sm:text-base">No problem analysis data found for the selected period</p>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">Try expanding the time range or adjusting filters</p>
        </div>
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {visibleData.map((categoryGroup) => (
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
                    return (
                      <SubcategoryRow
                        key={subcategoryKey}
                        categoryName={categoryGroup.category}
                        subcategoryGroup={subcategoryGroup}
                        isExpanded={expandedSubcategories.has(subcategoryKey)}
                        onToggle={() => toggleSubcategory(subcategoryKey)}
                        expandedProblems={expandedProblems}
                        onToggleProblem={toggleProblem}
                        onToggleResolved={handleToggleResolved}
                        resolvePending={toggleResolvedMutation.isPending}
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
