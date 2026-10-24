/**
 * @fileoverview The pieces of one review's detail card (header, text, classification, persona,
 * problem analysis, metadata), shared by the /feedback/:id page and the review modal.
 * `editable` turns off the category / dimension edit controls (a Radar review is read-only).
 * @module pages/FeedbackDetail/FeedbackDetailParts
 */
import { Clock, ExternalLink, Globe, Radar } from 'lucide-react'
import CopyReviewLink from './CopyReviewLink'
import { languageName } from '../../utils/languageName'
import { formatCalendarDay, formatDateTime } from '../../utils/dateUtils'
import { useTranslation } from 'react-i18next'
import type { FeedbackItem } from '../../api/types'
import ReviewSentimentBadge from '../../components/SentimentBadge/ReviewSentimentBadge'
import RatingStars from '../../components/RatingStars'
import CategoryChangeControl, { ManualCategoryBadge } from '../../components/CategoryChangeControl/CategoryChangeControl'
import FeedbackDimensionChips, { PiiPolicyNote } from '../../components/FeedbackDimensions/FeedbackDimensionChips'
import DimensionsEditControl from '../../components/FeedbackDimensions/DimensionsEditControl'
import { SourceIcon } from '../../components/SourceIcon/SourceIcon'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { humanizeId } from '../../utils/displayLabels'

/** Section label inside the main card — an h2 under the page h1 (h3 under the modal's h2). */
export const SECTION_LABEL = 'text-sm font-medium text-muted mb-2 sm:mb-3'

interface HeaderProps {
  readonly feedback: FeedbackItem
  /** The title's element id (the modal's accessible name). */
  readonly titleId?: string
  /** h1 on the page, h2 inside a dialog. */
  readonly level?: 'h1' | 'h2'
  /** A Radar review's brand: shown with a "Radar review" badge. */
  readonly radarBrand?: string
}

function RadarBadge() {
  const { t } = useTranslation('feedbackDetail')
  return <span className="badge badge-info"><Radar size={12} aria-hidden="true" />{t('radarReview')}</span>
}

/**
 * "Source Channel", with the channel left out when it repeats the source (either label
 * contains the other, ignoring case): "App Store", not "App Store App store".
 */
function sourceTitle(source: string, channel: string | undefined): string {
  if (channel === undefined) return source
  const a = source.toLowerCase()
  const b = channel.toLowerCase()
  return a.includes(b) || b.includes(a) ? source : `${source} ${channel}`
}

export function FeedbackHeader({ feedback, titleId, level = 'h1', radarBrand }: HeaderProps) {
  const { t } = useTranslation('feedbackDetail')
  const labels = useDisplayLabels()
  const Heading = level
  // A Radar review is named by its brand ("Example Air review"), never by the stored source id.
  const title = radarBrand === undefined
    ? sourceTitle(labels.source(feedback.source_platform), labels.channel(feedback.source_channel, feedback.source_platform))
    : t('brandReview', { brand: radarBrand })
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex-shrink-0 w-10 h-10 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center">
          <SourceIcon platform={feedback.source_platform} channel={feedback.source_channel} size={20} />
        </span>
        <div className="min-w-0">
          <Heading id={titleId} className="text-xl sm:text-2xl font-bold tracking-tight text-text-strong break-words">
            {title}
          </Heading>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {radarBrand === undefined ? null : <RadarBadge />}
        {feedback.urgency === 'high' && (
          <span className="badge badge-warn">{t('urgent')}</span>
        )}
        <ReviewSentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} size="md" />
      </div>
    </div>
  )
}

export function RatingDisplay({ rating }: Readonly<{ rating: number | null | undefined }>) {
  const { t } = useTranslation('feedbackDetail')
  if (!rating) return null
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-sm text-muted">{t('rating')}:</span>
      <RatingStars rating={rating} size={16} showLabel />
    </div>
  )
}

export function OriginalTextSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t, i18n } = useTranslation('feedbackDetail')
  return (
    <div className="bg-bg-accent border border-border rounded-lg p-4 mb-6">
      <h2 className="text-sm font-medium text-muted mb-2">{t('originalFeedback')}</h2>
      <p className="text-text-strong whitespace-pre-wrap">{feedback.original_text}</p>
      <PiiPolicyNote policy={feedback.pii_policy} />
      {feedback.original_language !== 'en' && feedback.normalized_text && (
        <div className="mt-4 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-muted mb-2">
            {t('translatedFrom', { language: languageName(feedback.original_language, i18n.language) })}
          </h3>
          <p className="text-text">{feedback.normalized_text}</p>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: Readonly<{ label: string; value: string | null | undefined }>) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text">{label}</span>
      <span className="font-medium text-right text-text-strong min-w-0 break-words">{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

function EditControls({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <ManualCategoryBadge feedback={feedback} />
        <CategoryChangeControl feedback={feedback} />
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <FeedbackDimensionChips feedback={feedback} withPolicy={false} />
        <DimensionsEditControl feedback={feedback} />
      </div>
    </>
  )
}

export function ClassificationSection({ feedback, editable }: Readonly<{ feedback: FeedbackItem; editable: boolean }>) {
  const { t } = useTranslation('feedbackDetail')
  const labels = useDisplayLabels()
  return (
    <div>
      <h2 className={SECTION_LABEL}>{t('classification')}</h2>
      <div className="space-y-2 text-sm">
        <DetailRow label={t('category')} value={labels.category(feedback.category)} />
        {feedback.subcategory && <DetailRow label={t('subcategory')} value={labels.subcategory(feedback.subcategory, feedback.category)} />}
        <DetailRow label={t('journeyStage')} value={humanizeId(feedback.journey_stage)} />
        <DetailRow label={t('impactArea')} value={humanizeId(feedback.impact_area)} />
        {feedback.author !== undefined && <DetailRow label={t('author')} value={feedback.author} />}
        {feedback.title !== undefined && <DetailRow label={t('reviewTitle')} value={feedback.title} />}
        {editable ? <EditControls feedback={feedback} /> : null}
      </div>
    </div>
  )
}

export function PersonaSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  return (
    <div>
      <h2 className={SECTION_LABEL}>{t('customerPersona')}</h2>
      <div className="space-y-2 text-sm">
        {feedback.persona_name && <DetailRow label={t('persona')} value={feedback.persona_name} />}
        {feedback.persona_type && <DetailRow label={t('type')} value={humanizeId(feedback.persona_type)} />}
        {!feedback.persona_name && !feedback.persona_type && <p className="text-muted">—</p>}
      </div>
    </div>
  )
}

export function ProblemAnalysisSection({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('feedbackDetail')
  if (!feedback.problem_summary && !feedback.problem_root_cause_hypothesis) return null
  return (
    <div className="bg-warn-subtle border border-warn/30 rounded-lg p-4 mb-6">
      <h2 className="text-sm font-medium text-warn mb-2">{t('problemAnalysis')}</h2>
      {feedback.problem_summary && (
        <p className="text-text-strong mb-2"><strong>{t('issue')}</strong> {feedback.problem_summary}</p>
      )}
      {feedback.problem_root_cause_hypothesis && (
        <p className="text-text text-sm"><strong>{t('possibleRootCause')}</strong> {feedback.problem_root_cause_hypothesis}</p>
      )}
    </div>
  )
}

/** A `YYYY-MM-DD` day as a local calendar date in the reader's language (no time-zone shift), else undefined. */
function formatDay(day: string | undefined, language: string): string | undefined {
  if (day === undefined) return undefined
  const written = formatCalendarDay(day, language)
  // formatCalendarDay hands back its input when it is not a calendar day.
  return written === day ? undefined : written
}

/**
 * The review date. A Radar review passes `writtenDay` (the day its list shows, `radar_day`), so the
 * list and the modal agree; the source's own timestamp is then shown only when it names another
 * day, labelled as the source's.
 */
function ReviewDates({ feedback, writtenDay }: Readonly<{ feedback: FeedbackItem; writtenDay?: string }>) {
  const { t, i18n } = useTranslation('feedbackDetail')
  const unknown = t('unknown')
  const day = formatDay(writtenDay, i18n.language)
  const sourceDiffers = day !== undefined && typeof feedback.source_created_at === 'string'
    && feedback.source_created_at.slice(0, 10) !== writtenDay
  return (
    <>
      <div className="flex items-center gap-1 min-w-0">
        <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
        <span className="break-words" title={t('reviewDateHint')}>
          {t('reviewDate', { date: day ?? formatDateTime(feedback.source_created_at, i18n.language, unknown) })}
        </span>
      </div>
      {sourceDiffers ? (
        <div className="flex items-center gap-1 min-w-0">
          <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
          <span className="break-words">{t('sourceDate', { date: formatDateTime(feedback.source_created_at, i18n.language, unknown) })}</span>
        </div>
      ) : null}
    </>
  )
}

interface MetadataProps {
  readonly feedback: FeedbackItem
  readonly showImported?: boolean
  /** A Radar review's written day (`YYYY-MM-DD`): the date its list shows. */
  readonly writtenDay?: string
  /** A Radar review: the copied link reopens the review modal (it has no page of its own). */
  readonly radar?: boolean
}

/** Review date, import date (ours only: a Radar review has none to show), language, Copy link, original link. */
export function MetadataSection({ feedback, showImported = true, writtenDay, radar = false }: MetadataProps) {
  const { t, i18n } = useTranslation('feedbackDetail')
  const unknown = t('unknown')
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-4 text-xs sm:text-sm text-muted pt-3 sm:pt-4 border-t border-border">
      <ReviewDates feedback={feedback} writtenDay={writtenDay} />
      {showImported ? (
        <div className="flex items-center gap-1 min-w-0">
          <Clock size={14} className="flex-shrink-0" aria-hidden="true" />
          <span className="break-words" title={t('importedHint')}>
            {t('imported', { date: formatDateTime(feedback.processed_at, i18n.language, unknown) })}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <Globe size={14} className="flex-shrink-0" aria-hidden="true" />
        <span>{t('language', { lang: feedback.original_language ? languageName(feedback.original_language, i18n.language) : unknown })}</span>
      </div>
      <CopyReviewLink feedbackId={feedback.feedback_id} radar={radar} />
      {feedback.source_url && (
        <a
          href={feedback.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 link focus-ring rounded-sm sm:ml-auto"
        >
          <ExternalLink size={14} className="flex-shrink-0" aria-hidden="true" />
          {t('viewOriginal')}
        </a>
      )}
    </div>
  )
}
