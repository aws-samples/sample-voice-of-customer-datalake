import {
  Filter, X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface SourceFilterProps {
  readonly selectedSource: string | null
  readonly onSourceChange: (source: string | null) => void
  readonly allSources: string[]
}

export function SourceFilter({
  selectedSource, onSourceChange, allSources,
}: SourceFilterProps) {
  const { t } = useTranslation('categories')

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-3 sm:p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="flex items-center gap-2">
        <Filter size={18} className="text-gray-500 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700 whitespace-nowrap">{t('filterBySource')}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <select
          value={selectedSource ?? ''}
          onChange={(e) => onSourceChange(e.target.value === '' ? null : e.target.value)}
          className="flex-1 sm:flex-none px-3 sm:px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white min-w-0 sm:min-w-[200px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">{t('allSources')}</option>
          {allSources.map((source) => (
            <option key={source} value={source}>{source}</option>
          ))}
        </select>
        {selectedSource != null && selectedSource !== '' ? <button
          onClick={() => onSourceChange(null)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors active:scale-95"
        >
          <X size={14} />
          {t('clear')}
        </button> : null}
      </div>
      {selectedSource != null && selectedSource !== '' ? <span className="text-xs sm:text-sm text-blue-600 bg-blue-50 px-3 py-1 rounded-full truncate">
        {selectedSource}
      </span> : null}
    </div>
  )
}
