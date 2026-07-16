/**
 * @fileoverview Ranked category-distribution breakdown that doubles as the
 * category selector for the Categories page (issue #198 UX rationalization).
 *
 * Each row is a toggle: clicking selects/deselects the category as a filter
 * for the feedback list below (multi-select). Nothing selected = the list
 * shows all feedback. This replaced the separate "Select Categories to
 * Explore" chips card, which duplicated the same data.
 *
 * Only the top {@link MAX_COLLAPSED_ROWS} categories are shown by default to
 * keep the card compact; a toggle reveals the rest. Selected categories
 * outside the top rows stay visible while collapsed so deep-linked filters
 * (?category=) are never hidden.
 *
 * @module pages/Categories/CategoryDistribution
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, FolderOpen } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { CategoryData } from './types'

/** Rows shown while collapsed. */
export const MAX_COLLAPSED_ROWS = 5

interface CategoryDistributionProps {
  /** Categories sorted by value descending (as produced by the Categories page). */
  readonly categoryData: CategoryData[]
  /** Sum of all category values, used to compute each bar's percentage. */
  readonly totalIssues: number
  /** Optional lookback window (days) shown in the header. */
  readonly periodDays?: number
  /** Categories currently filtering the feedback list. */
  readonly selectedCategories: string[]
  /** Toggles a category in/out of the filter selection. */
  readonly onToggleCategory: (category: string) => void
}

/** Top rows plus any selected category ranked below the fold. */
function visibleWhileCollapsed(categoryData: CategoryData[], selectedCategories: string[]): CategoryData[] {
  return categoryData.filter(
    (category, index) => index < MAX_COLLAPSED_ROWS || selectedCategories.includes(category.name)
  )
}

export function CategoryDistribution({
  categoryData,
  totalIssues,
  periodDays,
  selectedCategories,
  onToggleCategory,
}: CategoryDistributionProps) {
  const { t } = useTranslation('categories')
  const [expanded, setExpanded] = useState(false)
  if (categoryData.length === 0) {
    return (
      <div className="card">
        <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{t('categoryDistribution')}</h2>
        <div className="py-8 text-center text-gray-500">
          <FolderOpen size={40} className="mx-auto mb-3 opacity-50" />
          <p>{t('noCategories')}</p>
        </div>
      </div>
    )
  }

  const headerMeta = [
    t('categories', { count: categoryData.length }),
    t('items', { count: totalIssues }),
    ...(periodDays ? [t('lastDays', { count: periodDays })] : []),
  ].join(' • ')

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-1">
        <h2 className="text-base sm:text-lg font-semibold">{t('categoryDistribution')}</h2>
        <p className="text-xs sm:text-sm text-gray-500">{headerMeta}</p>
      </div>
      <p className="text-xs text-gray-400 mb-1.5">{t('categoryDistributionHint')}</p>
      <div className="divide-y divide-gray-100">
        {(expanded ? categoryData : visibleWhileCollapsed(categoryData, selectedCategories)).map((category) => {
          const percentage = totalIssues > 0 ? (category.value / totalIssues) * 100 : 0
          const isSelected = selectedCategories.includes(category.name)
          return (
            <button
              key={category.name}
              onClick={() => onToggleCategory(category.name)}
              aria-pressed={isSelected}
              className={clsx(
                'block w-full text-left py-1.5 px-2 -mx-2 rounded-lg transition-colors active:scale-[0.99]',
                isSelected ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : 'hover:bg-gray-50'
              )}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className={clsx('font-medium text-sm leading-tight capitalize', isSelected && 'text-blue-800')}>
                  {category.name.replace('_', ' ')}
                </span>
                <span className="text-xs text-gray-600 leading-tight">
                  {category.value} ({percentage.toFixed(1)}%)
                </span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${percentage}%`, backgroundColor: category.color }}
                />
              </div>
            </button>
          )
        })}
      </div>
      {categoryData.length > MAX_COLLAPSED_ROWS && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1.5 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
        >
          {expanded ? (
            <>
              <ChevronUp size={14} />
              {t('showTop', { count: MAX_COLLAPSED_ROWS })}
            </>
          ) : (
            <>
              <ChevronDown size={14} />
              {t('showAllCategories', { count: categoryData.length })}
            </>
          )}
        </button>
      )}
    </div>
  )
}
