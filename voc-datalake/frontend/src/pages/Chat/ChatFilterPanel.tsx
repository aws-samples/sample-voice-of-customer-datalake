/**
 * @fileoverview The Chat page's filter/narrowing UX.
 *
 * Wraps the shared `FeedbackFilterPanel` (same multi-select model the
 * Dashboard/Categories/Problem Analysis pages use) and adds two chat-specific
 * concerns the other pages do not have:
 *
 *  - a live "N reviews" count of the scoped set, shown in the panel header;
 *  - a NON-BLOCKING warning when that set is larger than the backend's
 *    MAX_CHAT_FEEDBACK_ITEMS cap, because the chat keeps only the first N and
 *    silently drops the rest.
 *
 * The web-search capability toggle is threaded through the panel's `trailing`
 * slot — it is not a feedback dimension, so it lives alongside the filters
 * rather than inside them (see ConversationFilters in chatStore).
 *
 * @module pages/Chat/ChatFilterPanel
 */
import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Globe } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../api/client'
import { filtersKey, toFeedbackQueryParams } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { MAX_CHAT_FEEDBACK_ITEMS } from '../../api/streamLimits'
import { isWebSearchAvailable } from '../../runtimeConfig'
import FeedbackFilterPanel from '../../components/FeedbackFilterPanel'
import { useCustomFilterControls } from '../Categories/useCustomFilterControls'
import type { ConversationFilters } from '../../store/chatStore'

/** Ask for one item past the cap so "> cap" is distinguishable from "== cap". */
const COUNT_CEILING = MAX_CHAT_FEEDBACK_ITEMS + 1

interface ScopedCount {
  readonly total: number
  readonly isPartialWindow: boolean
  readonly isLoading: boolean
}

/**
 * The live size of the scoped set. Keyed on the filters + window so it refetches
 * when either changes, and keeps the previous number on screen (no flicker)
 * while the next one loads.
 */
function useScopedCount(filters: FeedbackFilterState, days: number, apiEndpoint: string): ScopedCount {
  const params = useMemo(() => toFeedbackQueryParams(filters), [filters])
  const query = useQuery({
    queryKey: ['chat-scoped-count', filtersKey(filters), days],
    queryFn: () => api.getFeedback({ ...params, days, limit: COUNT_CEILING }),
    enabled: !!apiEndpoint,
    placeholderData: keepPreviousData,
  })
  return {
    total: query.data?.total ?? 0,
    isPartialWindow: query.data?.is_partial_window ?? false,
    isLoading: query.isLoading,
  }
}

/** The matched-count line in the header, with the "N+" lower bound when partial. */
function CountBadge({ count, isPartialWindow }: Readonly<{ count: number; isPartialWindow: boolean }>) {
  const { t } = useTranslation('chat')
  const label = isPartialWindow ? t('filters.countPartial', { count }) : t('filters.count', { count })
  return <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums">{label}</span>
}

/** The amber, non-blocking "we'll drop some reviews" notice. */
function DroppedWarning() {
  const { t } = useTranslation('chat')
  return (
    <div
      role="status"
      className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5"
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
      <span>{t('filters.dropped', { max: MAX_CHAT_FEEDBACK_ITEMS })}</span>
    </div>
  )
}

/** The opt-in public web search toggle, rendered in the panel's trailing slot. */
function WebSearchToggle({ enabled, onToggle }: Readonly<{ enabled: boolean; onToggle: (next: boolean) => void }>) {
  const { t } = useTranslation('chat')
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      aria-pressed={enabled}
      title={t('webSearch.tooltip')}
      className={clsx(
        'flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border cursor-pointer transition-colors whitespace-nowrap',
        enabled ? 'bg-sky-50 border-sky-300 text-sky-700' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300',
      )}
    >
      <Globe size={12} className={enabled ? 'text-sky-600' : 'text-gray-400'} />
      <span>{t('webSearch.toggle')}</span>
    </button>
  )
}

export interface ChatFilterPanelProps {
  readonly filters: ConversationFilters
  readonly onChange: (next: ConversationFilters) => void
  readonly days: number
  readonly apiEndpoint: string
}

export default function ChatFilterPanel({ filters, onChange, days, apiEndpoint }: ChatFilterPanelProps) {
  const { feedback, useWebSearch } = filters
  const { total, isPartialWindow, isLoading } = useScopedCount(feedback, days, apiEndpoint)
  const customFilterControls = useCustomFilterControls(apiEndpoint)

  const entities = useQuery({
    queryKey: ['chat-filter-entities', days],
    queryFn: () => api.getEntities({ days, limit: 50 }),
    enabled: !!apiEndpoint,
    placeholderData: keepPreviousData,
  })
  const sources = entities.data?.entities?.sources ?? {}
  const categories = entities.data?.entities?.categories ?? {}

  // Over the cap, the chat keeps only the first MAX_CHAT_FEEDBACK_ITEMS; the
  // header count already reflects that lower bound when the window is partial.
  const overCap = total > MAX_CHAT_FEEDBACK_ITEMS

  return (
    <div className="mb-3">
      <FeedbackFilterPanel
        filters={feedback}
        onChange={(next) => onChange({ feedback: next, useWebSearch })}
        options={{ sources: Object.keys(sources), categories: Object.keys(categories) }}
        counts={{ sources, categories }}
        customFilterControls={customFilterControls}
        headerExtra={isLoading ? undefined : <CountBadge count={total} isPartialWindow={isPartialWindow} />}
        trailing={isWebSearchAvailable() ? (
          <WebSearchToggle
            enabled={useWebSearch === true}
            onToggle={(next) => onChange({ feedback, useWebSearch: next ? true : undefined })}
          />
        ) : undefined}
      />
      {overCap ? <DroppedWarning /> : null}
    </div>
  )
}
