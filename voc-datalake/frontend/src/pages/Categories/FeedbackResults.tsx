import { Download, LayoutGrid, List } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/client'
import FeedbackCard from '../../components/FeedbackCard'
import type { ViewMode, SentimentFilter } from './types'

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
}: FeedbackResultsProps) {
  const { t } = useTranslation('categories')

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold">
            {t('feedbackResults')}
            <span className="ml-2 text-sm font-normal text-gray-500">({filteredFeedback.length})</span>
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 truncate">
            {selectedSource && `Source: ${selectedSource}`}
            {selectedCategories.length > 0 && `${selectedSource ? ' • ' : ''}${selectedCategories.map(c => c.replace('_', ' ')).join(', ')}`}
            {selectedKeywords.length > 0 && `${selectedSource || selectedCategories.length > 0 ? ' • ' : ''}${selectedKeywords.join(', ')}`}
            {sentimentFilter !== 'all' && ` • ${sentimentFilter}`}
            {minRating > 0 && ` • ${t('starsMin', { count: minRating })}`}
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
    </div>
  )
}

function FeedbackContentDisplay({ isLoading, items, viewMode }: Readonly<{ isLoading: boolean; items: FeedbackItem[]; viewMode: ViewMode }>) {
  const { t } = useTranslation('categories')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 sm:py-12">
        <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-blue-600"></div>
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
