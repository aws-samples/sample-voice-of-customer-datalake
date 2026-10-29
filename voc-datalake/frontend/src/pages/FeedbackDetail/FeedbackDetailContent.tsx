/**
 * @fileoverview One of our reviews in full: the detail card and similar feedback. Rendered by the /feedback/:id page and by the review modal (`variant`): in the
 * modal the heading is an h2 naming the dialog, similar items swap `?review=` in place, and
 * the not-found state has no "back to the list" link (the dialog's close button is that).
 * `ReviewDetailCard` is the card alone, also used for a read-only Radar review.
 * @module pages/FeedbackDetail/FeedbackDetailContent
 */
import { useQuery } from '@tanstack/react-query'
import { Inbox } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import { useRouteNavigate } from '../../hooks/useRouteNavigate'
import {
  ClassificationSection, FeedbackHeader, MetadataSection, OriginalTextSection, PersonaSection,
  ProblemAnalysisSection, RatingDisplay,
} from './FeedbackDetailParts'
import TagsSection from './FeedbackTags'
import { SimilarFeedbackSection } from './FeedbackDetailSections'
import { cleanFeedbackText } from '../../utils/cleanReviewText'
import { metricsKeys } from '../../api/queryKeys'

type FeedbackDetailVariant = 'page' | 'modal'

export function LoadingSpinner() {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="flex items-center justify-center h-full py-12" role="status">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" aria-hidden="true" />
      <span className="sr-only">{t('loading')}</span>
    </div>
  )
}

/** The one not-found state; `action` is its single way on (the page's Back), absent in a dialog. */
export function FeedbackNotFound({ action }: Readonly<{ action?: ReactNode }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div className="card flex flex-col items-center text-center py-12 gap-2">
      <Inbox size={24} className="text-muted" aria-hidden="true" />
      <p className="text-sm font-medium text-text-strong">{t('notFound')}</p>
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  )
}

/** A 404 is the answer (absent or not visible): asking again only doubles the wait. */
function retryUnlessNotFound(failures: number, error: unknown): boolean {
  return apiErrorStatus(error) !== 404 && failures < 1
}

/** Lower-case words only: quote marks, punctuation and spacing never make a quote "different". */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The customer quote, unless it is (a trimmed copy of) the whole text shown right above it. */
function showsQuote(feedback: FeedbackItem): boolean {
  const quote = feedback.direct_customer_quote ?? ''
  if (quote.trim() === '') return false
  return comparable(quote) !== comparable(feedback.original_text)
}

interface ReviewDetailCardProps {
  readonly feedback: FeedbackItem
  readonly level: 'h1' | 'h2'
  /**
   * Our review: tag chips open Categories through this, and the edit controls show.
   * Absent for a Radar review, which is read-only and has no Categories to filter.
   */
  readonly onOpenTag?: (path: string) => void
  readonly radarBrand?: string
  /** A Radar review's written day (`radar_day`), shown as its review date. */
  readonly writtenDay?: string
}

export function ReviewDetailCard({ feedback: stored, level, onOpenTag, radarBrand, writtenDay }: ReviewDetailCardProps) {
  const ours = onOpenTag !== undefined
  // Scrape artefacts (`\.`, `\*`, stray `**`) are cleaned for display only; nothing is written back.
  const feedback = cleanFeedbackText(stored)
  return (
    <div className="card">
      <FeedbackHeader feedback={feedback} level={level} radarBrand={radarBrand} />
      <RatingDisplay rating={feedback.rating} />
      <OriginalTextSection feedback={feedback} />
      {showsQuote(feedback) && (
        <blockquote className="border-l-4 border-accent pl-4 mb-6 italic text-text">
          "{feedback.direct_customer_quote}"
        </blockquote>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 mb-4 sm:mb-6">
        <ClassificationSection feedback={feedback} editable={ours} />
        <PersonaSection feedback={feedback} />
      </div>
      <ProblemAnalysisSection feedback={feedback} />
      {ours ? <TagsSection feedback={feedback} onOpen={onOpenTag} /> : null}
      <MetadataSection feedback={feedback} showImported={ours} writtenDay={writtenDay} radar={radarBrand !== undefined} />
    </div>
  )
}

interface FeedbackDetailContentProps {
  readonly id: string
  readonly variant: FeedbackDetailVariant
  /** The page's Back control: above the card, or as the not-found state's one action. */
  readonly back?: ReactNode
}

export default function FeedbackDetailContent({ id, variant, back }: FeedbackDetailContentProps) {
  const { config } = useConfigStore()
  const openRoute = useRouteNavigate()
  const [showSimilar, setShowSimilar] = useState(false)
  const enabled = !!config.apiEndpoint && id !== ''

  const { data: feedback, isLoading } = useQuery({
    queryKey: metricsKeys.feedback(id),
    queryFn: () => api.getFeedbackById(id),
    enabled,
    retry: retryUnlessNotFound,
  })
  const similar = useQuery({
    queryKey: ['feedback-similar', id],
    queryFn: () => api.getSimilarFeedback(id, 8),
    enabled: enabled && showSimilar,
  })

  if (isLoading) return <LoadingSpinner />
  if (!feedback) return <FeedbackNotFound action={back} />

  return (
    <>
      {back}
      <ReviewDetailCard feedback={feedback} level={variant === 'page' ? 'h1' : 'h2'} onOpenTag={openRoute} />
      <SimilarFeedbackSection
        activeTab={showSimilar ? 'similar' : 'details'}
        onToggle={() => setShowSimilar((open) => !open)}
        similarItems={similar.data?.items}
        isLoading={similar.isLoading}
        isError={similar.isError}
        inModal={variant === 'modal'}
      />
    </>
  )
}
