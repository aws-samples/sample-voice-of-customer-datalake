import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, AlertTriangle, Lightbulb, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import RatingStars from '../../components/RatingStars'
import type { FeedbackItem } from '../../api/types'
import type { ProblemGroup } from './problemResolution'

function getSentimentLabel(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0) return 'positive'
  if (score < -0.3) return 'negative'
  return 'neutral'
}

interface ProblemRowProps {
  readonly problemGroup: ProblemGroup
  readonly problemKey: string
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onToggleResolved: () => void
  readonly resolvePending?: boolean
}

function ProblemTitle({ problemGroup, resolved }: Readonly<{ problemGroup: ProblemGroup; resolved: boolean }>) {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 mb-1 flex-wrap">
      <AlertTriangle size={12} className="text-warn flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
      <span className={clsx('font-medium text-text-strong text-xs sm:text-sm', resolved && 'line-through')}>
        {problemGroup.problem}
      </span>
      {resolved && (
        <span className="badge badge-ok flex-shrink-0">
          {t('problemResolution.resolved')}
        </span>
      )}
      {problemGroup.similarProblems.length > 0 && (
        <span className="badge badge-info font-mono" title={problemGroup.similarProblems.join(', ')}>
          +{problemGroup.similarProblems.length}
        </span>
      )}
    </div>
  )
}

function ResolveToggleButton({ resolved, onToggleResolved, disabled }: Readonly<{ resolved: boolean; onToggleResolved: () => void; disabled?: boolean }>) {
  const { t } = useTranslation('common')
  const resolveLabel = resolved
    ? t('problemResolution.markUnresolved')
    : t('problemResolution.markResolved')
  return (
    <button
      type="button"
      onClick={onToggleResolved}
      disabled={disabled}
      title={resolveLabel}
      aria-label={resolveLabel}
      className={clsx(
        disabled && 'opacity-40 cursor-not-allowed',
        'absolute right-2 sm:right-3 top-2.5 sm:top-3 p-1 rounded-full transition-colors',
        resolved
          ? 'text-ok hover:bg-ok-subtle active:bg-ok-subtle'
          : 'text-muted-strong hover:text-ok hover:bg-ok-subtle active:bg-ok-subtle',
      )}
    >
      <CheckCircle2 size={16} className="sm:w-[18px] sm:h-[18px]" />
    </button>
  )
}

export function ProblemRow({ problemGroup, problemKey, isExpanded, onToggle, onToggleResolved, resolvePending }: ProblemRowProps) {
  const { t } = useTranslation('common')
  const resolved = problemGroup.resolved === true
  return (
    <div key={problemKey} className="bg-card relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className={clsx(
          'w-full px-3 sm:px-5 py-2.5 sm:py-3 pl-10 sm:pl-16 pr-12 sm:pr-14 flex flex-col sm:flex-row sm:items-start justify-between hover:bg-bg-hover active:bg-border transition-colors text-left gap-2 focus-ring',
          resolved && 'opacity-60',
        )}
      >
        <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown size={16} className="text-muted mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          ) : (
            <ChevronRight size={16} className="text-muted mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          )}
          <div className="flex-1 min-w-0">
            <ProblemTitle problemGroup={problemGroup} resolved={resolved} />
            {problemGroup.rootCause && (
              <div className="flex items-start gap-1.5 sm:gap-2 text-xs text-text">
                <Lightbulb size={12} className="text-warn mt-0.5 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
                <span className="line-clamp-2">{problemGroup.rootCause}</span>
              </div>
            )}
            {problemGroup.similarProblems.length > 0 && isExpanded && (
              <div className="mt-2 text-xs text-muted">
                <span className="font-medium">{t('problemAnalysis:tree.similar')}</span>{' '}
                {problemGroup.similarProblems.slice(0, 2).join(' • ')}
                {problemGroup.similarProblems.length > 2 && ` (+${problemGroup.similarProblems.length - 2})`}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 ml-6 sm:ml-4 flex-shrink-0">
          <span className="text-xs font-mono text-muted" title={t('problemAnalysis:tree.reviews', { count: problemGroup.items.length })}>{problemGroup.items.length}</span>
          {problemGroup.urgentCount > 0 && (
            <span className="badge badge-warn font-mono" title={t('problemAnalysis:stats.urgent')}>
              <AlertTriangle size={12} aria-hidden="true" />
              {problemGroup.urgentCount}
            </span>
          )}
          <SentimentBadge sentiment={getSentimentLabel(problemGroup.avgSentiment)} score={problemGroup.avgSentiment} />
        </div>
      </button>

      {/* Sibling of the row toggle (never nested inside it) so both stay
          valid, independently focusable buttons. */}
      <ResolveToggleButton resolved={resolved} onToggleResolved={onToggleResolved} disabled={resolvePending} />

      {isExpanded && (
        <div className="px-3 sm:px-6 pb-3 sm:pb-4 pl-12 sm:pl-24 space-y-2 sm:space-y-3">
          {problemGroup.items.map((item) => (
            <FeedbackItemCard key={item.feedback_id} item={item} problemSummary={problemGroup.problem} />
          ))}
        </div>
      )}
    </div>
  )
}

function formatDateSafe(dateString: string | null | undefined): string {
  if (!dateString) return 'Unknown'
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) return 'Unknown'
    return date.toLocaleDateString()
  } catch {
    return 'Unknown'
  }
}

function FeedbackItemCard({ item, problemSummary }: Readonly<{ item: FeedbackItem; problemSummary: string }>) {
  const { t } = useTranslation('problemAnalysis')
  return (
    <Link
      to={`/feedback/${item.feedback_id}`}
      className="block p-3 sm:p-4 bg-bg-accent rounded-lg hover:bg-bg-hover hover:border-border-strong active:bg-border transition-colors border border-border focus-ring"
    >
      <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <span className="text-xs font-medium text-text capitalize">
            {item.source_platform.replace(/_/g, ' ')}
          </span>
          {item.urgency === 'high' && (
            <span className="badge badge-warn">Urgent</span>
          )}
        </div>
        <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
      </div>
      <p className="text-xs sm:text-sm text-text line-clamp-3">{item.original_text}</p>
      {item.problem_summary && item.problem_summary !== problemSummary && (
        <p className="text-xs text-muted mt-1 italic line-clamp-1">{t('problemAnalysis:tree.original', { text: item.problem_summary })}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-1.5 sm:mt-2 text-xs text-muted">
        <span>{formatDateSafe(item.source_created_at)}</span>
        {item.rating ? <RatingStars rating={item.rating} size={12} /> : null}
        {item.persona_name && <span className="hidden sm:inline">{item.persona_name}</span>}
      </div>
    </Link>
  )
}
