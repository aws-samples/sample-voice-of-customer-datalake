/**
 * @fileoverview Feedback item card component.
 *
 * Displays a single feedback item with:
 * - Source icon and platform name
 * - Sentiment badge and rating
 * - Category and urgency indicators
 * - Truncated text with link to detail view
 * - Compact mode for list views
 *
 * @module components/FeedbackCard
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Copy, MessageCircle, Star, AlertTriangle } from 'lucide-react'
import { format, isValid, parseISO } from 'date-fns'
import type { FeedbackItem } from '../../api/client'
import SentimentBadge from '../SentimentBadge'
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

const SOURCE_ICONS: Record<string, string> = {
  web_scrape: '🌐',
  web_scrape_jsonld: '🌐',
  webscraper: '🌐',
  manual_import: '📝',
  s3_import: '📦',
}

function getSourceIcon(platform: string, channel?: string): string {
  return SOURCE_ICONS[platform] || SOURCE_ICONS[channel ?? ''] || '📝'
}

function formatSourceName(source: string, t: (key: string) => string): string {
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld') {
    return t('feedbackCard.webScraper')
  }
  return source.replace(/_/g, ' ')
}

function RatingStars({ rating }: Readonly<{ rating: number }>) {
  return (
    <div className="flex items-center gap-1 mb-2">
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={14}
          className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
        />
      ))}
    </div>
  )
}

function CompactCard({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  useTranslation('components')
  return (
    <Link
      to={`/feedback/${feedback.feedback_id}`}
      className={clsx(
        'block p-3 rounded-lg border hover:bg-gray-50 transition-colors',
        feedback.urgency === 'high' && 'border-l-4 border-l-orange-500'
      )}
    >
      <div className="flex items-start gap-2">
        <span className="text-lg">{getSourceIcon(feedback.source_platform)}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-700 line-clamp-2">{feedback.original_text}</p>
          <div className="flex items-center gap-2 mt-1">
            <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
            <span className="text-xs text-gray-400">
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
        <span className="text-lg sm:text-xl flex-shrink-0">
          {getSourceIcon(feedback.source_platform, feedback.source_channel)}
        </span>
        <div className="min-w-0">
          <span className="font-medium text-gray-900 capitalize text-sm sm:text-base">
            {formatSourceName(feedback.source_platform, t)}
          </span>
          {feedback.source_channel && feedback.source_channel !== feedback.source_platform && (
            <>
              <span className="text-gray-400 mx-1 sm:mx-2 hidden sm:inline">•</span>
              <span className="text-gray-500 text-xs sm:text-sm block sm:inline">{feedback.source_channel}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {feedback.urgency === 'high' && (
          <span className="badge badge-urgent flex items-center gap-1 text-xs">
            <AlertTriangle size={12} />
            <span className="hidden sm:inline">{t('feedbackCard.urgent')}</span>
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
      <p className="text-sm sm:text-base text-gray-700 mb-3 line-clamp-3">{feedback.original_text}</p>

      {showQuote && (
        <blockquote className="border-l-2 border-blue-300 pl-3 mb-3 text-xs sm:text-sm text-gray-600 italic">
          "{feedback.direct_customer_quote}"
        </blockquote>
      )}

      {feedback.problem_summary && (
        <div className="bg-gray-50 rounded-lg p-2 sm:p-3 mb-3">
          <p className="text-xs sm:text-sm font-medium text-gray-700">{t('feedbackCard.issue', { summary: feedback.problem_summary })}</p>
          {feedback.problem_root_cause_hypothesis && (
            <p className="text-xs text-gray-500 mt-1 hidden sm:block">
              {t('feedbackCard.rootCause', { cause: feedback.problem_root_cause_hypothesis })}
            </p>
          )}
        </div>
      )}
    </>
  )
}

function CardTags({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-3">
      <span className="badge bg-blue-100 text-blue-800 text-xs">{feedback.category}</span>
      {feedback.subcategory && (
        <span className="badge bg-purple-100 text-purple-800 text-xs hidden sm:inline-flex">
          {feedback.subcategory}
        </span>
      )}
      <span className="badge bg-gray-100 text-gray-600 text-xs hidden sm:inline-flex">
        {feedback.journey_stage}
      </span>
      {feedback.persona_name && (
        <span className="badge bg-indigo-100 text-indigo-800 text-xs hidden sm:inline-flex">
          {feedback.persona_name}
        </span>
      )}
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
    <div className="flex items-center justify-between pt-3 border-t border-gray-100 gap-2">
      <span className="text-xs text-gray-400 truncate">
        {formatDate(feedback.source_created_at, 'MMM d, yyyy')}
        <span className="hidden sm:inline"> {formatDate(feedback.source_created_at, 'h:mm a')}</span>
      </span>

      {showActions && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            to={`/feedback/${feedback.feedback_id}`}
            className="text-blue-600 hover:text-blue-700 text-xs sm:text-sm flex items-center gap-1"
          >
            <MessageCircle size={14} />
            <span className="hidden sm:inline">{t('feedbackCard.details')}</span>
          </Link>
          {feedback.source_url && (
            <a
              href={feedback.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-gray-700 p-1"
            >
              <ExternalLink size={14} />
            </a>
          )}
          <button
            onClick={() => onCopy(feedback.original_text)}
            className="text-gray-500 hover:text-gray-700 p-1"
            title={t('feedbackCard.copyText')}
          >
            <Copy size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function FeedbackCard({ feedback, showActions = true, compact = false }: Readonly<FeedbackCardProps>) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  if (compact) {
    return <CompactCard feedback={feedback} />
  }

  return (
    <div className={clsx(
      'card !p-4 sm:!p-6 hover:shadow-md transition-shadow',
      feedback.urgency === 'high' && 'border-l-4 border-l-orange-500'
    )}>
      <CardHeader feedback={feedback} />
      {feedback.rating != null && <RatingStars rating={feedback.rating} />}
      <CardContent feedback={feedback} />
      <CardTags feedback={feedback} />
      <CardFooter feedback={feedback} showActions={showActions} onCopy={copyToClipboard} />
    </div>
  )
}
