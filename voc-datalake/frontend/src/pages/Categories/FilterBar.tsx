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
  /** A second row of filters (channel, dimensions, tag). */
  readonly children?: React.ReactNode
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
  children,
}: FilterBarProps) {
  const { t } = useTranslation('categories')
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" size={16} aria-hidden="true" />
          <input
            type="search"
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-10"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <select
            value={selectedSource ?? ''}
            onChange={(e) => onSourceChange(e.target.value || null)}
            aria-label={t('filterBySource')}
            className="select w-auto"
          >
            <option value="">{t('allSources')}</option>
            {allSources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <RatingPicker ratingFilter={ratingFilter} onRatingFilterChange={onRatingFilterChange} />
          <label className="flex items-center gap-2 min-h-9 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={showUrgentOnly}
              onChange={(e) => onUrgentChange(e.target.checked)}
              className="rounded-sm accent-accent focus-ring"
            />
            <span className="text-sm text-text">{t('urgentOnly')}</span>
          </label>
          {hasActiveFilters && (
            <button
              onClick={onClearFilters}
              className="btn btn-ghost btn-sm whitespace-nowrap"
            >
              <X size={14} />
              {t('clearFilters')}
            </button>
          )}
        </div>
        {trailing && (
          <div
            data-testid="filter-bar-trailing"
            className="flex items-center lg:ml-auto lg:border-l lg:border-border lg:pl-4"
          >
            {trailing}
          </div>
        )}
      </div>
      {children}
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
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0">
      <div className="flex items-center gap-0.5 sm:gap-1" role="group" aria-label={t('starRating')}>
        {[0, 1, 2, 3, 4, 5].map(rating => (
          <button
            key={rating}
            onClick={() => onRatingFilterChange({ ...ratingFilter, value: rating })}
            title={starTitle(t, rating, ratingFilter.direction)}
            aria-label={starTitle(t, rating, ratingFilter.direction)}
            aria-pressed={ratingFilter.value === rating}
            className={clsx(
              'min-h-9 min-w-9 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center p-1 sm:p-1.5 rounded-md transition-colors active:scale-95 focus-ring',
              ratingFilter.value === rating ? 'bg-accent-subtle ring-1 ring-inset ring-accent/40' : 'hover:bg-bg-hover'
            )}
          >
            {rating === 0 ? (
              <span className={clsx('text-xs px-1', ratingFilter.value === 0 ? 'text-accent-text font-medium' : 'text-muted')}>{t('any')}</span>
            ) : (
              <Star
                size={16}
                aria-hidden="true"
                fill={ratingFilter.value >= rating ? 'var(--warn)' : 'none'}
                color={ratingFilter.value >= rating ? 'var(--warn)' : 'var(--border-strong)'}
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
    Array.from(radios).at(next === 'up' ? 0 : 1)?.focus()
  }

  return (
    <div
      className="tabs-track"
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
      className={clsx('tab', checked && 'tab-active')}
    >
      {label}
    </button>
  )
}
