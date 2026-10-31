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

import ReviewLink from '../ReviewLink/ReviewLink'
import { useCopiedFlag } from '../../hooks/useCopiedFlag'
import type { ReactNode } from 'react'
import { ExternalLink, Copy, Check, MessageCircle, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatDate, formatTime } from '../../utils/dateUtils'
import type { FeedbackItem } from '../../api/types'
import ReviewSentimentBadge from '../SentimentBadge/ReviewSentimentBadge'
import UsefulnessBadge from '../UsefulnessBadge/UsefulnessBadge'
import { cleanFeedbackText, cleanReviewText } from '../../utils/cleanReviewText'
import { knownJourneyStage } from '../../utils/displayLabels'
import { useChannelLabel } from '../../hooks/useChannelLabel'
import RatingStars from '../RatingStars'
import CategoryChangeControl, { ManualCategoryBadge } from '../CategoryChangeControl/CategoryChangeControl'
import { SourceIcon } from '../SourceIcon/SourceIcon'
import FeedbackDimensionChips from '../FeedbackDimensions/FeedbackDimensionChips'
import DimensionsEditControl from '../FeedbackDimensions/DimensionsEditControl'
import clsx from 'clsx'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { DisplayLabels } from '../../hooks/useDisplayLabels'
import { ignoreRejection } from '../../lib/rejections'

interface FeedbackCardProps {
  feedback: FeedbackItem
  compact?: boolean
}

/** Legacy scraper ids read as one "Web scraper"; every other id goes through the label helper. */
function formatSourceName(source: string, t: TFunction<'components'>, labels: DisplayLabels): string {
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld') {
    return t('feedbackCard.webScraper')
  }
  return labels.source(source)
}

function CompactCard({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t, i18n } = useTranslation('components')
  return (
    <ReviewLink
      feedbackId={feedback.feedback_id}
      className={clsx(
        'block p-3 rounded-lg border border-border hover:bg-bg-hover hover:border-border-strong transition-colors focus-ring',
        feedback.urgency === 'high' && 'border-l-4 border-l-warn'
      )}
    >
      <div className="flex items-start gap-2">
        <SourceIcon platform={feedback.source_platform} size={18} className="flex-shrink-0 mt-0.5 text-accent-text" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text line-clamp-2">{cleanReviewText(feedback.original_text)}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {feedback.urgency === 'high' && (
              <span className="badge badge-warn">
                <AlertTriangle size={12} aria-hidden="true" />
                {t('feedbackCard.urgent')}
              </span>
            )}
            <ReviewSentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
            <UsefulnessBadge band={feedback.usefulness} />
            <span
              className="text-xs text-muted"
              title={t('feedbackCard.reviewDateHint')}
            >
              {formatDate(feedback.source_created_at, i18n.language, 'N/A')}
            </span>
          </div>
        </div>
      </div>
    </ReviewLink>
  )
}

function CardHeader({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('components')
  const labels = useDisplayLabels()
  const channel = useChannelLabel(feedback.source_channel, feedback.source_platform)
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center">
          <SourceIcon platform={feedback.source_platform} channel={feedback.source_channel} />
        </span>
        <div className="min-w-0">
          <span className="font-medium text-text-strong text-sm sm:text-base">
            {formatSourceName(feedback.source_platform, t, labels)}
          </span>
          {channel !== undefined && (
            <>
              <span className="text-muted-strong mx-1 sm:mx-2 hidden sm:inline">•</span>
              <span className="text-muted text-xs sm:text-sm block sm:inline">{channel}</span>
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
        <ReviewSentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
        <UsefulnessBadge band={feedback.usefulness} />
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
      <p className="text-sm sm:text-base text-text mb-3 line-clamp-3 hyphens-auto [overflow-wrap:break-word]">{feedback.original_text}</p>

      {showQuote && (
        <blockquote className="border-l-2 border-accent/30 pl-3 mb-3 text-xs sm:text-sm text-text italic">
          "{feedback.direct_customer_quote}"
        </blockquote>
      )}

      {feedback.problem_summary && (
        // Long words break (hyphenated where the language allows) instead of
        // pushing the card wider than its column at 390 px / 200 % text.
        <div data-testid="feedback-issue" className="bg-bg-accent rounded-lg p-2 sm:p-3 mb-3 min-w-0 hyphens-auto [overflow-wrap:break-word]">
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

/**
 * A descriptive label: neutral by the design system's labels-vs-status rule,
 * and hidden on phones so the row keeps to the category and the state badges.
 */
function LabelBadge({ children }: Readonly<{ children: ReactNode }>) {
  return <span className="badge badge-muted hidden sm:inline-flex">{children}</span>
}

/**
 * The card's label row. Tones follow docs/kiro-design-system.md › Labels vs
 * status: the category is the ONE emphasised label (`badge-accent`); every
 * other descriptive label (subcategory, journey stage, persona, dimensions,
 * tags) is neutral, and colour is left to state — the hand-set marker
 * (`ManualCategoryBadge`, provenance) and the PII policy badge.
 */
function CardTags({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const labels = useDisplayLabels()
  return (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-3">
      <span className="badge badge-accent">{labels.category(feedback.category)}</span>
      <ManualCategoryBadge feedback={feedback} />
      {feedback.subcategory && <LabelBadge>{labels.subcategory(feedback.subcategory, feedback.category)}</LabelBadge>}
      {knownJourneyStage(feedback.journey_stage) === undefined ? null : <LabelBadge>{labels.plain(feedback.journey_stage)}</LabelBadge>}
      {feedback.persona_name && <LabelBadge>{feedback.persona_name}</LabelBadge>}
      <FeedbackDimensionChips feedback={feedback} />
      <CategoryChangeControl feedback={feedback} />
      <DimensionsEditControl feedback={feedback} />
    </div>
  )
}

/** "Copy text", confirming with a check and "Copied" (announced politely) for two seconds. */
function CopyTextButton({ text, onCopy }: Readonly<{ text: string; onCopy: (text: string) => void }>) {
  const { t } = useTranslation('components')
  const [copied, markCopied] = useCopiedFlag()
  return (
    <button
      type="button"
      onClick={() => { onCopy(text); markCopied() }}
      className={clsx('icon-btn gap-1', copied && 'text-ok')}
      aria-label={t('feedbackCard.copyText')}
      title={t('feedbackCard.copyText')}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span role="status" className={copied ? 'text-xs' : 'sr-only'}>{copied ? t('feedbackCard.copied') : ''}</span>
    </button>
  )
}

interface CardFooterProps {
  feedback: FeedbackItem
  onCopy: (text: string) => void
}

function CardFooter({ feedback, onCopy }: Readonly<CardFooterProps>) {
  const { t, i18n } = useTranslation('components')
  return (
    <div className="flex flex-wrap items-center justify-between pt-3 border-t border-border gap-2">
      <span
        className="text-xs font-mono text-muted min-w-0 break-words"
        title={t('feedbackCard.reviewDateHint')}
      >
        {formatDate(feedback.source_created_at, i18n.language, 'N/A')}
        <span className="hidden sm:inline"> {formatTime(feedback.source_created_at, i18n.language, 'N/A')}</span>
      </span>

      {/* Wraps (and may shrink) so "Details" + the two icon buttons never push
          the card past its column at 390 px / 200 % text. */}
      <div data-testid="feedback-card-actions" className="flex flex-wrap items-center gap-1 min-w-0 max-w-full">
        <ReviewLink
          feedbackId={feedback.feedback_id}
          className="btn btn-ghost btn-sm text-accent-text"
        >
          <MessageCircle size={14} aria-hidden="true" />
          {t('feedbackCard.details')}
        </ReviewLink>
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
        <CopyTextButton text={cleanReviewText(feedback.original_text)} onCopy={onCopy} />
      </div>
    </div>
  )
}

export default function FeedbackCard({ feedback, compact = false }: Readonly<FeedbackCardProps>) {
  const copyToClipboard = (text: string) => {
    // Best-effort: a denied permission or insecure context rejects, and the
    // text stays on screen to copy by hand — so the rejection is absorbed
    // rather than surfacing as an unhandled promise.
    navigator.clipboard.writeText(text).catch(ignoreRejection)
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
      <CardContent feedback={cleanFeedbackText(feedback)} />
      <CardTags feedback={feedback} />
      <CardFooter feedback={feedback} onCopy={copyToClipboard} />
    </div>
  )
}
