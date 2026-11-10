import { Download, LayoutGrid, List, SearchX, X } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { NO_FAILED_READS, type FailedReads } from '../../utils/failedReads'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { ratingFilterLabel } from './types'
import type { ViewMode, RatingFilter } from './types'

interface FeedbackResultsProps {
  readonly filteredFeedback: FeedbackItem[]
  readonly feedbackLoading: boolean
  readonly viewMode: ViewMode
  readonly onViewModeChange: (mode: ViewMode) => void
  readonly selectedSources: readonly string[]
  readonly selectedCategories: readonly string[]
  readonly selectedSentiments: readonly string[]
  readonly selectedUsefulness: readonly string[]
  readonly ratingFilter: RatingFilter
  /** CSV export of the currently filtered items. PDF export lives in the page-level filter bar. */
  readonly onExport: () => void
  /** Candidate-window size reported by the backend ("N of TOTAL"). */
  readonly totalCount: number
  /** True when the backend truncated the candidate window ("N+"). */
  readonly isPartialWindow: boolean
  /** True when more pages can be loaded (list endpoint only). */
  readonly hasMore: boolean
  readonly onLoadMore: () => void
  readonly isLoadingMore: boolean
  /** The list read failed with nothing to show; absent = it did not. */
  readonly failure?: FailedReads
  /** The active subcategory filter, shown as a removable chip; absent = none. */
  readonly subcategory?: { readonly id: string; readonly onClear: () => void } | null
}

/** Which sentence the count line says. */
type CountCopy = 'allShown' | 'moreBelow' | 'truncated' | 'shownOf'

function countCopyOf(itemCount: number, totalCount: number, isPartialWindow: boolean, hasMore: boolean): CountCopy {
  if (hasMore) return 'moreBelow'
  if (isPartialWindow && totalCount > itemCount) return 'truncated'
  return totalCount > itemCount ? 'shownOf' : 'allShown'
}

/**
 * One plain sentence about what is on screen: "120 reviews", "100 shown · Load
 * more below" (another page exists), "100 shown · narrow the filters to see the
 * rest" (the server capped the window), or "100 shown of 150". While the list
 * loads it is a skeleton bar, never "0 of 0".
 */
function ResultsCountLine({
  itemCount,
  totalCount,
  isPartialWindow,
  hasMore,
  isLoading,
}: Readonly<{ itemCount: number; totalCount: number; isPartialWindow: boolean; hasMore: boolean; isLoading: boolean }>) {
  const { t } = useTranslation('categories')
  if (isLoading) {
    return <span data-testid="results-count-skeleton" aria-hidden="true" className="block h-4 w-32 mt-1 rounded-sm bg-bg-hover animate-pulse" />
  }
  const copy = countCopyOf(itemCount, totalCount, isPartialWindow, hasMore)
  return (
    <p className={clsx('text-xs sm:text-sm', copy === 'truncated' ? 'text-warn' : 'text-muted')}>
      {t(`results.${copy}`, { count: itemCount, total: totalCount })}
    </p>
  )
}

/** The active subcategory filter as a labelled, removable chip. */
function SubcategoryChip({ subcategory, parent, onClear }: Readonly<{ subcategory: string; parent?: string; onClear: () => void }>) {
  const { t } = useTranslation('categories')
  const labels = useDisplayLabels()
  const name = labels.subcategory(subcategory, parent)
  return (
    <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs bg-accent-subtle text-accent-text">
      {t('results.subcategoryChip', { name })}
      <button type="button" onClick={onClear} aria-label={t('results.removeSubcategory', { name })} title={t('results.removeSubcategory', { name })} className="rounded-full focus-ring hover:text-text-strong">
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  )
}

type ActiveFilters = Pick<FeedbackResultsProps,
  'selectedSources' | 'selectedCategories' | 'selectedSentiments' | 'selectedUsefulness' | 'ratingFilter'>

/** "Source: Web, App • Delivery • Negative • High usefulness • 3+ stars": one part per set filter. */
function ActiveFiltersLine({ selectedSources, selectedCategories, selectedSentiments, selectedUsefulness, ratingFilter }: Readonly<ActiveFilters>) {
  const { t } = useTranslation(['common', 'categories', 'components'])
  const labels = useDisplayLabels()
  const parts = [
    selectedSources.length > 0 ? t('categories:sourceFilterLabel', { source: selectedSources.map(labels.source).join(', ') }) : '',
    selectedCategories.map(labels.category).join(', '),
    selectedSentiments.map((value) => t(`categories:${value}`)).join(', '),
    selectedUsefulness.map((value) => t(`components:facetFilters.usefulnessValues.${value}`)).join(', '),
    ratingFilter.value > 0 ? ratingFilterLabel(ratingFilter, t) : '',
  ].filter(Boolean)
  return <p className="text-xs sm:text-sm text-muted break-words">{parts.join(' • ')}</p>
}

export function FeedbackResults({
  filteredFeedback,
  feedbackLoading,
  viewMode,
  onViewModeChange,
  selectedSources,
  selectedCategories,
  selectedSentiments,
  selectedUsefulness,
  ratingFilter,
  onExport,
  totalCount,
  isPartialWindow,
  hasMore,
  onLoadMore,
  isLoadingMore,
  failure = NO_FAILED_READS,
  subcategory = null,
}: FeedbackResultsProps) {
  const { t } = useTranslation(['common', 'categories'])
  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold tracking-tight text-text-strong">
            {t('categories:feedbackResults')}
          </h2>
          <ResultsCountLine
            itemCount={filteredFeedback.length}
            totalCount={totalCount}
            isPartialWindow={isPartialWindow}
            hasMore={hasMore}
            isLoading={feedbackLoading}
          />
          {subcategory && <SubcategoryChip subcategory={subcategory.id} parent={selectedCategories.at(0)} onClear={subcategory.onClear} />}
          <ActiveFiltersLine
            selectedSources={selectedSources}
            selectedCategories={selectedCategories}
            selectedSentiments={selectedSentiments}
            selectedUsefulness={selectedUsefulness}
            ratingFilter={ratingFilter}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="tabs-track" role="group" aria-label={t('categories:viewMode')}>
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              className={clsx('tab', viewMode === 'grid' && 'tab-active')}
              aria-label={t('categories:gridView')}
              title={t('categories:gridView')}
              aria-pressed={viewMode === 'grid'}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              className={clsx('tab', viewMode === 'list' && 'tab-active')}
              aria-label={t('categories:listView')}
              title={t('categories:listView')}
              aria-pressed={viewMode === 'list'}
            >
              <List size={14} />
            </button>
          </div>
          <button
            onClick={onExport}
            title={t('exportCsvTooltip')}
            aria-label={t('exportCsvTooltip')}
            className="btn btn-secondary btn-sm"
          >
            <Download size={14} aria-hidden="true" />
            <span className="hidden sm:inline">{t('exportCsvShort')}</span>
          </button>
        </div>
      </div>
      <FeedbackContentDisplay isLoading={feedbackLoading} items={filteredFeedback} viewMode={viewMode} failure={failure} />
      {hasMore && !feedbackLoading && (
        <div className="flex justify-center mt-3 sm:mt-4">
          <button
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="btn btn-secondary btn-sm"
          >
            {isLoadingMore ? t('loading') : t('loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}

/** The list's grid or stacked layout (the skeleton uses the same one, so nothing jumps). */
function layoutClass(viewMode: ViewMode): string {
  return viewMode === 'grid' ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4' : 'space-y-2 sm:space-y-3'
}

function FeedbackContentDisplay({ isLoading, items, viewMode, failure }: Readonly<{ isLoading: boolean; items: FeedbackItem[]; viewMode: ViewMode; failure: FailedReads }>) {
  const { t } = useTranslation(['common', 'categories'])
  if (isLoading) {
    return (
      <div role="status" aria-label={t('categories:results.loading')} className={layoutClass(viewMode)}>
        {[0, 1, 2, 3].map((n) => <div key={n} data-testid="feedback-skeleton" className="h-28 rounded-lg bg-bg-hover animate-pulse" />)}
      </div>
    )
  }
  // Before the empty state: a failed read is not "no feedback found".
  if (failure.loadFailed) {
    return <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 text-center py-8 sm:py-12">
        <SearchX size={20} className="text-muted" aria-hidden="true" />
        <p className="text-sm font-medium text-text-strong">{t('categories:noFeedbackFound')}</p>
        <p className="text-xs text-muted">{t('categories:noFeedbackHint')}</p>
      </div>
    )
  }
  return (
    <div className={layoutClass(viewMode)}>
      {items.map((item) => (
        <FeedbackCard key={item.feedback_id} feedback={item} compact={viewMode === 'list'} />
      ))}
    </div>
  )
}
