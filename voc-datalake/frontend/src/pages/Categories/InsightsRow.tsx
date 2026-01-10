import { TrendingDown, TrendingUp } from 'lucide-react'
import type { CategoryData } from './types'

interface InsightsRowProps {
  readonly categoryData: CategoryData[]
  readonly totalIssues: number
}

export function InsightsRow({ categoryData, totalIssues }: InsightsRowProps) {
  const topCategory = categoryData[0]
  const bottomCategory = categoryData[categoryData.length - 1]
  const topPercentage = topCategory ? ((topCategory.value / totalIssues) * 100).toFixed(0) : '0'

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
      <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-xl p-3 sm:p-4 border border-red-200">
        <div className="flex items-center gap-2 text-red-700 mb-1 sm:mb-2">
          <TrendingUp size={16} className="sm:w-[18px] sm:h-[18px]" />
          <span className="text-xs sm:text-sm font-medium">Top Issue</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-red-900 capitalize truncate">
          {topCategory?.name.replace('_', ' ') || 'N/A'}
        </p>
        <p className="text-xs sm:text-sm text-red-600">
          {topCategory?.value || 0} issues ({topPercentage}%)
        </p>
      </div>
      
      <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-3 sm:p-4 border border-green-200">
        <div className="flex items-center gap-2 text-green-700 mb-1 sm:mb-2">
          <TrendingDown size={16} className="sm:w-[18px] sm:h-[18px]" />
          <span className="text-xs sm:text-sm font-medium">Least Issues</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-green-900 capitalize truncate">
          {bottomCategory?.name.replace('_', ' ') || 'N/A'}
        </p>
        <p className="text-xs sm:text-sm text-green-600">
          {bottomCategory?.value || 0} issues
        </p>
      </div>
      
      <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-3 sm:p-4 border border-blue-200 sm:col-span-2 lg:col-span-1">
        <div className="flex items-center gap-2 text-blue-700 mb-1 sm:mb-2">
          <span className="text-xs sm:text-sm font-medium">Total Feedback</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-blue-900">{totalIssues}</p>
        <p className="text-xs sm:text-sm text-blue-600">{categoryData.length} categories</p>
      </div>
    </div>
  )
}
