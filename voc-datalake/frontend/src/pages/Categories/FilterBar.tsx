/**
 * @fileoverview Unified filter bar for the Categories page (issue #198 UX
 * rationalization). Merges the previously scattered controls — free-text
 * search, source select, urgent-only toggle, min-rating — into one card,
 * with a clear-all button next to everything it clears.
 *
 * Sentiment is intentionally NOT here: the Overall Sentiment gauge legend
 * is the single sentiment control. Categories are selected via the
 * Category Distribution rows.
 *
 * @module pages/Categories/FilterBar
 */

import { Search, Star, X } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { RatingDirection, RatingFilter } from './types'

interface FilterBarProps {
  readonly searchText: string
  readonly onSearchChange: (value: string) => void
  readonly selectedSource: string | null
  readonly onSourceChange: (source: string | null) => void
  readonly allSources: string[]
  readonly showUrgentOnly: boolean
  readonly onUrgentChange: (value: boolean) => void
  readonly ratingFilter: RatingFilter
  readonly onRatingFilterChange: (filter: RatingFilter) => void
  readonly hasActiveFilters: boolean
  readonly onClearFilters: () => void
  /** Optional content pinned to the far right of the bar (e.g. Export PDF). */
  readonly trailing?: React.ReactNode
}

export function FilterBar({
  searchText,
  onSearchChange,
  selectedSource,
  onSourceChange,
  allSources,
  showUrgentOnly,
  onUrgentChange,
  ratingFilter,
  onRatingFilterChange,
  hasActiveFilters,
  onClearFilters,
  trailing,
}: FilterBarProps) {
  const { t } = useTranslation('categories')
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-11"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <select
            value={selectedSource || ''}
            onChange={(e) => onSourceChange(e.target.value || null)}
            aria-label={t('filterBySource')}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">{t('allSources')}</option>
            {allSources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <RatingPicker ratingFilter={ratingFilter} onRatingFilterChange={onRatingFilterChange} />
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={showUrgentOnly}
              onChange={(e) => onUrgentChange(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">{t('urgentOnly')}</span>
          </label>
          {hasActiveFilters && (
            <button
              onClick={onClearFilters}
              className="flex items-center gap-1 text-xs sm:text-sm text-gray-500 hover:text-gray-700 whitespace-nowrap"
            >
              <X size={14} />
              {t('clearFilters')}
            </button>
          )}
        </div>
        {trailing && (
          <div
            data-testid="filter-bar-trailing"
            className="flex items-center lg:ml-auto lg:border-l lg:border-gray-200 lg:pl-4"
          >
            {trailing}
          </div>
        )}
      </div>
    </div>
  )
}

function starTitle(t: TFunction<'categories'>, rating: number, direction: RatingDirection): string {
  if (rating === 0) return t('anyRating')
  return direction === 'up' ? t('starsMin', { count: rating }) : t('starsMax', { count: rating })
}

function RatingPicker({
  ratingFilter,
  onRatingFilterChange,
}: Readonly<{ ratingFilter: RatingFilter; onRatingFilterChange: (filter: RatingFilter) => void }>) {
  const { t } = useTranslation('categories')
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <div className="flex items-center gap-0.5 sm:gap-1" role="group" aria-label={t('starRating')}>
        {[0, 1, 2, 3, 4, 5].map(rating => (
          <button
            key={rating}
            onClick={() => onRatingFilterChange({ ...ratingFilter, value: rating })}
            title={starTitle(t, rating, ratingFilter.direction)}
            className={clsx(
              'p-1 sm:p-1.5 rounded transition-colors active:scale-95',
              ratingFilter.value === rating ? 'bg-yellow-100' : 'hover:bg-gray-100'
            )}
          >
            {rating === 0 ? (
              <span className="text-xs text-gray-500 px-1">{t('any')}</span>
            ) : (
              <Star
                size={14}
                className="sm:w-4 sm:h-4"
                fill={ratingFilter.value >= rating ? '#eab308' : 'none'}
                color={ratingFilter.value >= rating ? '#eab308' : '#d1d5db'}
              />
            )}
          </button>
        ))}
      </div>
      <RatingDirectionToggle ratingFilter={ratingFilter} onRatingFilterChange={onRatingFilterChange} />
    </div>
  )
}

/**
 * Two-option radiogroup with the full keyboard pattern: arrow keys move the
 * selection, and only the checked option is tabbable (roving tabindex).
 * With exactly two options, any arrow key selects the other one.
 */
function RatingDirectionToggle({
  ratingFilter,
  onRatingFilterChange,
}: Readonly<{ ratingFilter: RatingFilter; onRatingFilterChange: (filter: RatingFilter) => void }>) {
  const { t } = useTranslation('categories')

  const select = (direction: RatingDirection) => onRatingFilterChange({ ...ratingFilter, direction })

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next: RatingDirection = ratingFilter.direction === 'up' ? 'below' : 'up'
    select(next)
    const radios = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    radios[next === 'up' ? 0 : 1]?.focus()
  }

  return (
    <div
      className="flex items-center rounded-lg bg-gray-100 p-0.5 text-xs"
      role="radiogroup"
      aria-label={t('ratingDirection')}
      onKeyDown={handleKeyDown}
    >
      <DirectionOption
        label={t('ratingUp')}
        title={t('ratingUpTitle')}
        checked={ratingFilter.direction === 'up'}
        onSelect={() => select('up')}
      />
      <DirectionOption
        label={t('ratingBelow')}
        title={t('ratingBelowTitle')}
        checked={ratingFilter.direction === 'below'}
        onSelect={() => select('below')}
      />
    </div>
  )
}

function DirectionOption({
  label,
  title,
  checked,
  onSelect,
}: Readonly<{ label: string; title: string; checked: boolean; onSelect: () => void }>) {
  return (
    <button
      onClick={onSelect}
      title={title}
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className={clsx(
        'px-1.5 py-0.5 rounded whitespace-nowrap transition-colors active:scale-95',
        checked ? 'bg-white shadow-sm text-gray-700' : 'text-gray-500 hover:text-gray-700'
      )}
    >
      {label}
    </button>
  )
}
