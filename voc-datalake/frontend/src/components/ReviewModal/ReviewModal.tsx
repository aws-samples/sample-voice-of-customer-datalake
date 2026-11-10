/**
 * @fileoverview The review modal: one review over whatever page is open (`?review=`,
 * hooks/useReviewModal). Our review renders `FeedbackDetailContent` (the /feedback/:id page's content)
 * with an "Open full page" link; a Radar review renders the same detail card read-only — no
 * category / dimension edits, no similar items, no Categories chips —
 * with its brand and a "Radar review" badge (GET /radar/brands/{brand}/reviews/{feedback_id}).
 *
 * ModalShell owns the dialog semantics. Stacking: the host is mounted in Layout AFTER the
 * assistant and the page, so this shell comes later in the document than the full-screen
 * assistant (z-[60]) and than any page modal (Radar's reviews list) — the same z-[70] then paints
 * it on top, and ModalShell's top-most rule gives it Escape and the focus trap.
 *
 * @module components/ReviewModal/ReviewModal
 */
import { useQuery } from '@tanstack/react-query'
import { Maximize2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import ModalShell from '../ModalShell/ModalShell'
import LoadFailed from '../LoadFailed/LoadFailed'
import { ApiError } from '../../lib/errors'
import { leaveFullscreenOnPlainClick } from '../../hooks/useRouteNavigate'
import FeedbackDetailContent, {
  FeedbackNotFound, LoadingSpinner, ReviewDetailCard,
} from '../../pages/FeedbackDetail/FeedbackDetailContent'
import { radarApi, radarKeys } from '../../api/radarApi'
import { normalizeFeedbackItem } from '../../api/feedbackSchema'
import type { RadarReviewDetail } from '../../api/radarSchema'
import type { FeedbackItem } from '../../api/types'

const MAX_RETRIES = 2

const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404

/** A 404 is an answer (absent or not visible), not a failure worth retrying. */
function retryUnlessNotFound(failures: number, error: unknown): boolean {
  return !isNotFound(error) && failures < MAX_RETRIES
}

/** A Radar review mapped onto a `FeedbackItem`, so the modal renders it with the same detail card as ours. */
function asFeedbackItem(review: RadarReviewDetail['review']): FeedbackItem {
  return normalizeFeedbackItem({
    feedback_id: review.feedback_id,
    source_platform: review.source_platform,
    source_channel: review.source_channel,
    source_url: review.source_url,
    // The source's own timestamp; the review date shown is `day` (writtenDay below), as in the list.
    source_created_at: review.source_created_at,
    original_text: review.text,
    original_language: review.language,
    rating: review.rating,
    title: review.title,
    direct_customer_quote: review.quote,
    category: review.category,
    subcategory: review.subcategory ?? undefined,
    sentiment_label: review.sentiment_label,
    sentiment_score: review.sentiment_score,
    urgency: review.urgency,
    problem_summary: review.problem_summary,
    problem_root_cause_hypothesis: review.problem_root_cause_hypothesis,
    persona_name: review.persona_name,
    persona_type: review.persona_type,
    journey_stage: review.journey_stage,
    impact_area: review.impact_area,
  })
}

function RadarReviewContent({ brand, feedbackId }: Readonly<{ brand: string; feedbackId: string }>) {
  const { t } = useTranslation('feedbackDetail')
  const query = useQuery({
    queryKey: radarKeys.review(brand, feedbackId),
    queryFn: () => radarApi.getReview(brand, feedbackId),
    retry: retryUnlessNotFound,
  })
  if (query.isLoading) return <LoadingSpinner />
  if (isNotFound(query.error)) return <FeedbackNotFound />
  // A malformed answer (no brand or no review) normalizes to null: shown like a failed read.
  if (query.isError || query.data === undefined || query.data === null) {
    return <LoadFailed message={t('radarLoadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  }
  return (
    <ReviewDetailCard
      feedback={asFeedbackItem(query.data.review)}
      level="h2"
      radarBrand={query.data.brand.label}
      writtenDay={query.data.review.day}
    />
  )
}

function ModalBar({ fullPage, onClose }: Readonly<{ fullPage: string | null; onClose: () => void }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-border">
      {fullPage === null ? null : (
        <Link
          to={fullPage}
          className="btn btn-ghost btn-sm"
          onClick={leaveFullscreenOnPlainClick}
        >
          <Maximize2 size={14} aria-hidden="true" />
          {t('openFullPage')}
        </Link>
      )}
      <button type="button" className="icon-btn focus-ring" aria-label={t('closeReview')} title={t('closeReview')} onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

interface ReviewModalProps {
  readonly feedbackId: string
  /** A Radar brand key: the Radar review variant. */
  readonly brand: string | null
  readonly onClose: () => void
}

export default function ReviewModal({ feedbackId, brand, onClose }: ReviewModalProps) {
  const { t } = useTranslation('feedbackDetail')
  const fullPage = brand === null ? `/feedback/${encodeURIComponent(feedbackId)}` : null
  return (
    <ModalShell
      isOpen
      onClose={onClose}
      ariaLabel={brand === null ? t('reviewDialog') : t('radarReviewDialog')}
      panelClassName="max-w-4xl max-h-[90vh] flex flex-col"
    >
      <ModalBar fullPage={fullPage} onClose={onClose} />
      <div className="p-4 space-y-4 overflow-y-auto" data-testid="review-modal-body">
        {brand === null
          ? <FeedbackDetailContent key={feedbackId} id={feedbackId} variant="modal" />
          : <RadarReviewContent key={`${brand}/${feedbackId}`} brand={brand} feedbackId={feedbackId} />}
      </div>
    </ModalShell>
  )
}
