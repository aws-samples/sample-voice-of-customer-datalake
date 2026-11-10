/**
 * @fileoverview One review in the Radar reviews modal: date, sentiment, theme, rating, the
 * whole text (clamped with "Show more" when long), the problem summary, a "Details" link opening
 * the Radar review modal (`?review=&reviewBrand=`) and a source link.
 * @module pages/Radar/ReviewCard
 */
import clsx from 'clsx'
import { ExternalLink, MessageCircle, Star } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import ReviewLink from '../../components/ReviewLink/ReviewLink'
import { hostOf } from './radarFormat'
import { formatCalendarDay } from '../../utils/dateUtils'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { RadarReview } from '../../api/radarSchema'
import { httpHref } from '../../utils/httpHref'

/** Longer texts start clamped. */
const CLAMP_CHARS = 360

function ReviewText({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation('radar')
  const [expanded, setExpanded] = useState(false)
  const textId = useId()
  const long = text.length > CLAMP_CHARS
  return (
    <>
      <p id={textId} className={clsx('text-sm text-text whitespace-pre-line break-words', long && !expanded && 'line-clamp-4')}>
        {text}
      </p>
      {long ? (
        <button type="button" className="btn btn-ghost btn-sm px-0" aria-expanded={expanded} aria-controls={textId}
          onClick={() => setExpanded((open) => !open)}>
          {expanded ? t('reviews.showLess') : t('reviews.showMore')}
        </button>
      ) : null}
    </>
  )
}

function SourceLink({ url }: Readonly<{ url: string }>) {
  const { t } = useTranslation('radar')
  const href = httpHref(url)
  if (href === undefined) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link text-xs inline-flex items-center gap-1">
      <ExternalLink size={12} aria-hidden="true" />{t('reviews.source', { host: hostOf(url) })}
    </a>
  )
}

/** Opens the Radar review modal over this list (the top-most dialog wins). */
function DetailsLink({ feedbackId, brand }: Readonly<{ feedbackId: string; brand: string }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <ReviewLink feedbackId={feedbackId} brand={brand} className="link text-xs inline-flex items-center gap-1">
      <MessageCircle size={12} aria-hidden="true" />{t('openDetails')}
    </ReviewLink>
  )
}

export default function ReviewCard({ review, brand }: Readonly<{ review: RadarReview; brand: string }>) {
  const { t, i18n } = useTranslation('radar')
  const labels = useDisplayLabels()
  return (
    <li className="border-t border-border pt-3 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <time dateTime={review.day}>{formatCalendarDay(review.day, i18n.language)}</time>
        <SentimentBadge sentiment={review.sentiment_label} label={t(`reviews.sentiments.${review.sentiment_label}`)} />
        <span className="badge-muted">{labels.theme(review.category, review.subcategory)}</span>
        {review.rating === undefined ? null : (
          <span className="inline-flex items-center gap-1">
            <Star size={12} aria-hidden="true" />{t('reviews.rating', { value: review.rating })}
          </span>
        )}
      </div>
      {review.title === undefined ? null : <p className="text-sm font-medium text-text-strong">{review.title}</p>}
      <ReviewText text={review.text} />
      {review.problem_summary === undefined ? null : (
        <p className="text-xs text-muted"><span className="font-medium">{t('reviews.problem')}</span> {review.problem_summary}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <DetailsLink feedbackId={review.feedback_id} brand={brand} />
        {review.source_url === undefined ? null : <SourceLink url={review.source_url} />}
      </div>
    </li>
  )
}
