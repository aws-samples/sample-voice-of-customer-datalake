/**
 * @fileoverview The feedback detail page's similar-feedback card.
 * @module pages/FeedbackDetail/FeedbackDetailSections
 */

import { Link } from 'react-router-dom'
import { TrendingUp, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import ReviewSentimentBadge from '../../components/SentimentBadge/ReviewSentimentBadge'
import { cleanReviewText } from '../../utils/cleanReviewText'
import ReviewLink from '../../components/ReviewLink/ReviewLink'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'

// Similar Feedback Section
interface SimilarFeedbackSectionProps {
  readonly activeTab: 'details' | 'similar'
  readonly onToggle: () => void
  readonly similarItems: FeedbackItem[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  /** In the review modal an item replaces the open review (`?review=`) instead of leaving the page. */
  readonly inModal?: boolean
}

export function SimilarFeedbackSection({ activeTab, onToggle, similarItems, isLoading, isError, inModal = false }: SimilarFeedbackSectionProps) {
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
          <SimilarFeedbackList items={similarItems} isLoading={isLoading} isError={isError} inModal={inModal} />
        </div>
      )}
    </div>
  )
}

const SIMILAR_ITEM = 'block p-3 bg-bg-accent border border-border rounded-lg hover:bg-bg-hover hover:border-border-strong active:bg-bg-hover transition-colors focus-ring'

function SimilarItemBody({ item }: Readonly<{ item: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  const labels = useDisplayLabels()
  return (
    <>
      <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
        <span className="text-xs text-muted">{labels.source(item.source_platform)}</span>
        <ReviewSentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
      </div>
      <p className="text-sm text-text line-clamp-2">{cleanReviewText(item.original_text)}</p>
      <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-1.5 sm:mt-2">
        <span className="badge badge-accent">{labels.category(item.category)}</span>
        {item.urgency === 'high' && (
          <span className="badge badge-warn">{t('urgent')}</span>
        )}
      </div>
    </>
  )
}

function SimilarFeedbackList({ items, isLoading, isError, inModal }: Readonly<{ items: FeedbackItem[] | undefined; isLoading: boolean; isError: boolean; inModal: boolean }>) {
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
      {items.map((item) => (inModal ? (
        <ReviewLink key={item.feedback_id} feedbackId={item.feedback_id} replace className={SIMILAR_ITEM}>
          <SimilarItemBody item={item} />
        </ReviewLink>
      ) : (
        <Link key={item.feedback_id} to={`/feedback/${item.feedback_id}`} className={SIMILAR_ITEM}>
          <SimilarItemBody item={item} />
        </Link>
      )))}
    </div>
  )
}
