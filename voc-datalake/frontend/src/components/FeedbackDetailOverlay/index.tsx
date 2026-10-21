/**
 * @fileoverview In-page detail pop-up for one feedback item.
 *
 * Opened from feedback cards on Dashboard, Categories and Problem Analysis so
 * reading an item does not lose the page's filters and scroll position. Built
 * on ModalShell (role=dialog, focus trap, Escape, focus return). "Open full
 * details" goes to `/feedback/:id` for similar items and suggested responses.
 *
 * @module components/FeedbackDetailOverlay
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink, Star, X } from 'lucide-react'
import ModalShell from '../ModalShell'
import SentimentBadge from '../SentimentBadge'
import { EnrichmentBadges } from '../EnrichmentBadges'
import type { FeedbackItem } from '../../api/client'
import { humanize } from '../../utils/enrichmentLabels'

interface FeedbackDetailOverlayProps {
  /** The item to show; null renders nothing (closed). */
  readonly feedback: FeedbackItem | null
  readonly onClose: () => void
}

function formatDate(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function Stars({ rating }: Readonly<{ rating: number }>) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${rating} / 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} size={14} className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'} />
      ))}
    </div>
  )
}

function Tags({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const tags = [feedback.category, feedback.subcategory, feedback.journey_stage, feedback.impact_area]
    .filter((tag): tag is string => typeof tag === 'string' && tag !== '' && tag !== 'unknown')
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span key={tag} className="badge bg-blue-50 text-blue-800 text-xs">{humanize(tag)}</span>
      ))}
      {feedback.persona_name && (
        <span className="badge bg-indigo-100 text-indigo-800 text-xs">{feedback.persona_name}</span>
      )}
      <EnrichmentBadges enrichment={feedback.enrichment} />
    </div>
  )
}

function Analysis({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('common')
  if (!feedback.problem_summary && !feedback.problem_root_cause_hypothesis) return null
  return (
    <div className="bg-gray-50 rounded-lg p-3 space-y-1">
      {feedback.problem_summary && (
        <p className="text-sm text-gray-800"><span className="font-medium">{t('feedbackOverlay.problem')}</span> {feedback.problem_summary}</p>
      )}
      {feedback.problem_root_cause_hypothesis && (
        <p className="text-xs text-gray-600"><span className="font-medium">{t('feedbackOverlay.rootCause')}</span> {feedback.problem_root_cause_hypothesis}</p>
      )}
    </div>
  )
}

function OverlayBody({ feedback, headingId, onClose }: Readonly<{ feedback: FeedbackItem; headingId: string; onClose: () => void }>) {
  const { t } = useTranslation('common')
  const showQuote = feedback.direct_customer_quote && feedback.direct_customer_quote !== feedback.original_text
  return (
    <div className="flex flex-col max-h-[85vh]">
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold text-gray-900 capitalize truncate">
            {humanize(feedback.source_platform)}
          </h2>
          <p className="text-xs text-gray-500">{formatDate(feedback.source_created_at)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {feedback.urgency === 'high' && (
            <span className="badge badge-urgent flex items-center gap-1 text-xs"><AlertTriangle size={12} />{t('feedbackOverlay.urgent')}</span>
          )}
          <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
          <button type="button" onClick={onClose} aria-label={t('feedbackOverlay.close')} className="p-1 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="px-5 py-4 space-y-4 overflow-y-auto">
        {feedback.rating != null && <Stars rating={feedback.rating} />}
        <p className="text-sm text-gray-800 whitespace-pre-line">{feedback.original_text}</p>
        {showQuote && (
          <blockquote className="border-l-2 border-blue-300 pl-3 text-sm text-gray-600 italic">“{feedback.direct_customer_quote}”</blockquote>
        )}
        <Tags feedback={feedback} />
        <Analysis feedback={feedback} />
      </div>
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100">
        {feedback.source_url ? (
          <a href={feedback.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1">
            <ExternalLink size={12} /> {t('feedbackOverlay.viewSource')}
          </a>
        ) : <span />}
        <Link to={`/feedback/${feedback.feedback_id}`} className="btn btn-secondary text-sm">
          {t('feedbackOverlay.openFullDetails')}
        </Link>
      </div>
    </div>
  )
}

export default function FeedbackDetailOverlay({ feedback, onClose }: FeedbackDetailOverlayProps) {
  const headingId = useId()
  return (
    <ModalShell isOpen={feedback !== null} onClose={onClose} ariaLabelledBy={headingId} panelClassName="max-w-2xl">
      {feedback && <OverlayBody feedback={feedback} headingId={headingId} onClose={onClose} />}
    </ModalShell>
  )
}
