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
import type { WordCloudItem } from './types'

interface WordCloudCardProps {
  readonly wordCloudData: WordCloudItem[]
  /** Current search text — a keyword equal to it renders highlighted. */
  readonly searchText: string
  readonly onSearchChange: (value: string) => void
}

export function WordCloudCard({ wordCloudData, searchText, onSearchChange }: WordCloudCardProps) {
  const maxCount = Math.max(...wordCloudData.map(w => w.count), 1)

  return (
    <div className="card">
      <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">Trending Keywords</h2>
      <div className="flex flex-wrap gap-1.5 sm:gap-2 justify-center items-center min-h-[150px] sm:min-h-[200px]">
        {wordCloudData.map(({ word, count }) => {
          const size = 0.65 + (count / maxCount) * 0.6
          const isActive = searchText === word
          return (
            <button
              key={word}
              onClick={() => onSearchChange(isActive ? '' : word)}
              className={clsx(
                'px-1.5 sm:px-2 py-0.5 sm:py-1 rounded transition-all cursor-pointer active:scale-95',
                isActive
                  ? 'bg-blue-600 text-white ring-2 ring-blue-300 shadow-md'
                  : 'bg-blue-100 text-blue-800 hover:bg-blue-200 sm:hover:scale-105'
              )}
              style={{ fontSize: `${size}rem` }}
              title={`${count} mentions - click to search`}
            >
              {word}
            </button>
          )
        })}
        {wordCloudData.length === 0 && (
          <p className="text-gray-400 text-xs sm:text-sm">No keyword data available</p>
        )}
      </div>
    </div>
  )
}
