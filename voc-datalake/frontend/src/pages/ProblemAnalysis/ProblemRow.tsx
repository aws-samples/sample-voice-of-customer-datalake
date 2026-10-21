import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, AlertTriangle, Lightbulb, CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import SentimentBadge from '../../components/SentimentBadge'
import { EnrichmentBadges } from '../../components/EnrichmentBadges'
import type { FeedbackItem, DateRangeParams } from '../../api/client'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import type { ProblemGroup } from './problemResolution'
import { useProblemItems } from './useProblemItems'

function getSentimentLabel(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0) return 'positive'
  if (score < -0.3) return 'negative'
  return 'neutral'
}

/** Window + filters for the on-demand fetch of a problem's feedback rows. */
export interface ProblemDrillParams {
  readonly dateParams: DateRangeParams
  /** The page's filters, applied to the drill-down so example rows match the
   * same selection as the aggregated tree. */
  readonly filters: FeedbackFilterState
  /** Opens an example row in the detail pop-up instead of navigating away. */
  readonly onOpenFeedback?: (item: FeedbackItem) => void
}

interface ProblemRowProps {
  readonly problemGroup: ProblemGroup
  readonly problemKey: string
  readonly categoryName: string
  readonly subcategoryName: string
  readonly drillParams: ProblemDrillParams
  readonly isExpanded: boolean
  readonly onToggle: () => void
  readonly onToggleResolved: () => void
  readonly resolvePending?: boolean
}

function ProblemTitle({ problemGroup, resolved }: Readonly<{ problemGroup: ProblemGroup; resolved: boolean }>) {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center gap-1.5 sm:gap-2 mb-1 flex-wrap">
      <AlertTriangle size={12} className="text-orange-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
      <span className={clsx('font-medium text-gray-800 text-xs sm:text-sm', resolved && 'line-through')}>
        {problemGroup.problem}
      </span>
      {resolved && (
        <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded-full flex-shrink-0">
          {t('problemResolution.resolved')}
        </span>
      )}
      {problemGroup.similarProblems.length > 0 && (
        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full" title={problemGroup.similarProblems.join(', ')}>
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
          ? 'text-green-600 hover:bg-green-50 active:bg-green-100'
          : 'text-gray-300 hover:text-green-600 hover:bg-green-50 active:bg-green-100',
      )}
    >
      <CheckCircle2 size={16} className="sm:w-[18px] sm:h-[18px]" />
    </button>
  )
}

export function ProblemRow({
  problemGroup, problemKey, categoryName, subcategoryName, drillParams,
  isExpanded, onToggle, onToggleResolved, resolvePending,
}: ProblemRowProps) {
  const resolved = problemGroup.resolved === true
  // The merged group's texts: its representative plus the problems folded into
  // it, so the on-demand fetch narrows to exactly this group's rows.
  const problemTexts = [problemGroup.problem, ...problemGroup.similarProblems]
  const drill = useProblemItems(
    drillParams.dateParams, categoryName, subcategoryName, problemTexts,
    drillParams.filters, isExpanded,
  )
  return (
    <div key={problemKey} className="bg-white relative">
      <button
        onClick={onToggle}
        className={clsx(
          'w-full px-3 sm:px-6 py-2.5 sm:py-3 pl-10 sm:pl-16 pr-12 sm:pr-14 flex flex-col sm:flex-row sm:items-start justify-between hover:bg-gray-50 active:bg-gray-100 transition-colors text-left gap-2',
          resolved && 'opacity-60',
        )}
      >
        <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          ) : (
            <ChevronRight size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          )}
          <div className="flex-1 min-w-0">
            <ProblemTitle problemGroup={problemGroup} resolved={resolved} />
            {problemGroup.rootCause && (
              <div className="flex items-start gap-1.5 sm:gap-2 text-xs text-gray-600">
                <Lightbulb size={12} className="text-yellow-500 mt-0.5 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
                <span className="line-clamp-2">{problemGroup.rootCause}</span>
              </div>
            )}
            {problemGroup.similarProblems.length > 0 && isExpanded && (
              <div className="mt-2 text-xs text-gray-500">
                <span className="font-medium">Similar:</span>{' '}
                {problemGroup.similarProblems.slice(0, 2).join(' • ')}
                {problemGroup.similarProblems.length > 2 && ` (+${problemGroup.similarProblems.length - 2})`}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 ml-6 sm:ml-4 flex-shrink-0">
          <span className="text-xs text-gray-500">{problemGroup.itemCount}</span>
          {problemGroup.urgentCount > 0 && (
            <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
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
          <ProblemItemsList
            items={drill.items}
            isLoading={drill.isLoading}
            isError={drill.isError}
            problemSummary={problemGroup.problem}
            onOpenFeedback={drillParams.onOpenFeedback}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The feedback rows behind an expanded problem, fetched on demand. Shows a
 * spinner while loading, a quiet error line on failure, and up to a page of
 * example rows (the drill-down is a sample for inspection — the true total is
 * the count badge on the row, from the server aggregate).
 */
function ProblemItemsList({
  items, isLoading, isError, problemSummary, onOpenFeedback,
}: Readonly<{
  items: FeedbackItem[]
  isLoading: boolean
  isError: boolean
  problemSummary: string
  onOpenFeedback?: (item: FeedbackItem) => void
}>) {
  const { t } = useTranslation('common')
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
        <Loader2 size={14} className="animate-spin" /> {t('loading')}
      </div>
    )
  }
  if (isError) {
    return <p className="text-xs text-red-600 py-2" role="alert">{t('problemAnalysisPage.itemsLoadFailed')}</p>
  }
  if (items.length === 0) {
    return <p className="text-xs text-gray-400 py-2">{t('problemAnalysisPage.noExamples')}</p>
  }
  return (
    <>
      {items.map((item) => (
        <FeedbackItemCard key={item.feedback_id} item={item} problemSummary={problemSummary} onOpen={onOpenFeedback} />
      ))}
    </>
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

const ITEM_CARD_CLASS = 'block w-full text-left p-3 sm:p-4 bg-gray-50 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors border border-gray-100'

/** A link to the detail page, or a button that opens the pop-up when the page provides one. */
function ItemCardShell({
  item, onOpen, children,
}: Readonly<{ item: FeedbackItem; onOpen?: (item: FeedbackItem) => void; children: React.ReactNode }>) {
  if (onOpen) {
    return <button type="button" onClick={() => onOpen(item)} className={ITEM_CARD_CLASS}>{children}</button>
  }
  return <Link to={`/feedback/${item.feedback_id}`} className={ITEM_CARD_CLASS}>{children}</Link>
}

function FeedbackItemCard({
  item, problemSummary, onOpen,
}: Readonly<{ item: FeedbackItem; problemSummary: string; onOpen?: (item: FeedbackItem) => void }>) {
  return (
    <ItemCardShell item={item} onOpen={onOpen}>
      <div className="flex items-start justify-between mb-1.5 sm:mb-2 gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-700 capitalize">
            {item.source_platform.replace(/_/g, ' ')}
          </span>
          {item.urgency === 'high' && (
            <span className="px-1 py-0.5 bg-red-100 text-red-700 text-xs rounded">Urgent</span>
          )}
        </div>
        <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
      </div>
      <p className="text-xs sm:text-sm text-gray-600 line-clamp-3">{item.original_text}</p>
      {item.problem_summary && item.problem_summary !== problemSummary && (
        <p className="text-xs text-gray-400 mt-1 italic line-clamp-1">Original: {item.problem_summary}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-1.5 sm:mt-2 text-xs text-gray-400">
        <span>{formatDateSafe(item.source_created_at)}</span>
        {item.rating && <span>★ {item.rating}/5</span>}
        {item.persona_name && <span className="hidden xs:inline">{item.persona_name}</span>}
        <EnrichmentBadges enrichment={item.enrichment} />
      </div>
    </ItemCardShell>
  )
}
