import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, AlertTriangle, Lightbulb, CheckCircle2, Undo2 } from 'lucide-react'
import SentimentBadge from '../../components/SentimentBadge'
import type { FeedbackItem } from '../../api/client'

interface ProblemGroup {
  problem: string
  similarProblems: string[]
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
}

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
  readonly isResolved?: boolean
  readonly isResolving?: boolean
  readonly onResolve?: () => void
  readonly onUnresolve?: () => void
}

function ResolveButton({ isResolved, isResolving, onResolve, onUnresolve }: Readonly<{
  isResolved?: boolean
  isResolving?: boolean
  onResolve?: () => void
  onUnresolve?: () => void
}>) {
  if (isResolved) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onUnresolve?.() }}
        disabled={isResolving}
        className="p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors disabled:opacity-50"
        title="Mark as unresolved"
      >
        <Undo2 size={14} className="sm:w-4 sm:h-4" />
      </button>
    )
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onResolve?.() }}
      disabled={isResolving}
      className={`p-1.5 rounded-lg transition-all duration-200 disabled:opacity-50 ${
        isResolving
          ? 'text-green-500 bg-green-50 scale-110'
          : 'text-gray-400 hover:text-green-600 hover:bg-green-50'
      }`}
      title="Mark as resolved"
    >
      <CheckCircle2 size={14} className="sm:w-4 sm:h-4" />
    </button>
  )
}

function ProblemLabel({ problemGroup, isResolved, isExpanded }: Readonly<{
  problemGroup: ProblemGroup
  isResolved?: boolean
  isExpanded: boolean
}>) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 sm:gap-2 mb-1 flex-wrap">
        {isResolved ? (
          <CheckCircle2 size={12} className="text-green-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
        ) : (
          <AlertTriangle size={12} className="text-orange-500 flex-shrink-0 sm:w-[14px] sm:h-[14px]" />
        )}
        <span className={`font-medium text-xs sm:text-sm ${isResolved ? 'text-gray-500 line-through' : 'text-gray-800'}`}>
          {problemGroup.problem}
        </span>
        {isResolved && (
          <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">Resolved</span>
        )}
        {problemGroup.similarProblems.length > 0 && (
          <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full" title={problemGroup.similarProblems.join(', ')}>
            +{problemGroup.similarProblems.length}
          </span>
        )}
      </div>
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
  )
}

function getResolvedStyle(justResolved: boolean, isResolved?: boolean): string {
  if (justResolved) return 'bg-green-50 ring-1 ring-green-200'
  if (isResolved) return 'opacity-60'
  return ''
}

export function ProblemRow({ problemGroup, problemKey, isExpanded, onToggle, isResolved, isResolving, onResolve, onUnresolve }: ProblemRowProps) {
  const [justResolved, setJustResolved] = useState(false)
  const prevResolvedRef = useRef(isResolved ?? false)

  // Detect transition from unresolved → resolved for animation
  useEffect(() => {
    const wasResolved = prevResolvedRef.current
    prevResolvedRef.current = isResolved ?? false

    if (!isResolved || wasResolved) return

    // Use queueMicrotask to avoid synchronous setState in effect body
    const timer = setTimeout(() => setJustResolved(false), 800)
    queueMicrotask(() => setJustResolved(true))
    return () => clearTimeout(timer)
  }, [isResolved])

  return (
    <div
      key={problemKey}
      className={`bg-white transition-all duration-500 ease-in-out ${getResolvedStyle(justResolved, isResolved)}`}
    >
      <div className="flex items-center">
        <button
          onClick={onToggle}
          className="flex-1 px-3 sm:px-6 py-2.5 sm:py-3 pl-10 sm:pl-16 flex flex-col sm:flex-row sm:items-start justify-between hover:bg-gray-50 active:bg-gray-100 transition-colors text-left gap-2"
        >
          <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
            {isExpanded ? (
              <ChevronDown size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
            ) : (
              <ChevronRight size={16} className="text-gray-400 mt-0.5 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
            )}
            <ProblemLabel problemGroup={problemGroup} isResolved={isResolved} isExpanded={isExpanded} />
          </div>
          <div className="flex items-center gap-2 sm:gap-3 ml-6 sm:ml-4 flex-shrink-0">
            <span className="text-xs text-gray-500">{problemGroup.items.length}</span>
            {problemGroup.urgentCount > 0 && (
              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                {problemGroup.urgentCount}
              </span>
            )}
            <SentimentBadge sentiment={getSentimentLabel(problemGroup.avgSentiment)} score={problemGroup.avgSentiment} />
          </div>
        </button>
        <div className="pr-3 sm:pr-6 flex-shrink-0">
          <ResolveButton isResolved={isResolved} isResolving={isResolving} onResolve={onResolve} onUnresolve={onUnresolve} />
        </div>
      </div>

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
  return (
    <Link
      to={`/feedback/${item.feedback_id}`}
      className="block p-3 sm:p-4 bg-gray-50 rounded-lg hover:bg-gray-100 active:bg-gray-200 transition-colors border border-gray-100"
    >
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
      </div>
    </Link>
  )
}
