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
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { 
  ChevronDown, ChevronRight, AlertTriangle, 
  MessageSquare, TrendingUp, Filter, X, Layers
} from 'lucide-react'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { SubcategoryRow } from './SubcategoryRow'
import { applyResolution } from './problemResolution'
import { useProblemResolution } from './useProblemResolution'
import { useProblemFeedback } from './useProblemFeedback'
import { toggleSetMember } from './toggleSetMember'
import { WindowCoverageNotice } from './WindowCoverageNotice'
import { groupProblems, toPDFCategories } from './problemGrouping'
import { rankEntityKeys } from '../Categories/entityCounts'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import { CenteredSpinner, ExportPageHeader } from '../Categories/ExportPageHeader'


// Module-level so the operator chain doesn't count against the page
// component's complexity budget.
function anyFilterActive(...filters: Array<string | boolean | null>): boolean {
  return filters.some(Boolean)
}

// Empty state distinguishes "nothing in this window" from "everything here
// is resolved" — hiding data behind the toggle must not read as no data.
// Kept out of the page component for its complexity budget.
function EmptyProblemsState({ resolvedCount }: { readonly resolvedCount: number }) {
  const { t } = useTranslation('common')
  return (
    <div className="card text-center py-8 sm:py-12">
      <AlertTriangle size={36} className="mx-auto text-muted-strong mb-3 sm:mb-4 sm:w-12 sm:h-12" />
      {resolvedCount > 0 ? (
        <>
          <p className="text-text text-sm sm:text-base">{t('problemResolution.allResolvedTitle')}</p>
          <p className="text-xs sm:text-sm text-muted mt-1">{t('problemResolution.allResolvedHint', { total: resolvedCount })}</p>
        </>
      ) : (
        <>
          <p className="text-text text-sm sm:text-base">{t('problemAnalysisPage.emptyTitle')}</p>
          <p className="text-xs sm:text-sm text-muted mt-1">{t('problemAnalysisPage.emptyHint')}</p>
        </>
      )}
    </div>
  )
}

/** One header stat. Same chrome as the dashboard metric tiles' label/value pair. */
function StatCard({ icon, label, value, tone }: Readonly<{ icon: ReactNode; label: string; value: number; tone?: 'warn' }>) {
  return (
    <div className={clsx('card stat-accent !p-3 sm:!p-4', tone === 'warn' && '!bg-warn-subtle !border-warn/30 col-span-2 sm:col-span-1')}>
      <div className={clsx('flex items-center gap-1.5 sm:gap-2 mb-1', tone === 'warn' ? 'text-warn' : 'text-muted')}>
        {icon}
        <span className="text-xs sm:text-sm truncate">{label}</span>
      </div>
      <p className={clsx('text-xl sm:text-2xl font-bold font-mono', tone === 'warn' ? 'text-warn' : 'text-text-strong')}>{value}</p>
    </div>
  )
}

// Rendered when persisting a resolve/unresolve fails; kept out of the page
// component so the conditional doesn't count against its complexity budget.
function ResolveErrorBanner({ show, onDismiss }: { readonly show: boolean; readonly onDismiss: () => void }) {
  const { t } = useTranslation('common')
  if (!show) return null
  return (
    <div className="card !bg-danger-subtle !border-danger/30 text-danger text-sm !py-2 !px-3 flex items-center justify-between gap-2" role="alert">
      <span>{t('problemResolution.saveFailed')}</span>
      <button type="button" onClick={onDismiss} aria-label={t('dismiss')} className="icon-btn text-danger hover:text-danger">
        <X size={14} />
      </button>
    </div>
  )
}

export default function ProblemAnalysis() {
  const { t } = useTranslation(['common', 'problemAnalysis'])
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

  // Fetch entities for dynamic sources and categories
  const { data: entitiesData } = useQuery({
    queryKey: ['entities', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 100 }),
    enabled: !!config.apiEndpoint,
  })

  // Pages the whole window rather than asking for one oversized page: the
  // stat cards and the tree are aggregates, and `/feedback` silently clamps
  // `limit` to 100 (U5b). `isPartial` reports a window read only in part.
  const feedback = useProblemFeedback(dateParams, config.apiEndpoint)

  // Resolved problems are shared across users (issue #66); resolving one
  // clears it from everyone's default view. All query/mutation wiring lives
  // in the hook (complexity budget + useSettingsSync convention).
  const {
    resolvedMap, resolvedLoading, pendingKeys, toggleFailed,
    toggleResolved, dismissToggleError,
  } = useProblemResolution(!!config.apiEndpoint)

  // Build dynamic sources list from entities
  const allSources = useMemo(() => rankEntityKeys(entitiesData, 'sources'), [entitiesData])

  // Group feedback by category → subcategory → problem (with similarity) → items
  const groupedData = useMemo(() => {
    const filteredItems = feedback.items
      .filter(item => item.problem_summary)
      .filter(item => !showUrgentOnly || item.urgency === 'high')
      .filter(item => !selectedCategory || item.category === selectedCategory)
      .filter(item => !selectedSubcategory || item.subcategory === selectedSubcategory)
      .filter(item => !selectedSource || item.source_platform === selectedSource)

    return groupProblems(filteredItems, similarityThreshold)
  }, [feedback.items, showUrgentOnly, selectedCategory, selectedSubcategory, selectedSource, similarityThreshold])

  // Annotate problem groups with their shared resolved status and hide the
  // resolved ones unless requested; category/subcategory totals are
  // recomputed so headers reflect what is actually shown (issue #66).
  const { visible: visibleData, resolvedCount } = useMemo(
    () => applyResolution(groupedData, resolvedMap, showResolved),
    [groupedData, resolvedMap, showResolved],
  )

  // Get unique categories from entities (dynamic)
  const allCategories = useMemo(() => rankEntityKeys(entitiesData, 'categories'), [entitiesData])

  // Get unique subcategories from current data
  const allSubcategories = useMemo(() => {
    const subcats = new Set<string>()
    for (const item of feedback.items) {
      if (item.subcategory) subcats.add(item.subcategory)
    }
    return Array.from(subcats).sort((a, b) => a.localeCompare(b))
  }, [feedback.items])

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => toggleSetMember(prev, category))
  }

  const toggleSubcategory = (key: string) => {
    setExpandedSubcategories(prev => toggleSetMember(prev, key))
  }

  const toggleProblem = (key: string) => {
    setExpandedProblems(prev => toggleSetMember(prev, key))
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
        resolvedLabel: t('problemResolution.resolved'),
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
        <p className="text-muted">{t('problemAnalysis:configureApi')}</p>
      </div>
    )
  }

  // Gate on the resolved-state query too: without it, resolved problems
  // flash as unresolved for a frame and then vanish when the query lands.
  if (feedback.isLoading || resolvedLoading) {
    return <CenteredSpinner />
  }

  // Nothing was read, so every aggregate below would be a zero that looks like
  // a finding. Say the window is unknown instead of implying it is empty.
  if (feedback.isError && feedback.items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <WindowCoverageNotice
          isLoadingMore={false}
          isPartial={false}
          hasFailed
          loadedCount={0}
          totalCount={0}
          onRetry={feedback.retry}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <ExportPageHeader
        title={t('problemAnalysis:title')}
        subtitle={t('problemAnalysis:subtitle')}
        onExport={exportPDF}
        exportDisabled={visibleData.length === 0}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <StatCard icon={<TrendingUp size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />} label={t('problemAnalysis:stats.categories')} value={visibleData.length} />
        <StatCard icon={<Layers size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />} label={t('problemAnalysis:stats.subcategories')} value={totalSubcategories} />
        <StatCard icon={<AlertTriangle size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />} label={t('problemAnalysis:stats.problems')} value={totalProblems} />
        <StatCard icon={<MessageSquare size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />} label={t('problemAnalysis:stats.feedback')} value={totalFeedback} />
        <StatCard icon={<AlertTriangle size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />} label={t('problemAnalysis:stats.urgent')} value={totalUrgent} tone="warn" />
      </div>

      {/* Coverage of the counts above; self-hiding when the window was read in
          full. Rationale lives in the component. */}
      <WindowCoverageNotice
        isLoadingMore={feedback.isLoadingMore}
        isPartial={feedback.isPartial}
        hasFailed={feedback.isError}
        loadedCount={feedback.loadedCount}
        totalCount={feedback.totalCount}
      />

      {/* Filters & Controls */}
      <div className="card">
        <div className="flex flex-col gap-3 sm:gap-4">
          {/* Filter Row */}
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
            <Filter size={16} className="hidden sm:block text-muted flex-shrink-0" aria-hidden="true" />
            <select
              aria-label={t('problemAnalysis:filters.source')}
              value={selectedSource ?? ''}
              onChange={(e) => setSelectedSource(e.target.value || null)}
              className="select w-full sm:w-auto sm:min-w-[160px]"
            >
              <option value="">{t('problemAnalysis:filters.allSources')}</option>
              {allSources.map(source => (
                <option key={source} value={source}>{source}</option>
              ))}
            </select>
            <select
              aria-label={t('problemAnalysis:filters.category')}
              value={selectedCategory ?? ''}
              onChange={(e) => { setSelectedCategory(e.target.value || null); setSelectedSubcategory(null) }}
              className="select w-full sm:w-auto sm:min-w-[160px]"
            >
              <option value="">{t('problemAnalysis:filters.allCategories')}</option>
              {allCategories.map(cat => (
                <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <select
              aria-label={t('problemAnalysis:filters.subcategory')}
              value={selectedSubcategory ?? ''}
              onChange={(e) => setSelectedSubcategory(e.target.value || null)}
              className="select w-full sm:w-auto sm:min-w-[160px]"
            >
              <option value="">{t('problemAnalysis:filters.allSubcategories')}</option>
              {allSubcategories.map(sub => (
                <option key={sub} value={sub}>{sub.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          
          {/* Controls Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <label className="flex items-center gap-2 min-h-9 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={showUrgentOnly}
                  onChange={(e) => setShowUrgentOnly(e.target.checked)}
                  className="rounded-sm accent-accent focus-ring w-4 h-4"
                />
                <span>{t('problemAnalysis:filters.urgentOnly')}</span>
              </label>
              <label className="flex items-center gap-2 min-h-9 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                  className="rounded-sm accent-accent focus-ring w-4 h-4"
                />
                {/* Counts resolved problems within the CURRENT filters
                    (what the toggle would reveal), not the global store. */}
                <span>{t('problemResolution.showResolved', { total: resolvedCount })}</span>
              </label>
              {anyFilterActive(selectedSource, selectedCategory, selectedSubcategory, showUrgentOnly, showResolved) && (
                <button
                  type="button"
                  onClick={() => { setSelectedSource(null); setSelectedCategory(null); setSelectedSubcategory(null); setShowUrgentOnly(false); setShowResolved(false) }}
                  className="btn btn-ghost btn-sm"
                >
                  <X size={14} aria-hidden="true" />
                  {t('problemAnalysis:filters.clear')}
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
              {/* A real <label>, so the select has a visible accessible name
                  (axe label-title-only: a title alone is not a label). */}
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">{t('problemAnalysis:filters.similarity')}</span>
                <select
                  value={similarityThreshold}
                  onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                  className="select select-sm w-auto"
                  title={t('problemAnalysis:filters.similarityHint')}
                >
                  <option value={0.2}>{t('problemAnalysis:filters.similarityLow')}</option>
                  <option value={0.4}>{t('problemAnalysis:filters.similarityMed')}</option>
                  <option value={0.6}>{t('problemAnalysis:filters.similarityHigh')}</option>
                  <option value={1.0}>{t('problemAnalysis:filters.similarityOff')}</option>
                </select>
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={expandAll} className="btn btn-secondary btn-sm">
                  {t('problemAnalysis:filters.expandAll')}
                </button>
                <button type="button" onClick={collapseAll} className="btn btn-secondary btn-sm">
                  {t('problemAnalysis:filters.collapseAll')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ResolveErrorBanner show={toggleFailed} onDismiss={dismissToggleError} />

      {/* Problem Tree */}
      {visibleData.length === 0 ? (
        <EmptyProblemsState resolvedCount={resolvedCount} />
      ) : (
        <div className="space-y-3 sm:space-y-4">
          {visibleData.map((categoryGroup) => (
            <div key={categoryGroup.category} className="card p-0 overflow-hidden">
              {/* Category Header */}
              <button
                type="button"
                onClick={() => toggleCategory(categoryGroup.category)}
                aria-expanded={expandedCategories.has(categoryGroup.category)}
                className="w-full px-3 sm:px-5 py-3 sm:py-4 flex items-center justify-between bg-bg-accent hover:bg-bg-hover active:bg-border transition-colors focus-ring text-left"
              >
                <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                  {expandedCategories.has(categoryGroup.category) ? (
                    <ChevronDown size={18} className="text-muted flex-shrink-0 sm:w-5 sm:h-5" />
                  ) : (
                    <ChevronRight size={18} className="text-muted flex-shrink-0 sm:w-5 sm:h-5" />
                  )}
                  <span className="font-semibold tracking-tight text-text-strong capitalize text-sm sm:text-base truncate">
                    {categoryGroup.category.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs sm:text-sm text-muted hidden sm:inline whitespace-nowrap">
                    {t('problemAnalysis:tree.sub', { count: categoryGroup.subcategories.length })} • {t('problemAnalysis:tree.reviews', { count: categoryGroup.totalItems })}
                  </span>
                  {categoryGroup.urgentCount > 0 && (
                    <span className="badge badge-warn font-mono flex-shrink-0" title={t('problemAnalysis:stats.urgent')}>
                      <AlertTriangle size={12} aria-hidden="true" />
                      {categoryGroup.urgentCount}
                    </span>
                  )}
                </div>
              </button>

              {/* Subcategories List */}
              {expandedCategories.has(categoryGroup.category) && (
                <div className="divide-y divide-border">
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
