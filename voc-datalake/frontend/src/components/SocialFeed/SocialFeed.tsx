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
import { Link } from 'react-router-dom'
import { ExternalLink, Inbox, MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import clsx from 'clsx'
import type { FeedbackItem } from '../../api/types'
import SentimentBadge from '../SentimentBadge/SentimentBadge'
import RatingStars from '../RatingStars'
import { SourceIcon } from '../SourceIcon/SourceIcon'

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

const SOURCE_COLORS: Record<string, string> = {
  webscraper: 'border-l-chart-2', web_scrape: 'border-l-chart-2',
  manual_import: 'border-l-chart-1', s3_import: 'border-l-chart-3',
}

function FeedItem({ item }: Readonly<{ item: FeedbackItem }>) {
  const { t } = useTranslation('components')
  // Only non-empty strings, so only an unknown platform falls back.
  const borderColor = SOURCE_COLORS[item.source_platform] ?? 'border-l-border-strong'

  return (
    <article className={clsx('bg-card border border-border rounded-lg border-l-4 p-3 sm:p-4 hover:border-border-strong transition-colors', borderColor)}>
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center">
          <SourceIcon platform={item.source_platform} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            <span className="text-sm font-medium text-text-strong capitalize">
              {item.source_platform.replace(/_/g, ' ')}
            </span>
            {item.rating != null && <RatingStars rating={item.rating} size={12} />}
            <SentimentBadge sentiment={item.sentiment_label} />
          </div>

          <p className="text-sm text-text line-clamp-3">{item.original_text}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted">
            <span className="font-mono">{formatDateSafe(item.source_created_at)}</span>
            {item.category && <span className="capitalize">{item.category.replace(/_/g, ' ')}</span>}
            <span className="ml-auto flex items-center gap-3">
              <Link
                to={`/feedback/${item.feedback_id}`}
                className="inline-flex items-center gap-1 link focus-ring rounded-sm"
              >
                <MessageCircle size={12} aria-hidden="true" />
                {t('feedbackCard.details')}
              </Link>
              {item.source_url && (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 link focus-ring rounded-sm"
                  title={t('feedbackCard.openOriginal')}
                >
                  {t('socialFeed.view')} <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

interface SocialFeedProps {
  readonly limit?: number
  readonly showFilters?: boolean
}

export default function SocialFeed({ limit = 10, showFilters = true }: SocialFeedProps) {
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const { t } = useTranslation('components')
  const [activeSource, setActiveSource] = useState<string | null>(null)

  // Fetch available sources dynamically
  const { data: sourcesData } = useQuery({
    queryKey: ['sources', dateParams],
    queryFn: () => api.getSources(dateParams),
    enabled: !!config.apiEndpoint,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['feedback', dateParams, activeSource],
    queryFn: () => api.getFeedback({ ...dateParams, source: activeSource === null || activeSource === '' ? undefined : activeSource, limit }),
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
          <div key={i} className="skeleton rounded-lg h-24" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {showFilters && (
        // Segmented filter (design-system tabs recipe); scrolls sideways on
        // phones instead of wrapping into a ragged second row.
        <div className="max-w-full overflow-x-auto">
          <div className="tabs-track inline-flex" role="group" aria-label={t('socialFeed.filterLabel')}>
            {sources.map(source => {
              const active = (source === 'all' && !activeSource) || activeSource === source
              return (
                <button
                  key={source}
                  type="button"
                  onClick={() => setActiveSource(source === 'all' ? null : source)}
                  aria-pressed={active}
                  className={clsx('tab whitespace-nowrap', active && 'tab-active')}
                >
                  {source === 'all' ? t('socialFeed.all') : (
                    <span className="inline-flex items-center gap-1.5">
                      <SourceIcon platform={source} size={14} />
                      {source.replace(/_/g, ' ')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      
      <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
        {data?.items.map(item => (
          <FeedItem key={item.feedback_id} item={item} />
        ))}
        {(!data?.items || data.items.length === 0) && (
          <div className="flex flex-col items-center gap-2 text-center py-8 text-sm text-muted">
            <Inbox size={20} aria-hidden="true" />
            {t('socialFeed.noFeedback')}
          </div>
        )}
      </div>
    </div>
  )
}
