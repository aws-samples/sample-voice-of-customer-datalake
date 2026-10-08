import { Download, LayoutGrid, List, SearchX } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import FeedbackCard from '../../components/FeedbackCard/FeedbackCard'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { NO_FAILED_READS, type FailedReads } from '../../utils/failedReads'
import { ratingFilterLabel } from './types'
import type { ViewMode, SentimentFilter, RatingFilter } from './types'

interface FeedbackResultsProps {
  readonly filteredFeedback: FeedbackItem[]
  readonly feedbackLoading: boolean
  readonly viewMode: ViewMode
  readonly onViewModeChange: (mode: ViewMode) => void
  readonly selectedSource: string | null
  readonly selectedCategories: string[]
  readonly sentimentFilter: SentimentFilter
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
}

/**
 * "Showing N of TOTAL" line with the partial-window "N+" hint, ported from
 * the removed Feedback page. When the backend truncated the candidate
 * window, `totalCount` is a lower bound — show "N+" plus a narrow-filters
 * hint, but only when there genuinely are more matches than displayed.
 */
function ResultsCountLine({
  itemCount,
  totalCount,
  isPartialWindow,
}: Readonly<{ itemCount: number; totalCount: number; isPartialWindow: boolean }>) {
  const { t } = useTranslation('common')
  const showPartial = isPartialWindow && totalCount > itemCount
  const totalLabel = showPartial ? `${totalCount}+` : `${totalCount}`
  return (
    <p className="text-xs sm:text-sm text-muted">
      {t('showingOf', { count: itemCount, total: totalLabel })}
      {showPartial && <span className="ml-1 text-warn">({t('partialWindowHint')})</span>}
    </p>
  )
}

function ActiveFiltersLine({
  selectedSource,
  selectedCategories,
  sentimentFilter,
  ratingFilter,
}: Readonly<{
  selectedSource: string | null
  selectedCategories: string[]
  sentimentFilter: SentimentFilter
  ratingFilter: RatingFilter
}>) {
  const { t } = useTranslation(['common', 'categories'])
  const sentimentText = sentimentFilter !== 'all' ? t(`categories:${sentimentFilter}`) : null
  return (
    <p className="text-xs sm:text-sm text-muted truncate">
      {selectedSource && t('categories:sourceFilterLabel', { source: selectedSource })}
      {selectedCategories.length > 0 && `${selectedSource ? ' • ' : ''}${selectedCategories.map(c => c.replace(/_/g, ' ')).join(', ')}`}
      {sentimentText && ` • ${sentimentText}`}
      {ratingFilter.value > 0 && ` • ${ratingFilterLabel(ratingFilter, t)}`}
    </p>
  )
}

export function FeedbackResults({
  filteredFeedback,
  feedbackLoading,
  viewMode,
  onViewModeChange,
  selectedSource,
  selectedCategories,
  sentimentFilter,
  ratingFilter,
  onExport,
  totalCount,
  isPartialWindow,
  hasMore,
  onLoadMore,
  isLoadingMore,
  failure = NO_FAILED_READS,
}: FeedbackResultsProps) {
  const { t } = useTranslation(['common', 'categories'])
  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold tracking-tight text-text-strong">
            {t('categories:feedbackResults')}
            <span className="ml-2 text-sm font-mono font-normal text-muted">({filteredFeedback.length})</span>
          </h2>
          <ResultsCountLine
            itemCount={filteredFeedback.length}
            totalCount={totalCount}
            isPartialWindow={isPartialWindow}
          />
          <ActiveFiltersLine
            selectedSource={selectedSource}
            selectedCategories={selectedCategories}
            sentimentFilter={sentimentFilter}
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

function FeedbackContentDisplay({ isLoading, items, viewMode, failure }: Readonly<{ isLoading: boolean; items: FeedbackItem[]; viewMode: ViewMode; failure: FailedReads }>) {
  const { t } = useTranslation(['common', 'categories'])
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 sm:py-12">
        <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-accent"></div>
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
    <div className={clsx(viewMode === 'grid' ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4' : 'space-y-2 sm:space-y-3')}>
      {items.map((item) => (
        <FeedbackCard key={item.feedback_id} feedback={item} compact={viewMode === 'list'} />
      ))}
    </div>
  )
}
