/**
 * @fileoverview Feedback item card component.
 *
 * Displays a single feedback item with:
 * - Source icon and platform name
 * - Sentiment badge and rating
 * - Category and urgency indicators
 * - Dimension values, tags and the PII policy badge (redacted / summary only)
 * - Truncated text with link to detail view
 * - Compact mode for list views
 *
 * @module components/FeedbackCard
 */

import { Link } from 'react-router-dom'
import { ExternalLink, Copy, MessageCircle, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { format, isValid, parseISO } from 'date-fns'
import type { FeedbackItem } from '../../api/types'
import SentimentBadge from '../SentimentBadge/SentimentBadge'
import RatingStars from '../RatingStars'
import CategoryChangeControl, { ManualCategoryBadge } from '../CategoryChangeControl/CategoryChangeControl'
import { SourceIcon } from '../SourceIcon/SourceIcon'
import FeedbackDimensionChips from '../FeedbackDimensions/FeedbackDimensionChips'
import DimensionsEditControl from '../FeedbackDimensions/DimensionsEditControl'
import clsx from 'clsx'

// Safe date formatting helper
function formatDate(dateStr: string | undefined, formatStr: string, fallback = 'N/A'): string {
  if (!dateStr) return fallback
  try {
    const date = parseISO(dateStr)
    return isValid(date) ? format(date, formatStr) : fallback
  } catch {
    return fallback
  }
}

interface FeedbackCardProps {
  feedback: FeedbackItem
  showActions?: boolean
  compact?: boolean
}

function formatSourceName(source: string, t: TFunction<'components'>): string {
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld') {
    return t('feedbackCard.webScraper')
  }
  return source.replace(/_/g, ' ')
}

function CompactCard({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('components')
  return (
    <Link
      to={`/feedback/${feedback.feedback_id}`}
      className={clsx(
        'block p-3 rounded-lg border border-border hover:bg-bg-hover hover:border-border-strong transition-colors focus-ring',
        feedback.urgency === 'high' && 'border-l-4 border-l-warn'
      )}
    >
      <div className="flex items-start gap-2">
        <SourceIcon platform={feedback.source_platform} size={18} className="flex-shrink-0 mt-0.5 text-accent-text" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text line-clamp-2">{feedback.original_text}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {feedback.urgency === 'high' && (
              <span className="badge badge-warn">
                <AlertTriangle size={12} aria-hidden="true" />
                {t('feedbackCard.urgent')}
              </span>
            )}
            <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
            <span
              className="text-xs text-muted"
              title={t('feedbackCard.reviewDateHint')}
            >
              {formatDate(feedback.source_created_at, 'MMM d')}
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}

function CardHeader({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center">
          <SourceIcon platform={feedback.source_platform} channel={feedback.source_channel} />
        </span>
        <div className="min-w-0">
          <span className="font-medium text-text-strong capitalize text-sm sm:text-base">
            {formatSourceName(feedback.source_platform, t)}
          </span>
          {feedback.source_channel && feedback.source_channel !== feedback.source_platform && (
            <>
              <span className="text-muted-strong mx-1 sm:mx-2 hidden sm:inline">•</span>
              <span className="text-muted text-xs sm:text-sm block sm:inline">{feedback.source_channel}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {feedback.urgency === 'high' && (
          <span className="badge badge-warn">
            <AlertTriangle size={12} aria-hidden="true" />
            {/* Visually icon-only on phones, but never nameless. */}
            <span className="sr-only sm:not-sr-only">{t('feedbackCard.urgent')}</span>
          </span>
        )}
        <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
      </div>
    </div>
  )
}

function CardContent({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('components')
  const showQuote = feedback.direct_customer_quote &&
    !feedback.original_text.includes(feedback.direct_customer_quote) &&
    feedback.direct_customer_quote !== feedback.original_text

  return (
    <>
      <p className="text-sm sm:text-base text-text mb-3 line-clamp-3">{feedback.original_text}</p>

      {showQuote && (
        <blockquote className="border-l-2 border-accent/30 pl-3 mb-3 text-xs sm:text-sm text-text italic">
          "{feedback.direct_customer_quote}"
        </blockquote>
      )}

      {feedback.problem_summary && (
        <div className="bg-bg-accent rounded-lg p-2 sm:p-3 mb-3">
          <p className="text-xs sm:text-sm font-medium text-text-strong">{t('feedbackCard.issue', { summary: feedback.problem_summary })}</p>
          {feedback.problem_root_cause_hypothesis && (
            <p className="text-xs text-muted mt-1 hidden sm:block">
              {t('feedbackCard.rootCause', { cause: feedback.problem_root_cause_hypothesis })}
            </p>
          )}
        </div>
      )}
    </>
  )
}

function CardTags({ feedback, showActions }: Readonly<{ feedback: FeedbackItem; showActions: boolean }>) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-3">
      <span className="badge badge-accent text-xs">{feedback.category}</span>
      <ManualCategoryBadge feedback={feedback} />
      {feedback.subcategory && (
        <span className="badge badge-aim text-xs hidden sm:inline-flex">
          {feedback.subcategory}
        </span>
      )}
      <span className="badge badge-muted text-xs hidden sm:inline-flex">
        {feedback.journey_stage}
      </span>
      {feedback.persona_name && (
        <span className="badge badge-info text-xs hidden sm:inline-flex">
          {feedback.persona_name}
        </span>
      )}
      <FeedbackDimensionChips feedback={feedback} />
      {showActions && <CategoryChangeControl feedback={feedback} />}
      {showActions && <DimensionsEditControl feedback={feedback} />}
    </div>
  )
}

interface CardFooterProps {
  feedback: FeedbackItem
  showActions: boolean
  onCopy: (text: string) => void
}

function CardFooter({ feedback, showActions, onCopy }: Readonly<CardFooterProps>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border gap-2">
      <span
        className="text-xs font-mono text-muted truncate"
        title={t('feedbackCard.reviewDateHint')}
      >
        {formatDate(feedback.source_created_at, 'MMM d, yyyy')}
        <span className="hidden sm:inline"> {formatDate(feedback.source_created_at, 'h:mm a')}</span>
      </span>

      {showActions && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <Link
            to={`/feedback/${feedback.feedback_id}`}
            className="btn btn-ghost btn-sm text-accent-text"
          >
            <MessageCircle size={14} aria-hidden="true" />
            {t('feedbackCard.details')}
          </Link>
          {feedback.source_url && (
            <a
              href={feedback.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-btn"
              aria-label={t('feedbackCard.openOriginal')}
              title={t('feedbackCard.openOriginal')}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            onClick={() => onCopy(feedback.original_text)}
            className="icon-btn"
            aria-label={t('feedbackCard.copyText')}
            title={t('feedbackCard.copyText')}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

export default function FeedbackCard({ feedback, showActions = true, compact = false }: Readonly<FeedbackCardProps>) {
  const copyToClipboard = (text: string) => {
    // Best-effort: a denied permission or insecure context rejects, and the
    // text stays on screen to copy by hand — so the rejection is absorbed
    // rather than surfacing as an unhandled promise.
    navigator.clipboard.writeText(text).catch(() => undefined)
  }

  if (compact) {
    return <CompactCard feedback={feedback} />
  }

  return (
    <div className={clsx(
      'card !p-4 sm:!p-5 hover:border-border-strong transition-colors',
      feedback.urgency === 'high' && 'border-l-4 border-l-warn'
    )}>
      <CardHeader feedback={feedback} />
      {feedback.rating != null && <RatingStars rating={feedback.rating} className="mb-2" />}
      <CardContent feedback={feedback} />
      <CardTags feedback={feedback} showActions={showActions} />
      <CardFooter feedback={feedback} showActions={showActions} onCopy={copyToClipboard} />
    </div>
  )
}
