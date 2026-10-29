/**
 * @fileoverview Problem analysis page with hierarchical grouping.
 *
 * Features:
 * - Groups feedback by category > subcategory > problem, over the whole window,
 *   on the server (`GET /feedback/problems`, useProblemTree)
 * - Merges similar problems by wording, at the Similarity setting
 * - Shows root cause hypotheses from AI analysis
 * - Urgency indicators and sentiment in words
 * - Expandable tree view for drill-down
 *
 * The filters live in the URL (`useProblemFilters`); the subcategory list narrows to
 * the chosen category.
 *
 * @module pages/ProblemAnalysis
 */

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, MessageSquare, TrendingUp, X, Layers } from 'lucide-react'
import { api, getDateRangeParams } from '../../api/client'
import MetricCard from '../../components/MetricCard/MetricCard'
import { useConfigStore } from '../../store/configStore'
import { applyResolution } from './problemResolution'
import type { CategoryGroup } from '../../api/problemsApi'
import { useProblemResolution } from './useProblemResolution'
import { useProblemTree } from './useProblemTree'
import { toggleSetMember } from './toggleSetMember'
import { WindowCoverageNotice } from './WindowCoverageNotice'
import { toPDFCategories } from './problemGrouping'
import { rankEntityKeys } from '../Categories/entityCounts'
import { generateProblemAnalysisPDF } from './problemAnalysisPdfGenerator'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { CenteredSpinner, ExportPageHeader } from '../Categories/ExportPageHeader'
import { useProblemFilters } from './useProblemFilters'
import { ProblemFiltersBar } from './ProblemFiltersBar'
import { ProblemTree } from './ProblemTree'
import type { TreeExpansion } from './ProblemTree'

// Empty state distinguishes "nothing in this window" from "everything here
// is resolved" — hiding data behind the toggle must not read as no data.
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

function StatRow({ groups }: Readonly<{ groups: readonly CategoryGroup[] }>) {
  const { t } = useTranslation('problemAnalysis')
  const subcategories = groups.reduce((sum, g) => sum + g.subcategories.length, 0)
  const problems = groups.reduce((sum, g) => sum + g.subcategories.reduce((s, sub) => s + sub.problemCount, 0), 0)
  const reviews = groups.reduce((sum, g) => sum + g.totalItems, 0)
  const urgent = groups.reduce((sum, g) => sum + g.urgentCount, 0)
  const icon = (Icon: typeof TrendingUp) => <Icon size={18} aria-hidden="true" />
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-3 sm:gap-4">
      <MetricCard icon={icon(TrendingUp)} title={t('stats.categories')} value={groups.length} />
      <MetricCard icon={icon(Layers)} title={t('stats.subcategories')} value={subcategories} />
      <MetricCard icon={icon(AlertTriangle)} title={t('stats.problems')} value={problems} />
      <MetricCard icon={icon(MessageSquare)} title={t('stats.reviewsWithProblem')} value={reviews} />
      <MetricCard icon={icon(AlertTriangle)} title={t('stats.urgentReviews')} value={urgent} color="warn" />
    </div>
  )
}

// Rendered when persisting a resolve/unresolve fails.
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

/** Problems the server listed (it leaves out the long tail past its cap). */
function listedProblems(groups: readonly CategoryGroup[]): number {
  return groups.reduce((sum, g) => sum + g.subcategories.reduce((s, sub) => s + sub.problems.length, 0), 0)
}

/**
 * Expansion state of the tree. "Expand all" opens every category and subcategory but
 * NOT every problem's review list: on a wide window that was thousands of cards at once.
 * A problem opens on its own; a subcategory lists its problems ten at a time.
 */
function useTreeExpansion(groups: readonly CategoryGroup[]) {
  const [categories, setCategories] = useState<Set<string>>(new Set())
  const [subcategories, setSubcategories] = useState<Set<string>>(new Set())
  const [problems, setProblems] = useState<Set<string>>(new Set())
  const expansion: TreeExpansion = {
    categories, subcategories, problems,
    toggleCategory: (key) => setCategories((prev) => toggleSetMember(prev, key)),
    toggleSubcategory: (key) => setSubcategories((prev) => toggleSetMember(prev, key)),
    toggleProblem: (key) => setProblems((prev) => toggleSetMember(prev, key)),
  }
  const expandAll = () => {
    setCategories(new Set(groups.map((g) => g.category)))
    setSubcategories(new Set(groups.flatMap((g) => g.subcategories.map((s) => `${g.category}:${s.subcategory}`))))
  }
  const collapseAll = () => {
    setCategories(new Set())
    setSubcategories(new Set())
    setProblems(new Set())
  }
  return { expansion, expandAll, collapseAll }
}

export default function ProblemAnalysis() {
  const { t } = useTranslation(['common', 'problemAnalysis'])
  const labels = useDisplayLabels()
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const filters = useProblemFilters()

  const { data: entitiesData } = useQuery({
    queryKey: ['entities', dateParams],
    queryFn: () => api.getEntities({ ...dateParams, limit: 100 }),
    enabled: !!config.apiEndpoint,
  })

  // The whole window, aggregated on the server; `isPartial` is the server's word.
  const problemTree = useProblemTree(dateParams, filters, config.apiEndpoint)

  // Resolved problems are shared across users (issue #66).
  const {
    resolvedMap, resolvedLoading, pendingKeys, toggleFailed,
    toggleResolved, dismissToggleError,
  } = useProblemResolution(!!config.apiEndpoint)

  const allSources = useMemo(() => rankEntityKeys(entitiesData, 'sources'), [entitiesData])
  const allCategories = useMemo(() => rankEntityKeys(entitiesData, 'categories'), [entitiesData])

  // Annotate problem groups with their shared resolved status and hide the
  // resolved ones unless requested (issue #66).
  const { visible: visibleData, resolvedCount } = useMemo(
    () => applyResolution(problemTree.categories, resolvedMap, filters.showResolved),
    [problemTree.categories, resolvedMap, filters.showResolved],
  )
  const tree = useTreeExpansion(visibleData)

  const exportPDF = () => {
    if (visibleData.length === 0) return
    try {
      generateProblemAnalysisPDF({
        categories: toPDFCategories(visibleData, labels),
        timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
        resolvedLabel: t('problemResolution.resolved'),
        filters: { source: filters.source, category: filters.category, subcategory: filters.subcategory, urgentOnly: filters.urgentOnly },
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
  if (problemTree.isLoading || resolvedLoading) {
    return <CenteredSpinner />
  }

  // Nothing was read: say the window is unknown instead of implying it is empty.
  if (problemTree.isError) {
    return (
      <div className="flex items-center justify-center h-full">
        <WindowCoverageNotice isPartial={false} hasFailed onRetry={problemTree.retry} />
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
      <StatRow groups={visibleData} />
      {/* Coverage of the counts above; self-hiding when the window was read in full. */}
      <WindowCoverageNotice
        isPartial={problemTree.isPartial}
        hasFailed={false}
        scannedThrough={problemTree.scannedThrough}
        truncated={problemTree.problemsTruncated ? { listed: listedProblems(problemTree.categories), total: problemTree.problemCount } : undefined}
      />
      <ProblemFiltersBar
        filters={filters}
        sources={allSources}
        categories={allCategories}
        subcategories={problemTree.subcategories}
        resolvedCount={resolvedCount}
        typeCounts={problemTree.typeCounts}
        onExpandAll={tree.expandAll}
        onCollapseAll={tree.collapseAll}
      />
      <ResolveErrorBanner show={toggleFailed} onDismiss={dismissToggleError} />
      {visibleData.length === 0
        ? <EmptyProblemsState resolvedCount={resolvedCount} />
        : <ProblemTree groups={visibleData} expansion={tree.expansion} onToggleResolved={toggleResolved} pendingKeys={pendingKeys} />}
    </div>
  )
}
