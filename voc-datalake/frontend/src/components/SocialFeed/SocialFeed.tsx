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

import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Star, ExternalLink,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDaysFromRange } from '../../api/baseUrl'
import { api } from '../../api/client'
import { getSourceIcon } from '../../lib/sourceFormat'
import { useConfigStore } from '../../store/configStore'
import { safeFormatDate } from '../../utils/dateUtils'
import type { FeedbackItem } from '../../api/types'

const SOURCE_COLORS: Record<string, string> = {
  webscraper: 'border-l-blue-500',
  web_scrape: 'border-l-blue-500',
  manual_import: 'border-l-purple-500',
  s3_import: 'border-l-green-500',
}

function FeedItem({ item }: Readonly<{ item: FeedbackItem }>) {
  const { t } = useTranslation('components')
  const icon = getSourceIcon(item.source_platform)
  const borderColor = SOURCE_COLORS[item.source_platform] ?? 'border-l-gray-300'

  return (
    <div className={clsx('bg-white rounded-lg border-l-4 p-4 shadow-sm hover:shadow-md transition-shadow', borderColor)}>
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-gray-900 capitalize">
              {item.source_platform.replaceAll('_', ' ')}
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
            <span>{safeFormatDate(item.source_created_at, 'P')}</span>
            {item.category === '' ? null : <span className="capitalize">{item.category.replaceAll('_', ' ')}</span>}
            {item.source_url != null && item.source_url !== '' ? <a href={item.source_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-600 hover:underline">
              {t('socialFeed.view')} <ExternalLink size={10} />
            </a> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function SourceFilters({
  sources, activeSource, onSourceChange, t,
}: Readonly<{
  sources: string[]
  activeSource: string | null
  onSourceChange: (source: string | null) => void
  t: (key: string) => string
}>) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2">
      {sources.map((source) => (
        <button
          key={source}
          onClick={() => onSourceChange(source === 'all' ? null : source)}
          className={clsx(
            'px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors',
            (source === 'all' && (activeSource == null || activeSource === '')) || activeSource === source
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
          )}
        >
          {source === 'all' ? `🔄 ${t('socialFeed.all')}` : `${getSourceIcon(source)} ${source.replaceAll('_', ' ')}`}
        </button>
      ))}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="bg-gray-100 rounded-lg h-24 animate-pulse" />
      ))}
    </div>
  )
}

interface FeedListProps {
  readonly items: FeedbackItem[] | undefined
  readonly emptyMessage: string
}

function FeedList({
  items, emptyMessage,
}: FeedListProps) {
  return (
    <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
      {items?.map((item) => (
        <FeedItem key={item.feedback_id} item={item} />
      ))}
      {(!items || items.length === 0) && (
        <div className="text-center py-8 text-gray-500">
          {emptyMessage}
        </div>
      )}
    </div>
  )
}

interface SocialFeedProps {
  readonly limit?: number
  readonly showFilters?: boolean
}

export default function SocialFeed({
  limit = 10, showFilters = true,
}: SocialFeedProps) {
  const { t } = useTranslation('components')
  const {
    timeRange, customDateRange, config,
  } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const [activeSource, setActiveSource] = useState<string | null>(null)

  // Fetch available sources dynamically
  const { data: sourcesData } = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: config.apiEndpoint.length > 0,
  })

  const {
    data, isLoading,
  } = useQuery({
    queryKey: ['feedback', days, activeSource, customDateRange],
    queryFn: () => api.getFeedback({
      days,
      source: activeSource != null && activeSource !== '' ? activeSource : undefined,
      limit,
    }),
    enabled: config.apiEndpoint.length > 0,
  })

  // Build sources list from API response, sorted by count descending
  const sources = ['all', ...Object.entries(sourcesData?.sources ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([source]) => source)]

  if (isLoading) {
    return <LoadingSkeleton />
  }

  return (
    <div className="space-y-4">
      {showFilters ? <SourceFilters sources={sources} activeSource={activeSource} onSourceChange={setActiveSource} t={t} /> : null}

      <FeedList items={data?.items} emptyMessage={t('socialFeed.noFeedback')} />
    </div>
  )
}
