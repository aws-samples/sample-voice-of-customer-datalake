import { X } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { WordCloudItem } from './types'

interface WordCloudCardProps {
  readonly wordCloudData: WordCloudItem[]
  readonly selectedKeywords: string[]
  readonly onToggleKeyword: (keyword: string) => void
  readonly onClearKeywords: () => void
}

export function WordCloudCard({
  wordCloudData,
  selectedKeywords,
  onToggleKeyword,
  onClearKeywords,
}: WordCloudCardProps) {
  const { t } = useTranslation('categories')
  const maxCount = Math.max(...wordCloudData.map(w => w.count), 1)

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 sm:mb-4 gap-2">
        <h2 className="text-base sm:text-lg font-semibold">{t('trendingKeywords')}</h2>
        {selectedKeywords.length > 0 && (
          <button
            onClick={onClearKeywords}
            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 whitespace-nowrap"
          >
            <X size={12} />
            {t('clear')} ({selectedKeywords.length})
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 sm:gap-2 justify-center items-center min-h-[150px] sm:min-h-[200px]">
        {wordCloudData.map(({ word, count }) => {
          const size = 0.65 + (count / maxCount) * 0.6
          const isSelected = selectedKeywords.includes(word)
          return (
            <button
              key={word}
              onClick={() => onToggleKeyword(word)}
              className={clsx(
                'px-1.5 sm:px-2 py-0.5 sm:py-1 rounded transition-all cursor-pointer active:scale-95',
                isSelected
                  ? 'bg-blue-600 text-white ring-2 ring-blue-300 shadow-md'
                  : 'bg-blue-100 text-blue-800 hover:bg-blue-200 sm:hover:scale-105'
              )}
              style={{ fontSize: `${size}rem` }}
              title={t('mentionsTooltip', { count })}
            >
              {word}
            </button>
          )
        })}
        {wordCloudData.length === 0 && (
          <p className="text-gray-400 text-xs sm:text-sm">{t('noKeywordData')}</p>
        )}
      </div>
      {selectedKeywords.length > 0 && (
        <p className="text-xs text-center text-gray-500 mt-2 sm:mt-3 line-clamp-2">
          {t('filteringBy', { keywords: selectedKeywords.join(', ') })}
        </p>
      )}
    </div>
  )
}
