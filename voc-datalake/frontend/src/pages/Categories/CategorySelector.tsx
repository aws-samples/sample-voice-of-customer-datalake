import { Filter, X, ChevronDown, Star } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { CategoryData, SentimentFilter } from './types'

interface CategorySelectorProps {
  readonly categoryData: CategoryData[]
  readonly totalIssues: number
  readonly selectedCategories: string[]
  readonly onToggleCategory: (category: string) => void
  readonly hasActiveFilters: boolean
  readonly onClearFilters: () => void
  readonly showFilters: boolean
  readonly onToggleFilters: () => void
  readonly minRating: number
  readonly onMinRatingChange: (rating: number) => void
  readonly sentimentFilter: SentimentFilter
  readonly onSentimentFilterChange: (filter: SentimentFilter) => void
}

export function CategorySelector({
  categoryData,
  totalIssues,
  selectedCategories,
  onToggleCategory,
  hasActiveFilters,
  onClearFilters,
  showFilters,
  onToggleFilters,
  minRating,
  onMinRatingChange,
  sentimentFilter,
  onSentimentFilterChange,
}: CategorySelectorProps) {
  const { t } = useTranslation('categories')

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <h2 className="text-base sm:text-lg font-semibold">{t('selectCategoriesToExplore')}</h2>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <button onClick={onClearFilters} className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
              <X size={14} />
              <span className="hidden xs:inline">{t('clearFilters')}</span>
              <span className="xs:hidden">{t('clear')}</span>
            </button>
          )}
          <button
            onClick={onToggleFilters}
            className={clsx(
              'flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition-colors active:scale-95',
              showFilters ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 hover:bg-gray-200'
            )}
          >
            <Filter size={14} />
            <span className="hidden xs:inline">{t('filters')}</span>
            <ChevronDown size={14} className={clsx('transition-transform', showFilters && 'rotate-180')} />
          </button>
        </div>
      </div>

      {showFilters && (
        <AdvancedFilters
          minRating={minRating}
          onMinRatingChange={onMinRatingChange}
          sentimentFilter={sentimentFilter}
          onSentimentFilterChange={onSentimentFilterChange}
        />
      )}

      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {categoryData.map((category) => {
          const isSelected = selectedCategories.includes(category.name)
          const percentage = ((category.value / totalIssues) * 100).toFixed(1)
          return (
            <button
              key={category.name}
              onClick={() => onToggleCategory(category.name)}
              className={clsx(
                'flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-full border-2 transition-all text-xs sm:text-sm active:scale-95',
                isSelected ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              )}
            >
              <span className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full flex-shrink-0" style={{ backgroundColor: category.color }} />
              <span className="font-medium capitalize truncate max-w-[100px] sm:max-w-none">{category.name.replace('_', ' ')}</span>
              <span className="text-gray-500">{category.value}</span>
              <span className="text-gray-400 hidden xs:inline">({percentage}%)</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function AdvancedFilters({
  minRating,
  onMinRatingChange,
  sentimentFilter,
  onSentimentFilterChange,
}: Readonly<{
  minRating: number
  onMinRatingChange: (rating: number) => void
  sentimentFilter: SentimentFilter
  onSentimentFilterChange: (filter: SentimentFilter) => void
}>) {
  const { t } = useTranslation('categories')

  return (
    <div className="mb-3 sm:mb-4 p-3 sm:p-4 bg-gray-50 rounded-lg flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4">
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('minRating')}</label>
        <div className="flex gap-0.5 sm:gap-1">
          {[0, 1, 2, 3, 4, 5].map(rating => (
            <button
              key={rating}
              onClick={() => onMinRatingChange(rating)}
              className={clsx('p-1 sm:p-1.5 rounded transition-colors active:scale-95', minRating === rating ? 'bg-yellow-100' : 'hover:bg-gray-200')}
            >
              {rating === 0 ? (
                <span className="text-xs text-gray-500 px-1">{t('any')}</span>
              ) : (
                <Star size={14} className="sm:w-4 sm:h-4" fill={minRating >= rating ? '#eab308' : 'none'} color={minRating >= rating ? '#eab308' : '#d1d5db'} />
              )}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">{t('sentiment')}</label>
        <select
          value={sentimentFilter}
          onChange={(e) => {
            const val = e.target.value
            if (val === 'all' || val === 'positive' || val === 'negative' || val === 'neutral' || val === 'mixed') {
              onSentimentFilterChange(val)
            }
          }}
          className="px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm w-full sm:w-auto"
        >
          <option value="all">{t('allSentiments')}</option>
          <option value="positive">{t('positive')}</option>
          <option value="neutral">{t('neutral')}</option>
          <option value="negative">{t('negative')}</option>
          <option value="mixed">{t('mixed')}</option>
        </select>
      </div>
    </div>
  )
}
