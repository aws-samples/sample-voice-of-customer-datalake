/**
 * @fileoverview The Categories page's own controls, hosted inside the shared
 * FeedbackFilterPanel: the free-text search box (always visible in the panel
 * header) and the star-rating picker (in the expanded body). Every other
 * dimension — sources, categories, sentiment, urgency, enrichment fields, custom
 * fields — is the shared panel's job.
 *
 * Sentiment and category also stay clickable on the cards themselves: the
 * gauge legend toggles sentiments and the distribution rows toggle categories,
 * both writing the same filter state the panel shows.
 *
 * @module pages/Categories/FilterBar
 */

import { Search, Star } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { RatingDirection, RatingFilter } from './types'

export function SearchBox({
  searchText,
  onSearchChange,
}: Readonly<{ searchText: string; onSearchChange: (value: string) => void }>) {
  const { t } = useTranslation('categories')
  return (
    <div className="relative min-w-0">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={16} />
      <input
        type="text"
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        value={searchText}
        onChange={(e) => onSearchChange(e.target.value)}
        className="input !pl-9 !py-1.5 text-sm"
      />
    </div>
  )
}

function starTitle(t: TFunction<'categories'>, rating: number, direction: RatingDirection): string {
  if (rating === 0) return t('anyRating')
  return direction === 'up' ? t('starsMin', { count: rating }) : t('starsMax', { count: rating })
}

export function RatingPicker({
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
