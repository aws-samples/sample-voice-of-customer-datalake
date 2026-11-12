/**
 * @fileoverview The page's evidence: the reviews a document was written from (`input_feedback_ids`, the same corpus
 * FeedbackCorpus counts) as compact cards, and the feedback-board requests it read as links. The first few reviews
 * are read one at a time through `GET /feedback/{id}` (the review modal's query key, so an opened review is not
 * fetched twice); "Show all" opens the corpus modal, which pages through every one. A review that was erased, deleted
 * or is outside the reader's access reads as unavailable; the erased-evidence count stays under the list.
 *
 * @module components/DocumentCanvas/page/EvidenceCards
 */
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import RatingStars from '../../RatingStars'
import ReviewLink from '../../ReviewLink/ReviewLink'
import ReviewSentimentBadge from '../../SentimentBadge/ReviewSentimentBadge'
import { SourceIcon } from '../../SourceIcon/SourceIcon'
import { cleanReviewText } from '../../../utils/cleanReviewText'
import { formatDate } from '../../../utils/dateUtils'
import CorpusReview from '../../../pages/ProjectDetail/CorpusReview'
import ErasedEvidenceNote from '../../../pages/ProjectDetail/ErasedEvidenceNote'
import FeedbackCorpusModal from '../../../pages/ProjectDetail/FeedbackCorpusModal'
import { FeatureRequestList } from '../../../pages/ProjectDetail/FeatureRequestCorpus'
import { corpusIds } from '../../../pages/ProjectDetail/feedbackCorpusIds'
import type { ErasedEvidence } from '../../../api/erasedEvidence'
import type { FeedbackItem } from '../../../api/types'

/** Reviews shown as cards before "Show all". */
const EVIDENCE_CARD_LIMIT = 5

interface EvidenceCardsProps {
  /** The document's `input_feedback_ids`. */
  readonly feedbackIds: readonly string[] | undefined
  /** `featureRequestIdsOf(document)`. */
  readonly featureRequestIds: readonly string[]
  readonly erasedEvidence: ErasedEvidence | undefined
  /** False inside a tab panel, which the tab already names. */
  readonly titled?: boolean
}

function ReviewCard({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { i18n } = useTranslation()
  return (
    <ReviewLink feedbackId={feedback.feedback_id}
      className="block p-3 rounded-lg border border-border bg-card hover:bg-bg-hover hover:border-border-strong transition-colors focus-ring">
      <span className="flex items-center gap-2 min-w-0">
        <SourceIcon platform={feedback.source_platform} size={16} className="flex-shrink-0 text-accent-text" />
        <ReviewSentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
        {feedback.rating == null ? null : <RatingStars rating={feedback.rating} size={12} />}
      </span>
      <span className="block mt-2 text-sm text-text line-clamp-2 [overflow-wrap:anywhere]">{cleanReviewText(feedback.original_text)}</span>
      <span className="block mt-1 text-xs text-muted">{formatDate(feedback.source_created_at, i18n.language, '', 'short')}</span>
    </ReviewLink>
  )
}

function EvidenceItem({ feedbackId }: Readonly<{ feedbackId: string }>) {
  const { t } = useTranslation('projectDetail')
  const loading = (
    <div role="status" className="p-3 rounded-lg border border-border space-y-2">
      <span className="sr-only">{t('corpus.loading')}</span>
      <span aria-hidden className="block skeleton h-4 w-1/2" />
      <span aria-hidden className="block skeleton h-8" />
    </div>
  )
  return <CorpusReview feedbackId={feedbackId} textSize="text-xs" loading={loading} render={(feedback) => <ReviewCard feedback={feedback} />} />
}

export default function EvidenceCards({ feedbackIds, featureRequestIds, erasedEvidence, titled = true }: EvidenceCardsProps) {
  const { t } = useTranslation('projectDetail')
  const ids = useMemo(() => corpusIds(feedbackIds), [feedbackIds])
  const requests = useMemo(() => corpusIds(featureRequestIds), [featureRequestIds])
  const [showingAll, setShowingAll] = useState(false)
  const headingId = useId()
  const requestsId = useId()
  const empty = ids.length === 0 && requests.length === 0
  return (
    <section data-testid="evidence-cards" aria-labelledby={titled ? headingId : undefined} className="space-y-3 min-w-0">
      {titled ? <h3 id={headingId} className="text-sm font-semibold text-text-strong">{t('canvas.page.evidence')}</h3> : null}
      {empty ? <p className="text-xs text-muted">{t('canvas.page.evidenceEmpty')}</p> : null}
      {ids.length > 0 ? (
        <>
          <p className="text-xs text-muted">{t('corpus.summary', { count: ids.length })}</p>
          <ul className="space-y-2" aria-label={t('corpus.title')}>
            {ids.slice(0, EVIDENCE_CARD_LIMIT).map((id) => <li key={id}><EvidenceItem feedbackId={id} /></li>)}
          </ul>
          {ids.length > EVIDENCE_CARD_LIMIT ? (
            <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog" onClick={() => setShowingAll(true)}>
              {t('canvas.page.showAll', { n: ids.length })}
            </button>
          ) : null}
        </>
      ) : null}
      {requests.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-text">{t('canvas.page.featureRequests')}</p>
          <FeatureRequestList ids={requests} open listId={requestsId} />
        </div>
      ) : null}
      <ErasedEvidenceNote erasedEvidence={erasedEvidence} />
      {showingAll ? <FeedbackCorpusModal ids={ids} onClose={() => setShowingAll(false)} /> : null}
    </section>
  )
}
