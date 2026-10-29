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
import ReviewLink from '../ReviewLink/ReviewLink'
import { ExternalLink, Inbox, MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import clsx from 'clsx'
import type { FeedbackItem } from '../../api/types'
import ReviewSentimentBadge from '../SentimentBadge/ReviewSentimentBadge'
import RatingStars from '../RatingStars'
import { SourceIcon } from '../SourceIcon/SourceIcon'
import { formatDate } from '../../utils/dateUtils'
import { cleanReviewText } from '../../utils/cleanReviewText'
import { metricsKeys } from '../../api/queryKeys'

const SOURCE_COLORS: Record<string, string> = {
  webscraper: 'border-l-chart-2', web_scrape: 'border-l-chart-2',
  manual_import: 'border-l-chart-1', s3_import: 'border-l-chart-3',
}

function FeedItem({ item }: Readonly<{ item: FeedbackItem }>) {
  const { t, i18n } = useTranslation('components')
  const labels = useDisplayLabels()
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
            <span className="text-sm font-medium text-text-strong">
              {labels.source(item.source_platform)}
            </span>
            {item.rating != null && <RatingStars rating={item.rating} size={12} />}
            {/* The translated label ("Negatywny · 90 %"), never the raw "negative" (verify10). */}
            <ReviewSentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
          </div>

          <p className="text-sm text-text line-clamp-3">{cleanReviewText(item.original_text)}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted">
            {/* One date per review across the dashboard, in the reader's language ("Oct 18, 2026" / "18 paź 2026"). */}
            <span className="font-mono">{formatDate(item.source_created_at, i18n.language)}</span>
            {item.category && <span>{labels.category(item.category)}</span>}
            {/* `flex-wrap`: at 390 px / 200 % text "View" wraps under "Details" instead of
                being squeezed (an external `.link` may break anywhere, see index.css). */}
            <span className="ml-auto flex flex-wrap items-center gap-3">
              <ReviewLink
                feedbackId={item.feedback_id}
                className="inline-flex items-center gap-1 link focus-ring rounded-sm"
              >
                <MessageCircle size={12} aria-hidden="true" />
                {t('feedbackCard.details')}
              </ReviewLink>
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
  const labels = useDisplayLabels()
  const [activeSource, setActiveSource] = useState<string | null>(null)

  // Fetch available sources dynamically
  const { data: sourcesData } = useQuery({
    queryKey: metricsKeys.sources(dateParams),
    queryFn: () => api.getSources(dateParams),
    enabled: !!config.apiEndpoint,
  })

  const { data, isLoading } = useQuery({
    queryKey: metricsKeys.feedback(dateParams, activeSource),
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
                      {labels.source(source)}
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
