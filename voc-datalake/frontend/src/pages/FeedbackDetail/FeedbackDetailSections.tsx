/**
 * @fileoverview The feedback detail page's suggested-responses and similar-feedback cards.
 * @module pages/FeedbackDetail/FeedbackDetailSections
 */

import { Link } from 'react-router-dom'
import { Copy, Check, MessageCircle, TrendingUp, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'

// Suggested Responses Section
interface SuggestedResponsesSectionProps {
  readonly responses: string[]
  readonly copiedIndex: number | null
  readonly onCopy: (text: string, index: number) => void
}

export function SuggestedResponsesSection({ responses, copiedIndex, onCopy }: SuggestedResponsesSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="card">
      <h2 className="text-base font-semibold tracking-tight text-text-strong mb-1 flex items-center gap-2">
        <MessageCircle size={16} aria-hidden="true" />
        {t('suggestedResponses')}
      </h2>
      <p className="text-sm text-muted mb-3 sm:mb-4">{t('suggestedResponsesHint')}</p>
      <div className="space-y-2 sm:space-y-3">
        {responses.map((response, index) => (
          <div key={response} className="bg-bg-accent border border-border rounded-lg p-3 sm:p-4 flex items-start gap-2 sm:gap-3">
            <p className="flex-1 text-sm text-text">{response}</p>
            <button
              type="button"
              onClick={() => onCopy(response, index)}
              className="icon-btn flex-shrink-0 focus-ring"
              title={t('copyToClipboard')}
              aria-label={t('copyToClipboard')}
            >
              {copiedIndex === index
                ? <Check size={16} className="text-ok" aria-hidden="true" />
                : <Copy size={16} aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// Similar Feedback Section
interface SimilarFeedbackSectionProps {
  readonly activeTab: 'details' | 'similar'
  readonly onToggle: () => void
  readonly similarItems: FeedbackItem[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

export function SimilarFeedbackSection({ activeTab, onToggle, similarItems, isLoading, isError }: SimilarFeedbackSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  const expanded = activeTab === 'similar'
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-text-strong flex items-center gap-2">
          <TrendingUp size={16} aria-hidden="true" />
          {t('similarFeedback')}
        </h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls="similar-feedback-list"
          className="btn btn-ghost btn-sm"
        >
          {expanded ? t('hide') : t('show')}
        </button>
      </div>

      {expanded && (
        <div id="similar-feedback-list" className="mt-3 sm:mt-4">
          <SimilarFeedbackList items={similarItems} isLoading={isLoading} isError={isError} />
        </div>
      )}
    </div>
  )
}

function SimilarFeedbackList({ items, isLoading, isError }: Readonly<{ items: FeedbackItem[] | undefined; isLoading: boolean; isError: boolean }>) {
  const { t } = useTranslation('feedbackDetail')
  if (isLoading) {
    return (
      <p className="text-sm text-muted text-center py-4" role="status">
        {t('loadingSimilar')}
      </p>
    )
  }
  if (isError) {
    return <p className="text-sm text-danger text-center py-4" role="alert">{t('similarFailed')}</p>
  }
  if (!items || items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 text-center py-6 text-sm text-muted">
        <Inbox size={20} aria-hidden="true" />
        {t('noSimilar')}
      </div>
    )
  }

  return (
    <div className="space-y-2 sm:space-y-3">
      {items.map((item) => (
        <Link
          key={item.feedback_id}
          to={`/feedback/${item.feedback_id}`}
          className="block p-3 bg-bg-accent border border-border rounded-lg hover:bg-bg-hover hover:border-border-strong active:bg-bg-hover transition-colors focus-ring"
        >
          <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
            <span className="text-xs text-muted capitalize">{item.source_platform.replace(/_/g, ' ')}</span>
            <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
          </div>
          <p className="text-sm text-text line-clamp-2">{item.original_text}</p>
          <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-1.5 sm:mt-2">
            <span className="badge badge-accent">{item.category}</span>
            {item.urgency === 'high' && (
              <span className="badge badge-warn">{t('urgent')}</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}
