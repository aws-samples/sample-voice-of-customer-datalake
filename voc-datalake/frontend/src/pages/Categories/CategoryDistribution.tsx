/**
 * @fileoverview Ranked category-distribution bar breakdown for the Categories page.
 *
 * Moved here from the Data Explorer "Categories" sub-tab (now removed). Renders a
 * read-only, ranked horizontal bar chart of category counts + percentages using the
 * category data already derived on the Categories page.
 *
 * @module pages/Categories/CategoryDistribution
 */

import { FolderOpen } from 'lucide-react'
import type { CategoryData } from './types'

interface CategoryDistributionProps {
  /** Categories sorted by value descending (as produced by the Categories page). */
  readonly categoryData: CategoryData[]
  /** Sum of all category values, used to compute each bar's percentage. */
  readonly totalIssues: number
  /** Optional lookback window (days) shown in the header. */
  readonly periodDays?: number
}

export function CategoryDistribution({ categoryData, totalIssues, periodDays }: CategoryDistributionProps) {
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-3 sm:mb-4">
        <h2 className="text-base sm:text-lg font-semibold">Category Distribution</h2>
        <p className="text-xs sm:text-sm text-gray-500">
          {categoryData.length} categories • {totalIssues} items
          {periodDays ? ` • Last ${periodDays} days` : ''}
        </p>
      </div>
      <div className="divide-y divide-gray-100">
        {categoryData.map((category) => {
          const percentage = totalIssues > 0 ? (category.value / totalIssues) * 100 : 0
          return (
            <div key={category.name} className="py-2.5 sm:py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm capitalize">{category.name.replace('_', ' ')}</span>
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
