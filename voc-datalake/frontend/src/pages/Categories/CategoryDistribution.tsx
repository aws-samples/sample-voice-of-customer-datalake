/**
 * @fileoverview Ranked category-distribution breakdown that doubles as the
 * category selector for the Categories page (issue #198 UX rationalization).
 *
 * Each row is a toggle: clicking selects/deselects the category as a filter
 * for the feedback list below (multi-select). Nothing selected = the list
 * shows all feedback. This replaced the separate "Select Categories to
 * Explore" chips card, which duplicated the same data.
 *
 * @module pages/Categories/CategoryDistribution
 */

import { FolderOpen } from 'lucide-react'
import clsx from 'clsx'
import type { CategoryData } from './types'

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

export function CategoryDistribution({
  categoryData,
  totalIssues,
  periodDays,
  selectedCategories,
  onToggleCategory,
}: CategoryDistributionProps) {
  if (categoryData.length === 0) {
    return (
      <div className="card">
        <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Category Distribution</h2>
        <div className="py-8 text-center text-gray-500">
          <FolderOpen size={40} className="mx-auto mb-3 opacity-50" />
          <p>No categories</p>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-1">
        <h2 className="text-base sm:text-lg font-semibold">Category Distribution</h2>
        <p className="text-xs sm:text-sm text-gray-500">
          {categoryData.length} categories • {totalIssues} items
          {periodDays ? ` • Last ${periodDays} days` : ''}
        </p>
      </div>
      <p className="text-xs text-gray-400 mb-2 sm:mb-3">Click a category to filter the results below</p>
      <div className="divide-y divide-gray-100">
        {categoryData.map((category) => {
          const percentage = totalIssues > 0 ? (category.value / totalIssues) * 100 : 0
          const isSelected = selectedCategories.includes(category.name)
          return (
            <button
              key={category.name}
              onClick={() => onToggleCategory(category.name)}
              aria-pressed={isSelected}
              className={clsx(
                'block w-full text-left py-2.5 sm:py-3 px-2 -mx-2 rounded-lg transition-colors active:scale-[0.99]',
                isSelected ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : 'hover:bg-gray-50'
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={clsx('font-medium text-sm capitalize', isSelected && 'text-blue-800')}>
                  {category.name.replace('_', ' ')}
                </span>
                <span className="text-sm text-gray-600">
                  {category.value} ({percentage.toFixed(1)}%)
                </span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${percentage}%`, backgroundColor: category.color }}
                />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
