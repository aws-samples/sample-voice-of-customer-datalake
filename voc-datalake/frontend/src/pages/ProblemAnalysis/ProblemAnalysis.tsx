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
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { 
  ChevronDown, ChevronRight, AlertTriangle, 
  MessageSquare, TrendingUp, X, Layers
} from 'lucide-react'
import { api, getDateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { usePageFilters } from '../../store/feedbackFilterStore'
import { filtersKey } from '../../api/feedbackFilters'
import { FILTER_QUERY_DEBOUNCE_MS, useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettledOnce } from '../../hooks/useSettledOnce'
import FeedbackFilterPanel from '../../components/FeedbackFilterPanel'
import FeedbackDetailOverlay from '../../components/FeedbackDetailOverlay'
import { useCustomFilterControls } from '../Categories/useCustomFilterControls'
import { ProblemControls } from './ProblemControls'
import { SubcategoryRow } from './SubcategoryRow'
import { applyResolution } from './problemResolution'
import { useProblemResolution } from './useProblemResolution'
import { useProblemFeedback } from './useProblemFeedback'
import type { ProblemTree } from './useProblemFeedback'
import { WindowCoverageNotice } from './WindowCoverageNotice'
import type { CategoryGroup } from './problemResolution'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import type { EntitiesResponse } from '../../api/types'
import type { CustomFilterControl } from '../../components/FeedbackFilterPanel'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'


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
        itemCount: p.itemCount,
        avgSentiment: p.avgSentiment,
        urgentCount: p.urgentCount,
        // With "Show resolved" on, resolved groups reach the export — the
        // PDF must annotate them, since strike-through/badge is UI-only.
        resolved: p.resolved === true,
      })),
    })),
  }))
}

/** The PDF header's "filtered by" lines; multi-selections are comma-joined. */
function toPdfFilters(filters: FeedbackFilterState) {
  const joined = (values: readonly string[]) => (values.length > 0 ? values.join(', ') : null)
  return {
    source: joined(filters.sources),
    category: joined(filters.categories),
    subcategory: joined(filters.subcategories),
    urgentOnly: filters.urgentOnly,
  }
}

interface ProblemFilterPanelProps {
  readonly filters: FeedbackFilterState
  readonly onChange: (next: FeedbackFilterState) => void
  readonly entities: EntitiesResponse | undefined
  readonly subcategories: readonly string[]
  readonly customFilterControls: readonly CustomFilterControl[]
  readonly isUpdating: boolean
}

function ProblemFilterPanel({ filters, onChange, entities, subcategories, customFilterControls, isUpdating }: ProblemFilterPanelProps) {
  const sources = entities?.entities.sources ?? {}
  const categories = entities?.entities.categories ?? {}
  return (
    <FeedbackFilterPanel
      filters={filters}
      onChange={onChange}
      options={{ sources: Object.keys(sources), categories: Object.keys(categories), subcategories }}
      counts={{ sources, categories }}
      customFilterControls={customFilterControls}
      isUpdating={isUpdating}
    />
  )
}

/**
 * Narrow the server-built tree to the selected subcategories, recomputing each
 * category's totals so headers reflect what remains; a category left with no
 * subcategory is dropped. Every other filter was applied to rows server-side
 * before aggregation, so it is not handled here. No selection keeps the tree.
 */
function filterTreeBySubcategory(categories: CategoryGroup[], selected: readonly string[]): CategoryGroup[] {
  if (selected.length === 0) return categories
  return categories
    .map((c) => {
      const subcategories = c.subcategories.filter((s) => selected.includes(s.subcategory))
      return {
        ...c,
        subcategories,
        totalItems: subcategories.reduce((sum, s) => sum + s.totalItems, 0),
        urgentCount: subcategories.reduce((sum, s) => sum + s.urgentCount, 0),
      }
    })
    .filter((c) => c.subcategories.length > 0)
}

// Empty state distinguishes "nothing in this window" from "everything here
// is resolved" — hiding data behind the toggle must not read as no data.
// Kept out of the page component for its complexity budget.
function EmptyProblemsState({ resolvedCount }: { readonly resolvedCount: number }) {
  const { t } = useTranslation('common')
  return (
    <div className="card text-center py-8 sm:py-12">
      <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3 sm:mb-4 sm:w-12 sm:h-12" />
      {resolvedCount > 0 ? (
        <>
          <p className="text-gray-500 text-sm sm:text-base">{t('problemResolution.allResolvedTitle')}</p>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">{t('problemResolution.allResolvedHint', { total: resolvedCount })}</p>
        </>
      ) : (
        <>
          <p className="text-gray-500 text-sm sm:text-base">{t('problemAnalysisPage.emptyTitle')}</p>
          <p className="text-xs sm:text-sm text-gray-400 mt-1">{t('problemAnalysisPage.emptyHint')}</p>
        </>
      )}
    </div>
  )
}

/** Nothing was read, so every aggregate would be a zero that looks like a finding. */
function nothingRead(feedback: ProblemTree): boolean {
  return feedback.isError && feedback.loadedCount === 0
}

function StatCard({ icon, label, value, urgent = false }: Readonly<{
  icon: React.ReactNode; label: string; value: number; urgent?: boolean
}>) {
  return (
    <div className={clsx(
      'rounded-xl p-3 sm:p-4 border shadow-sm',
      urgent ? 'border-red-200 bg-red-50 col-span-2 sm:col-span-1' : 'bg-white border-gray-200',
    )}>
      <div className={clsx('flex items-center gap-1.5 sm:gap-2 mb-1', urgent ? 'text-red-600' : 'text-gray-600')}>
        {icon}
        <span className="text-xs sm:text-sm truncate">{label}</span>
      </div>
      <p className={clsx('text-xl sm:text-2xl font-bold', urgent ? 'text-red-700' : 'text-gray-900')}>{value}</p>
    </div>
  )
}

/** Header stats plus their coverage notice; hidden when nothing was read. */
function ProblemSummary({ visibleData, feedback, isUpdating }: Readonly<{
  visibleData: CategoryGroup[]; feedback: ProblemTree; isUpdating: boolean
}>) {
  if (nothingRead(feedback)) return null
  const subcategories = visibleData.flatMap((g) => g.subcategories)
  const iconClass = 'sm:w-4 sm:h-4'
  return (
    <>
      <div className={clsx('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4 transition-opacity', isUpdating && 'opacity-60')}>
        <StatCard icon={<TrendingUp size={14} className={iconClass} />} label="Categories" value={visibleData.length} />
        <StatCard icon={<Layers size={14} className={iconClass} />} label="Subcategories" value={subcategories.length} />
        <StatCard icon={<AlertTriangle size={14} className={iconClass} />} label="Problems"
          value={subcategories.reduce((sum, s) => sum + s.problems.length, 0)} />
        <StatCard icon={<MessageSquare size={14} className={iconClass} />} label="Feedback"
          value={visibleData.reduce((sum, g) => sum + g.totalItems, 0)} />
        <StatCard icon={<AlertTriangle size={14} className={iconClass} />} label="Urgent" urgent
          value={visibleData.reduce((sum, g) => sum + g.urgentCount, 0)} />
      </div>
      {/* Coverage of the counts above; self-hiding when the window was read in
          full. Rationale lives in the component. */}
      <WindowCoverageNotice
        isPartial={feedback.isPartial}
        hasFailed={feedback.isError}
        loadedCount={feedback.loadedCount}
        totalCount={feedback.totalCount}
      />
    </>
  )
}

/**
 * The problem tree area. A failed read, an empty result and a re-query all
 * render HERE, so the filter panel above stays mounted across changes.
 */
function ProblemTreeArea({ feedback, isUpdating, resolvedCount, isEmpty, children }: Readonly<{
  feedback: ProblemTree; isUpdating: boolean; resolvedCount: number; isEmpty: boolean; children: React.ReactNode
}>) {
  if (nothingRead(feedback)) {
    // Say the window is unknown instead of implying it is empty, with a retry.
    return (
      <div className="flex justify-center py-8">
        <WindowCoverageNotice isPartial={false} hasFailed loadedCount={0} totalCount={0} onRetry={feedback.retry} />
      </div>
    )
  }
  if (isEmpty && !isUpdating) return <EmptyProblemsState resolvedCount={resolvedCount} />
  return (
    <div aria-busy={isUpdating} className={clsx('space-y-3 sm:space-y-4 transition-opacity', isUpdating && 'opacity-60')}>
      {children}
    </div>
  )
}

// Rendered when persisting a resolve/unresolve fails; kept out of the page
// component so the conditional doesn't count against its complexity budget.
function ResolveErrorBanner({ show, onDismiss }: { readonly show: boolean; readonly onDismiss: () => void }) {
  const { t } = useTranslation('common')
  if (!show) return null
  return (
    <div className="card bg-red-50 border border-red-200 text-red-700 text-sm py-2 px-3 flex items-center justify-between gap-2" role="alert">
      <span>{t('problemResolution.saveFailed')}</span>
      <button type="button" onClick={onDismiss} aria-label={t('dismiss')} className="text-red-500 hover:text-red-700">
        <X size={14} />
      </button>
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
  const [showResolved, setShowResolved] = useState(false)
  const [similarityThreshold, setSimilarityThreshold] = useState(0.4)
  const [openFeedback, setOpenFeedback] = useState<FeedbackItem | null>(null)
  // The shared, persisted filters. Every dimension except subcategory is sent to
  // the server (applied to rows BEFORE aggregation); subcategory narrows the
  // built tree, so the panel keeps offering every subcategory of the selection.
  const { filters, setFilters } = usePageFilters('problemAnalysis')
  // The server dimensions are debounced, so several quick changes cost one
  // aggregate; subcategory stays live (it only narrows the built tree).
  const queryFilters = useDebouncedValue(filters, FILTER_QUERY_DEBOUNCE_MS)
  const serverFilters = useMemo(() => ({ ...queryFilters, subcategories: [] }), [queryFilters])

  // Fetch entities for dynamic sources and categories (kept across window
  // changes so the panel's options never empty out mid-selection).
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 100 }),
    enabled: !!config.apiEndpoint,
    placeholderData: keepPreviousData,
  })

  // Admin-configured custom-field filter dropdowns (same hook Categories uses):
  // joins the saved filter config with the recommended values per key.
  const customFilterControls = useCustomFilterControls(config.apiEndpoint)

  // The server aggregates the FULL window into finest-grain problem leaves;
  // this hook merges them to `similarityThreshold` in-browser (the slider
  // re-merges without re-fetching). The filters are pushed down as server query
  // params — they're row-level, so applying them before aggregation is both
  // correct and cheaper than filtering a built tree.
  const feedback = useProblemFeedback(dateParams, config.apiEndpoint, similarityThreshold, serverFilters)

  // Resolved problems are shared across users (issue #66); resolving one
  // clears it from everyone's default view. All query/mutation wiring lives
  // in the hook (complexity budget + useSettingsSync convention).
  const {
    resolvedMap, resolvedLoading, pendingKeys, toggleFailed,
    toggleResolved, dismissToggleError,
  } = useProblemResolution(!!config.apiEndpoint)

  // Gate the FIRST load on the resolved-state query too: without it, resolved
  // problems flash as unresolved for a frame and then vanish when it lands.
  const settled = useSettledOnce(feedback.isLoading || resolvedLoading)
  const isUpdating = feedback.isUpdating || filtersKey({ ...filters, subcategories: [] }) !== filtersKey(serverFilters)

  // Subcategory is the one post-filter over the SERVER-BUILT tree (everything
  // else was applied to rows server-side). Totals are recomputed so headers
  // reflect what the filter leaves visible.
  const filteredTree = useMemo(
    () => filterTreeBySubcategory(feedback.categories, filters.subcategories),
    [feedback.categories, filters.subcategories],
  )

  // Annotate problem groups with their shared resolved status and hide the
  // resolved ones unless requested; category/subcategory totals are
  // recomputed so headers reflect what is actually shown (issue #66).
  const { visible: visibleData, resolvedCount } = useMemo(
    () => applyResolution(filteredTree, resolvedMap, showResolved),
    [filteredTree, resolvedMap, showResolved],
  )

  // Window + filters handed to each expanded problem for its on-demand row
  // fetch, so examples match the same selection as the tree. Memoized so a
  // problem row isn't re-rendered on unrelated state.
  const drillParams = useMemo(
    () => ({ dateParams, filters: serverFilters, onOpenFeedback: setOpenFeedback }),
    [dateParams, serverFilters],
  )

  // Subcategories present in the aggregated tree (for the filter dropdown).
  const allSubcategories = useMemo(() => {
    const subcats = new Set<string>()
    for (const c of feedback.categories) {
      for (const s of c.subcategories) subcats.add(s.subcategory)
    }
    return Array.from(subcats).sort((a, b) => a.localeCompare(b))
  }, [feedback.categories])

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

  const exportPDF = () => {
    if (visibleData.length === 0) return
    try {
      generateProblemAnalysisPDF({
        categories: toPDFCategories(visibleData),
        timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
        resolvedLabel: t('problemResolution.resolved'),
        // What the exported tree was built from: the queried server filters
        // plus the live subcategory narrowing.
        filters: toPdfFilters({ ...serverFilters, subcategories: filters.subcategories }),
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

  // Full-page spinner for the FIRST load only; every later state (a re-query,
  // an empty result, a failed read) renders under the panel so it stays open.
  if (!settled) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <ProblemSummary visibleData={visibleData} feedback={feedback} isUpdating={isUpdating} />

      <ProblemFilterPanel
        filters={filters}
        onChange={setFilters}
        entities={entitiesData}
        subcategories={allSubcategories}
        customFilterControls={customFilterControls}
        isUpdating={isUpdating}
      />
      <ProblemControls
        showResolved={showResolved}
        onShowResolvedChange={setShowResolved}
        resolvedCount={resolvedCount}
        similarityThreshold={similarityThreshold}
        onSimilarityChange={setSimilarityThreshold}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onExportPdf={exportPDF}
        canExport={visibleData.length > 0}
      />

      <ResolveErrorBanner show={toggleFailed} onDismiss={dismissToggleError} />

      {/* Problem Tree */}
      <ProblemTreeArea
        feedback={feedback}
        isUpdating={isUpdating}
        resolvedCount={resolvedCount}
        isEmpty={visibleData.length === 0}
      >
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
                        onToggleResolved={toggleResolved}
                        pendingKeys={pendingKeys}
                        drillParams={drillParams}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          ))}
      </ProblemTreeArea>
      <FeedbackDetailOverlay feedback={openFeedback} onClose={() => setOpenFeedback(null)} />
    </div>
  )
}
