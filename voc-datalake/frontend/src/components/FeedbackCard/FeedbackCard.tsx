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

const sourceIcons: Record<string, string> = {
  twitter: '𝕏',
  instagram: '📷',
  facebook: '📘',
  reddit: '🔴',
  trustpilot: '⭐',
  google_reviews: '🔍',
  tavily: '🌐',
  web_scrape: '🌐',
  web_scrape_jsonld: '🌐',
}

// Format source name for display
function formatSourceName(source: string): string {
  // Handle web scraper sources - they use the scraper name as source_platform
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld') {
    return 'Web Scraper'
  }
  return source.replace(/_/g, ' ')
}

export default function FeedbackCard({ feedback, showActions = true, compact = false }: FeedbackCardProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  if (compact) {
    return (
      <Link
        to={`/feedback/${feedback.feedback_id}`}
        className={clsx(
          'block p-3 rounded-lg border hover:bg-gray-50 transition-colors',
          feedback.urgency === 'high' && 'border-l-4 border-l-orange-500'
        )}
      >
        <div className="flex items-start gap-2">
          <span className="text-lg">{sourceIcons[feedback.source_platform] || '📝'}</span>
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

  return (
    <div className={clsx(
      'card !p-4 sm:!p-6 hover:shadow-md transition-shadow',
      feedback.urgency === 'high' && 'border-l-4 border-l-orange-500'
    )}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg sm:text-xl flex-shrink-0">{sourceIcons[feedback.source_platform] || sourceIcons[feedback.source_channel] || '📝'}</span>
          <div className="min-w-0">
            <span className="font-medium text-gray-900 capitalize text-sm sm:text-base">{formatSourceName(feedback.source_platform)}</span>
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
              <span className="hidden sm:inline">Urgent</span>
            </span>
          )}
          <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
        </div>
      </div>

      {/* Rating */}
      {feedback.rating && (
        <div className="flex items-center gap-1 mb-2">
          {[...Array(5)].map((_, i) => (
            <Star
              key={i}
              size={14}
              className={i < feedback.rating! ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
            />
          ))}
        </div>
      )}

      {/* Content */}
      <p className="text-sm sm:text-base text-gray-700 mb-3 line-clamp-3">{feedback.original_text}</p>

      {/* Quote - only show if different from original text */}
      {feedback.direct_customer_quote && 
       !feedback.original_text.includes(feedback.direct_customer_quote) &&
       feedback.direct_customer_quote !== feedback.original_text && (
        <blockquote className="border-l-2 border-blue-300 pl-3 mb-3 text-xs sm:text-sm text-gray-600 italic">
          "{feedback.direct_customer_quote}"
        </blockquote>
      )}

      {/* Problem summary */}
      {feedback.problem_summary && (
        <div className="bg-gray-50 rounded-lg p-2 sm:p-3 mb-3">
          <p className="text-xs sm:text-sm font-medium text-gray-700">Issue: {feedback.problem_summary}</p>
          {feedback.problem_root_cause_hypothesis && (
            <p className="text-xs text-gray-500 mt-1 hidden sm:block">Root cause: {feedback.problem_root_cause_hypothesis}</p>
          )}
        </div>
      )}

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-3">
        <span className="badge bg-blue-100 text-blue-800 text-xs">{feedback.category}</span>
        {feedback.subcategory && (
          <span className="badge bg-purple-100 text-purple-800 text-xs hidden sm:inline-flex">{feedback.subcategory}</span>
        )}
        <span className="badge bg-gray-100 text-gray-600 text-xs hidden sm:inline-flex">{feedback.journey_stage}</span>
        {feedback.persona_name && (
          <span className="badge bg-indigo-100 text-indigo-800 text-xs hidden sm:inline-flex">{feedback.persona_name}</span>
        )}
      </div>

      {/* Footer */}
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
              <span className="hidden sm:inline">Details</span>
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
              onClick={() => copyToClipboard(feedback.original_text)}
              className="text-gray-500 hover:text-gray-700 p-1"
              title="Copy text"
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
