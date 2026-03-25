/**
 * @fileoverview Live social feed component for dashboard.
 *
 * Displays recent feedback items in a scrollable feed:
 * - Source icons and color coding
 * - Sentiment indicators
 * - Rating stars
 * - Links to source URLs
 *
 * @module components/SocialFeed
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Star, ExternalLink } from 'lucide-react'
import { api, getDaysFromRange } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import clsx from 'clsx'
import type { FeedbackItem } from '../../api/client'

// Safe date formatting helper
function formatDateSafe(dateStr: string | undefined): string {
  if (!dateStr) return 'N/A'
  try {
    const date = new Date(dateStr)
    return isNaN(date.getTime()) ? 'N/A' : date.toLocaleDateString()
  } catch {
    return 'N/A'
  }
}

const SOURCE_ICONS: Record<string, string> = {
  webscraper: '🌐', web_scrape: '🌐', web_scrape_jsonld: '🌐',
  manual_import: '📝', s3_import: '📦',
}

const SOURCE_COLORS: Record<string, string> = {
  webscraper: 'border-l-blue-500', web_scrape: 'border-l-blue-500',
  manual_import: 'border-l-purple-500', s3_import: 'border-l-green-500',
}

function FeedItem({ item }: Readonly<{ item: FeedbackItem }>) {
  const { t } = useTranslation('components')
  const icon = SOURCE_ICONS[item.source_platform] || '📝'
  const borderColor = SOURCE_COLORS[item.source_platform] || 'border-l-gray-300'
  
  return (
    <div className={clsx('bg-white rounded-lg border-l-4 p-4 shadow-sm hover:shadow-md transition-shadow', borderColor)}>
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-gray-900 capitalize">
              {item.source_platform.replace(/_/g, ' ')}
            </span>
            {item.rating != null && (
              <div className="flex items-center gap-0.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Star
                    key={i}
                    size={12}
                    className={i < (item.rating ?? 0) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
                  />
                ))}
              </div>
            )}
            <span className={clsx(
              'px-1.5 py-0.5 rounded text-xs font-medium',
              item.sentiment_label === 'positive' && 'bg-green-100 text-green-700',
              item.sentiment_label === 'negative' && 'bg-red-100 text-red-700',
              item.sentiment_label === 'neutral' && 'bg-gray-100 text-gray-700',
              item.sentiment_label === 'mixed' && 'bg-yellow-100 text-yellow-700',
            )}>
              {item.sentiment_label}
            </span>
          </div>

          <p className="text-sm text-gray-700 line-clamp-3">{item.original_text}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            <span>{formatDateSafe(item.source_created_at)}</span>
            {item.category && <span className="capitalize">{item.category.replace(/_/g, ' ')}</span>}
            {item.source_url && (
              <a href={item.source_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-600 hover:underline">
                {t('socialFeed.view')} <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SocialFeedProps {
  readonly limit?: number
  readonly showFilters?: boolean
}

export default function SocialFeed({ limit = 10, showFilters = true }: SocialFeedProps) {
  const { t } = useTranslation('components')
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const [activeSource, setActiveSource] = useState<string | null>(null)

  // Fetch available sources dynamically
  const { data: sourcesData } = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: !!config.apiEndpoint,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['feedback', days, activeSource, customDateRange],
    queryFn: () => api.getFeedback({ days, source: activeSource || undefined, limit }),
    enabled: !!config.apiEndpoint,
  })

  // Build sources list from API response, sorted by count descending
  const sources = ['all', ...Object.entries(sourcesData?.sources ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([source]) => source)]

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-gray-100 rounded-lg h-24 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {showFilters && (
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {sources.map(source => (
            <button
              key={source}
              onClick={() => setActiveSource(source === 'all' ? null : source)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors',
                (source === 'all' && !activeSource) || activeSource === source
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              )}
            >
              {source === 'all' ? `🔄 ${t('socialFeed.all')}` : `${SOURCE_ICONS[source] || ''} ${source.replace(/_/g, ' ')}`}
            </button>
          ))}
        </div>
      )}
      
      <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
        {data?.items.map(item => (
          <FeedItem key={item.feedback_id} item={item} />
        ))}
        {(!data?.items || data.items.length === 0) && (
          <div className="text-center py-8 text-gray-500">
            {t('socialFeed.noFeedback')}
          </div>
        )}
      </div>
    </div>
  )
}
