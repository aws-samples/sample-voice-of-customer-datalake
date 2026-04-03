import clsx from 'clsx'
import {
  Download, LayoutGrid, List,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import FeedbackCard from '../../components/FeedbackCard'
import type {
  ViewMode, SentimentFilter,
} from './types'
import type { FeedbackItem } from '../../api/types'

interface FeedbackResultsProps {
  readonly filteredFeedback: FeedbackItem[]
  readonly feedbackLoading: boolean
  readonly viewMode: ViewMode
  readonly onViewModeChange: (mode: ViewMode) => void
  readonly selectedSource: string | null
  readonly selectedCategories: string[]
  readonly selectedKeywords: string[]
  readonly sentimentFilter: SentimentFilter
  readonly minRating: number
  readonly onExport: () => void
  readonly totalCount?: number
  readonly hasMore?: boolean
  readonly isFetchingMore?: boolean
  readonly onLoadMore?: () => void
}

function buildFilterDescription(
  props: FeedbackResultsProps,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts: string[] = []
  if (props.selectedSource != null && props.selectedSource !== '') parts.push(`Source: ${props.selectedSource}`)
  if (props.selectedCategories.length > 0) parts.push(props.selectedCategories.map((c) => c.replace('_', ' ')).join(', '))
  if (props.selectedKeywords.length > 0) parts.push(props.selectedKeywords.join(', '))
  if (props.sentimentFilter !== 'all') parts.push(props.sentimentFilter)
  if (props.minRating > 0) parts.push(t('starsMin', { count: props.minRating }))
  return parts.join(' • ')
}

export function FeedbackResults({
  filteredFeedback,
  feedbackLoading,
  viewMode,
  onViewModeChange,
  selectedSource,
  selectedCategories,
  selectedKeywords,
  sentimentFilter,
  minRating,
  onExport,
  totalCount,
  hasMore = false,
  isFetchingMore = false,
  onLoadMore,
}: FeedbackResultsProps) {
  const { t } = useTranslation('categories')
  const filterDescription = buildFilterDescription({
    filteredFeedback,
    feedbackLoading,
    viewMode,
    onViewModeChange,
    selectedSource,
    selectedCategories,
    selectedKeywords,
    sentimentFilter,
    minRating,
    onExport,
  }, t)

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold">
            {t('feedbackResults')}
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({filteredFeedback.length}{totalCount != null && totalCount > filteredFeedback.length ? ` of ${totalCount}` : ''})
            </span>
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 truncate">
            {filterDescription}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex bg-gray-100 rounded-lg p-0.5 sm:p-1">
            <button
              onClick={() => onViewModeChange('grid')}
              className={clsx('p-1.5 rounded active:scale-95', viewMode === 'grid' ? 'bg-white shadow-sm' : 'hover:bg-gray-200')}
              aria-label="Grid view"
            >
              <LayoutGrid size={14} className="sm:w-4 sm:h-4" />
            </button>
            <button
              onClick={() => onViewModeChange('list')}
              className={clsx('p-1.5 rounded active:scale-95', viewMode === 'list' ? 'bg-white shadow-sm' : 'hover:bg-gray-200')}
              aria-label="List view"
            >
              <List size={14} className="sm:w-4 sm:h-4" />
            </button>
          </div>
          <button onClick={onExport} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 py-1.5">
            <Download size={14} className="sm:w-4 sm:h-4" />
            <span className="hidden xs:inline">{t('export')}</span>
          </button>
        </div>
      </div>
      <FeedbackContentDisplay isLoading={feedbackLoading} items={filteredFeedback} viewMode={viewMode} />
      {hasMore && onLoadMore != null ? (
        <div className="flex justify-center pt-3 pb-1">
          <button
            onClick={onLoadMore}
            disabled={isFetchingMore}
            className="btn btn-secondary text-sm px-6 py-2 disabled:opacity-50"
          >
            {isFetchingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function FeedbackContentDisplay({
  isLoading, items, viewMode,
}: Readonly<{
  isLoading: boolean;
  items: FeedbackItem[];
  viewMode: ViewMode
}>) {
  const { t } = useTranslation('categories')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 sm:py-12">
        <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-blue-600" />
      </div>
    )
  }
  if (items.length === 0) {
    return <p className="text-gray-500 text-center py-8 sm:py-12 text-sm">{t('noFeedbackFound')}</p>
  }
  return (
    <div className={clsx(viewMode === 'grid' ? 'grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4' : 'space-y-2 sm:space-y-3')}>
      {items.map((item) => (
        <FeedbackCard key={item.feedback_id} feedback={item} compact={viewMode === 'list'} />
      ))}
    </div>
  )
}
