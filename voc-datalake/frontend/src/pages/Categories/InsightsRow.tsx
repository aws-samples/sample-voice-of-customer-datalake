import {
  TrendingDown, TrendingUp,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CategoryData } from './types'

interface InsightsRowProps {
  readonly categoryData: CategoryData[]
  readonly totalIssues: number
}

export function InsightsRow({
  categoryData, totalIssues,
}: InsightsRowProps) {
  const { t } = useTranslation('categories')
  if (categoryData.length === 0) {
    return null
  }

  const topCategory = categoryData[0]
  const bottomCategory = categoryData.at(-1)

  const topPercentage = totalIssues > 0 ? ((topCategory.value / totalIssues) * 100).toFixed(0) : '0'

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
      <div className="bg-gradient-to-br from-red-50 to-red-100 rounded-xl p-3 sm:p-4 border border-red-200">
        <div className="flex items-center gap-2 text-red-700 mb-1 sm:mb-2">
          <TrendingUp size={16} className="sm:w-[18px] sm:h-[18px]" />
          <span className="text-xs sm:text-sm font-medium">{t('topIssue')}</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-red-900 capitalize truncate">
          {topCategory.name.replace('_', ' ') === '' ? 'N/A' : topCategory.name.replace('_', ' ')}
        </p>
        <p className="text-xs sm:text-sm text-red-600">
          {t('issuesWithPercent', {
            count: topCategory.value,
            percent: topPercentage,
          })}
        </p>
      </div>

      <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl p-3 sm:p-4 border border-green-200">
        <div className="flex items-center gap-2 text-green-700 mb-1 sm:mb-2">
          <TrendingDown size={16} className="sm:w-[18px] sm:h-[18px]" />
          <span className="text-xs sm:text-sm font-medium">{t('leastIssues')}</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-green-900 capitalize truncate">
          {bottomCategory?.name.replace('_', ' ') ?? 'N/A'}
        </p>
        <p className="text-xs sm:text-sm text-green-600">
          {t('issues', { count: bottomCategory?.value ?? 0 })}
        </p>
      </div>

      <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-3 sm:p-4 border border-blue-200 sm:col-span-2 lg:col-span-1">
        <div className="flex items-center gap-2 text-blue-700 mb-1 sm:mb-2">
          <span className="text-xs sm:text-sm font-medium">{t('totalFeedback')}</span>
        </div>
        <p className="text-lg sm:text-xl font-bold text-blue-900">{totalIssues}</p>
        <p className="text-xs sm:text-sm text-blue-600">{t('categories', { count: categoryData.length })}</p>
      </div>
    </div>
  )
}
