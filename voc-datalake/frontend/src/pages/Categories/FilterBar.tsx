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

interface FilterBarProps {
  readonly searchText: string
  readonly onSearchChange: (value: string) => void
  readonly selectedSource: string | null
  readonly onSourceChange: (source: string | null) => void
  readonly allSources: string[]
  readonly showUrgentOnly: boolean
  readonly onUrgentChange: (value: boolean) => void
  readonly minRating: number
  readonly onMinRatingChange: (rating: number) => void
  readonly hasActiveFilters: boolean
  readonly onClearFilters: () => void
}

export function FilterBar({
  searchText,
  onSearchChange,
  selectedSource,
  onSourceChange,
  allSources,
  showUrgentOnly,
  onUrgentChange,
  minRating,
  onMinRatingChange,
  hasActiveFilters,
  onClearFilters,
}: FilterBarProps) {
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
          <input
            type="text"
            placeholder="Search feedback..."
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-11"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <select
            value={selectedSource || ''}
            onChange={(e) => onSourceChange(e.target.value || null)}
            aria-label="Filter by source"
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All Sources</option>
            {allSources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <MinRatingPicker minRating={minRating} onMinRatingChange={onMinRatingChange} />
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={showUrgentOnly}
              onChange={(e) => onUrgentChange(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Urgent only</span>
          </label>
          {hasActiveFilters && (
            <button
              onClick={onClearFilters}
              className="flex items-center gap-1 text-xs sm:text-sm text-gray-500 hover:text-gray-700 whitespace-nowrap"
            >
              <X size={14} />
              Clear filters
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MinRatingPicker({
  minRating,
  onMinRatingChange,
}: Readonly<{ minRating: number; onMinRatingChange: (rating: number) => void }>) {
  return (
    <div className="flex items-center gap-0.5 sm:gap-1" role="group" aria-label="Minimum rating">
      {[0, 1, 2, 3, 4, 5].map(rating => (
        <button
          key={rating}
          onClick={() => onMinRatingChange(rating)}
          title={rating === 0 ? 'Any rating' : `${rating}+ stars`}
          className={clsx(
            'p-1 sm:p-1.5 rounded transition-colors active:scale-95',
            minRating === rating ? 'bg-yellow-100' : 'hover:bg-gray-100'
          )}
        >
          {rating === 0 ? (
            <span className="text-xs text-gray-500 px-1">Any</span>
          ) : (
            <Star
              size={14}
              className="sm:w-4 sm:h-4"
              fill={minRating >= rating ? '#eab308' : 'none'}
              color={minRating >= rating ? '#eab308' : '#d1d5db'}
            />
          )}
        </button>
      ))}
    </div>
  )
}
