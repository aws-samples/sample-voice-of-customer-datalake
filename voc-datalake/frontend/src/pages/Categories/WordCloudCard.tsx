/**
 * @fileoverview Trending keywords card for the Categories page.
 *
 * Clicking a keyword populates the search box (server-side search across the
 * full corpus) instead of the former client-side filter, which silently
 * matched only the loaded 100-item window (issue #198 UX rationalization).
 * Clicking the active keyword again clears the search.
 *
 * @module pages/Categories/WordCloudCard
 */

import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { keywordFontPx } from './keywordSize'
import type { WordCloudItem } from './types'

interface WordCloudCardProps {
  readonly wordCloudData: WordCloudItem[]
  /** Current search text — a keyword equal to it renders highlighted. */
  readonly searchText: string
  readonly onSearchChange: (value: string) => void
}

export function WordCloudCard({ wordCloudData, searchText, onSearchChange }: WordCloudCardProps) {
  const { t } = useTranslation('categories')
  const maxCount = Math.max(...wordCloudData.map(w => w.count), 1)

  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold tracking-tight text-text-strong mb-3 sm:mb-4">{t('trendingKeywords')}</h2>
      <div className="flex flex-wrap gap-1.5 sm:gap-2 justify-center items-center min-h-[150px] sm:min-h-[200px]">
        {wordCloudData.map(({ word, count }) => {
          const size = keywordFontPx(count, maxCount)
          const isActive = searchText === word
          return (
            <button
              key={word}
              type="button"
              onClick={() => onSearchChange(isActive ? '' : word)}
              aria-pressed={isActive}
              className={clsx(
                'px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md transition-colors cursor-pointer active:scale-95 focus-ring',
                // Hover only paints (design-system rule 6: no hover scale).
                isActive
                  ? 'bg-accent text-accent-fg'
                  : 'bg-accent-subtle text-accent-text hover:bg-accent/25'
              )}
              style={{ fontSize: `${size}px` }}
              title={t('mentionsTooltip', { count })}
            >
              {word}
            </button>
          )
        })}
        {wordCloudData.length === 0 && (
          <p className="text-muted text-xs sm:text-sm">{t('noKeywordData')}</p>
        )}
      </div>
    </div>
  )
}
