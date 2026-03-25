/**
 * @fileoverview Categories View component for Data Explorer.
 * @module pages/DataExplorer/CategoriesView
 */

import { FolderOpen, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface CategoriesViewProps {
  readonly data: { period_days: number; categories: Record<string, number> } | undefined
  readonly loading: boolean
  readonly error: Error | null
}

export default function CategoriesView({ data, loading, error }: CategoriesViewProps) {
  const { t } = useTranslation('dataExplorer')

  if (loading) {
    return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  }

  if (error) {
    return (
      <div className="p-8 text-center text-red-500">
        <FolderOpen size={48} className="mx-auto mb-4 opacity-50" />
        <p className="font-medium">{t('categories.errorLoading', 'Error loading categories')}</p>
        <p className="text-sm mt-1 text-red-400">{error.message}</p>
      </div>
    )
  }

  const categories = data?.categories ?? {}
  const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1])
  const total = Object.values(categories).reduce((s, c) => s + c, 0)

  if (sorted.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <FolderOpen size={48} className="mx-auto mb-4 opacity-50" />
        <p>{t('categories.noCategories')}</p>
      </div>
    )
  }

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b text-sm text-gray-600">
        {t('categories.summary', { count: sorted.length, total, days: data?.period_days })}
      </div>
      <div className="divide-y">
        {sorted.map(([cat, count]) => {
          const pct = total > 0 ? (count / total) * 100 : 0
          return (
            <div key={cat} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-sm">{cat}</span>
                <span className="text-sm text-gray-600">{count} ({pct.toFixed(1)}%)</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
