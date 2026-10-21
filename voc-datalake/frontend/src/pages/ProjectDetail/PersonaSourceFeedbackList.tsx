/**
 * @fileoverview One tab of the persona source-feedback modal: its loading, error,
 * legacy and empty states, the review rows, and paging.
 *
 * @module pages/ProjectDetail/PersonaSourceFeedbackList
 */
import { parseISO } from 'date-fns'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import SentimentBadge from '../../components/SentimentBadge'
import { humanize } from '../../utils/enrichmentLabels'
import { safeFormatDate } from '../../utils/dateUtils'
import type { PersonaFeedbackScope, PersonaSourceFeedbackItem } from '../../api/personaFeedbackSchema'
import type { PersonaSourceFeedbackSummary, usePersonaSourceFeedback } from './usePersonaSourceFeedback'

type SourceFeedbackQuery = ReturnType<typeof usePersonaSourceFeedback>

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The review's date: when it was written, else the row's `date` partition. A
 * bare `YYYY-MM-DD` is read as a local calendar day; `new Date` would read it as
 * UTC midnight and show the previous day west of Greenwich.
 */
function reviewDate(item: PersonaSourceFeedbackItem): { raw: string; label: string } {
  const raw = item.source_created_at || item.date || ''
  const value = DATE_ONLY.test(raw) ? parseISO(raw) : raw
  return { raw, label: safeFormatDate(value, 'MMM d, yyyy', '') }
}

function SourceFeedbackRow({ item, onOpen }: {
  readonly item: PersonaSourceFeedbackItem
  readonly onOpen: (item: PersonaSourceFeedbackItem) => void
}) {
  const date = reviewDate(item)
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-purple-300 hover:bg-purple-50 transition-colors"
      >
        <p className="text-sm text-gray-800 line-clamp-3">{item.original_text}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {item.source_platform ? <span className="capitalize">{humanize(item.source_platform)}</span> : null}
          {item.sentiment_label ? <SentimentBadge sentiment={item.sentiment_label} /> : null}
          {date.label ? <time dateTime={date.raw}>{date.label}</time> : null}
        </div>
      </button>
    </li>
  )
}

function PanelMessage({ children }: { readonly children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-gray-500">{children}</div>
}

function LoadMore({ query }: { readonly query: SourceFeedbackQuery }) {
  const { t } = useTranslation('projectDetail')
  if (!query.hasNextPage) return null
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      {query.isFetchNextPageError ? (
        <p className="text-xs text-red-600">{t('personas.sourceFeedback.loadMoreError')}</p>
      ) : null}
      <button
        type="button"
        onClick={() => void query.fetchNextPage()}
        disabled={query.isFetchingNextPage}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm text-purple-700 border border-purple-200 rounded-lg hover:bg-purple-50 disabled:opacity-50"
      >
        {query.isFetchingNextPage ? <Loader2 size={14} className="animate-spin" /> : null}
        {t('personas.sourceFeedback.loadMore')}
      </button>
    </div>
  )
}

interface SourceFeedbackResultsProps {
  readonly scope: PersonaFeedbackScope
  readonly query: SourceFeedbackQuery
  readonly summary: PersonaSourceFeedbackSummary
  readonly onOpenFeedback: (item: PersonaSourceFeedbackItem) => void
}

function SourceFeedbackResults({ scope, query, summary, onOpenFeedback }: SourceFeedbackResultsProps) {
  const { t } = useTranslation('projectDetail')
  if (summary.total === 0) {
    return (
      <PanelMessage>
        {scope === 'cited' ? t('personas.sourceFeedback.emptyCited') : t('personas.sourceFeedback.emptyUsed')}
      </PanelMessage>
    )
  }
  return (
    <div className="space-y-3">
      {summary.missing > 0 ? (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {t('personas.sourceFeedback.missing', { count: summary.missing })}
        </p>
      ) : null}
      <ul className="space-y-2">
        {summary.items.map((item, index) => (
          // Index-qualified: an id can recur across the two pages a refetch
          // briefly holds, and a lenient row may carry an empty id.
          <SourceFeedbackRow key={`${item.feedback_id}:${index}`} item={item} onOpen={onOpenFeedback} />
        ))}
      </ul>
      <LoadMore query={query} />
    </div>
  )
}

interface PersonaSourceFeedbackListProps {
  readonly scope: PersonaFeedbackScope
  readonly query: SourceFeedbackQuery
  /** Null until the first page has loaded, and after a first page that failed. */
  readonly summary: PersonaSourceFeedbackSummary | null
  readonly onOpenFeedback: (item: PersonaSourceFeedbackItem) => void
}

export default function PersonaSourceFeedbackList({ scope, query, summary, onOpenFeedback }: PersonaSourceFeedbackListProps) {
  const { t } = useTranslation('projectDetail')
  if (query.isPending) {
    return (
      <PanelMessage>
        <span className="inline-flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" />
          {t('personas.sourceFeedback.loading')}
        </span>
      </PanelMessage>
    )
  }
  if (summary === null) {
    return (
      <PanelMessage>
        <p className="text-red-600 mb-3">{t('personas.sourceFeedback.error')}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          {t('personas.sourceFeedback.retry')}
        </button>
      </PanelMessage>
    )
  }
  if (!summary.available) return <PanelMessage>{t('personas.sourceFeedback.legacy')}</PanelMessage>
  return <SourceFeedbackResults scope={scope} query={query} summary={summary} onOpenFeedback={onOpenFeedback} />
}
