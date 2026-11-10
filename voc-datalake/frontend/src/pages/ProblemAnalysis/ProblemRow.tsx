import { ChevronDown, ChevronRight, AlertTriangle, Lightbulb, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { describeSentiment, sentimentTone } from '../../components/SentimentWords/sentimentWords'
import { UrgentBadge } from './UrgentBadge'
import SentimentBadge from '../../components/SentimentBadge/SentimentBadge'
import { ProblemExamples } from './ProblemExamples'
import type { ProblemGroup } from '../../api/problemsApi'

/** A problem's sentiment in words with its share ("Mostly negative · 78 % negative"); the average stays as the number. */
function GroupSentiment({ problemGroup }: Readonly<{ problemGroup: ProblemGroup }>) {
  const { t } = useTranslation('common')
  const counts = problemGroup.sentimentCounts
  return (
    <SentimentBadge
      sentiment={sentimentTone(problemGroup.avgSentiment)}
      label={describeSentiment(t, problemGroup.avgSentiment, counts)}
      score={problemGroup.avgSentiment}
    />
  )
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
      {problemGroup.similarCount > 0 && (
        // A count is a descriptive label, not a state: neutral (labels vs status).
        <span className="badge badge-muted" title={problemGroup.similarProblems.join(', ')}>
          {t('problemAnalysis:tree.similarCount', { count: problemGroup.similarCount })}
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
      className={clsx(
        'btn btn-ghost btn-sm flex-shrink-0 mt-1.5 mr-2 sm:mr-3 whitespace-nowrap',
        disabled && 'opacity-40 cursor-not-allowed',
        resolved ? 'text-ok' : 'text-text hover:text-ok',
      )}
    >
      <CheckCircle2 size={14} aria-hidden="true" />
      {resolveLabel}
    </button>
  )
}

export function ProblemRow({ problemGroup, problemKey, isExpanded, onToggle, onToggleResolved, resolvePending }: ProblemRowProps) {
  const { t } = useTranslation('common')
  const resolved = problemGroup.resolved === true
  return (
    <div key={problemKey} className="bg-card">
      <div className="flex items-start">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          className={clsx(
            'flex-1 min-w-0 px-3 sm:px-5 py-2.5 sm:py-3 pl-10 sm:pl-16 flex flex-col sm:flex-row sm:items-start justify-between hover:bg-bg-hover active:bg-border transition-colors text-left gap-2 focus-ring',
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
              {problemGroup.similarCount > 0 && isExpanded && (
                <div className="mt-2 text-xs text-muted">
                  <span className="font-medium">{t('problemAnalysis:tree.similar')}</span>{' '}
                  {problemGroup.similarProblems.slice(0, 2).join(' • ')}
                  {problemGroup.similarCount > 2 && ` (+${problemGroup.similarCount - 2})`}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 ml-6 sm:ml-4 flex-shrink-0">
            <span className="text-xs text-muted whitespace-nowrap">{t('problemAnalysis:tree.reviews', { count: problemGroup.count })}</span>
            <UrgentBadge count={problemGroup.urgentCount} />
            <GroupSentiment problemGroup={problemGroup} />
          </div>
        </button>

        {/* Sibling of the row toggle (never nested inside it) so both stay
            valid, independently focusable buttons. */}
        <ResolveToggleButton resolved={resolved} onToggleResolved={onToggleResolved} disabled={resolvePending} />
      </div>

      {isExpanded && <ProblemExamples problemGroup={problemGroup} />}
    </div>
  )
}
