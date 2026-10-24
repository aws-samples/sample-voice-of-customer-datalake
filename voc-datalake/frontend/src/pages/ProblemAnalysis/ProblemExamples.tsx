/**
 * @fileoverview The example reviews under an expanded problem row: a few of the
 * problem's reviews (newest first), read by id, with how many it has in all. The tree
 * carries counts, not reviews (`GET /feedback/problems`).
 * @module pages/ProblemAnalysis/ProblemExamples
 */
import { useTranslation } from 'react-i18next'
import ReviewLink from '../../components/ReviewLink/ReviewLink'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import RatingStars from '../../components/RatingStars'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { formatDate } from '../../utils/dateUtils'
import type { FeedbackItem } from '../../api/types'
import { useExampleReviews } from './useExampleReviews'
import type { ProblemGroup } from '../../api/problemsApi'

function FeedbackItemCard({ item, problemSummary }: Readonly<{ item: FeedbackItem; problemSummary: string }>) {
  const { t, i18n } = useTranslation('problemAnalysis')
  const labels = useDisplayLabels()
  return (
    <ReviewLink
      feedbackId={item.feedback_id}
      className="block p-3 sm:p-4 bg-bg-accent rounded-lg hover:bg-bg-hover hover:border-border-strong active:bg-border transition-colors border border-border focus-ring"
    >
      <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <span className="text-xs font-medium text-text">
            {labels.source(item.source_platform)}
          </span>
          {item.urgency === 'high' && (
            <span className="badge badge-warn">{t('stats.urgent')}</span>
          )}
        </div>
        <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
      </div>
      <p className="text-xs sm:text-sm text-text line-clamp-3">{item.original_text}</p>
      {item.problem_summary && item.problem_summary !== problemSummary && (
        <p className="text-xs text-muted mt-1 italic line-clamp-1">{t('tree.original', { text: item.problem_summary })}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-1.5 sm:mt-2 text-xs text-muted">
        <span>{formatDate(item.source_created_at, i18n.language, t('tree.unknown'))}</span>
        {item.rating ? <RatingStars rating={item.rating} size={12} /> : null}
        {item.persona_name && <span className="hidden sm:inline">{item.persona_name}</span>}
      </div>
    </ReviewLink>
  )
}

export function ProblemExamples({ problemGroup }: Readonly<{ problemGroup: ProblemGroup }>) {
  const { t } = useTranslation('problemAnalysis')
  const examples = useExampleReviews(problemGroup.sampleIds)
  return (
    <div className="px-3 sm:px-6 pb-3 sm:pb-4 pl-12 sm:pl-24 space-y-2 sm:space-y-3">
      {examples.items.length > 0 && (
        <p className="text-xs text-text">
          {t('tree.examplesOf', { shown: examples.items.length, count: problemGroup.count })}
        </p>
      )}
      {examples.items.map((item) => (
        <FeedbackItemCard key={item.feedback_id} item={item} problemSummary={problemGroup.problem} />
      ))}
      {examples.isLoading && <p className="text-xs text-text" role="status">{t('tree.examplesLoading')}</p>}
      {!examples.isLoading && examples.isError && examples.items.length === 0 && (
        <p className="text-xs text-text" role="alert">{t('tree.examplesFailed')}</p>
      )}
    </div>
  )
}
