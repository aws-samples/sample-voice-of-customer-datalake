/**
 * @fileoverview The /chat filter panel, above the composer (ported from #429's ChatFilterPanel,
 * docs/assistant-chat-scope.md).
 *
 * It sets the conversation's scope (chatScopeStore), sent with every turn as
 * `forwardedProps.scope`: the stream's feedback tools treat it as a floor the model cannot widen,
 * and each feedback read uses at most CHAT_SCOPE_MAX_ITEMS reviews. The header shows how many
 * reviews the scope matches in the time window (useScopeCount) and, over the cap, a non-blocking
 * warning. Collapsed by default; the header is one button (aria-expanded / aria-controls).
 *
 * @module pages/Chat/ChatScopePanel
 */
import { useId, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, SlidersHorizontal } from 'lucide-react'
import clsx from 'clsx'
import { api, getDateRangeParams } from '../../api/client'
import { CHAT_SCOPE_MAX_ITEMS } from '../../assistant/contract'
import { useChatScopeStore, useScopeFilters } from '../../assistant/store/chatScopeStore'
import type { ScopeFilters } from '../../assistant/store/chatScopeStore'
import TimeRangeSelector from '../../components/TimeRangeSelector/TimeRangeSelector'
import { useConfigStore } from '../../store/configStore'
import ScopeFields, { type ScopeOptions } from './ScopeFields'
import { useScopeCount } from './useScopeCount'

const ENTITY_LIMIT = 50

/** The choices each field offers: what the window holds (`GET /feedback/entities`), most frequent first. */
function useScopeOptions(enabled: boolean): ScopeOptions {
  const { timeRange, customDays, dateBasis } = useConfigStore()
  const range = getDateRangeParams(timeRange, customDays, dateBasis)
  const { data } = useQuery({
    queryKey: ['chat-scope-options', range],
    queryFn: () => api.getEntities({ ...range, limit: ENTITY_LIMIT }),
    enabled,
    placeholderData: keepPreviousData,
  })
  return {
    sources: Object.keys(data?.entities.sources ?? {}),
    categories: Object.keys(data?.entities.categories ?? {}),
    channels: Object.keys(data?.channels ?? {}),
    tags: Object.keys(data?.tags ?? {}),
  }
}

function CountLabel({ total, isPartial, isLoading, isError }: Readonly<ReturnType<typeof useScopeCount>>) {
  const { t, i18n } = useTranslation('assistant')
  if (isLoading) return <span className="text-[12px] text-muted">{t('scope.counting')}</span>
  if (isError) return <span className="text-[12px] text-muted">{t('scope.countUnavailable')}</span>
  const formatted = total.toLocaleString(i18n.language)
  return (
    <span className="text-[12px] tabular-nums text-muted">
      {t(isPartial ? 'scope.countPartial' : 'scope.count', { count: total, formatted })}
    </span>
  )
}

function OverCapWarning() {
  const { t } = useTranslation('assistant')
  return (
    <p role="status" className="mt-2 flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn-subtle px-2.5 py-1.5 text-[12px] text-warn">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>{t('scope.overCap', { max: CHAT_SCOPE_MAX_ITEMS })}</span>
    </p>
  )
}

export default function ChatScopePanel({ threadId }: Readonly<{ threadId: string }>) {
  const { t } = useTranslation('assistant')
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const enabled = useConfigStore((s) => s.config.apiEndpoint !== '')
  const filters = useScopeFilters(threadId)
  const setFilters = useChatScopeStore((s) => s.setFilters)
  const onChange = (next: ScopeFilters) => setFilters(threadId, next)
  const count = useScopeCount(filters, enabled)
  const options = useScopeOptions(enabled && expanded)
  const active = Object.keys(filters).length
  return (
    <section aria-label={t('scope.title')} className="border-t border-border px-3 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-9 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium hover:bg-bg-hover focus-visible:outline-2"
        >
          <SlidersHorizontal size={14} aria-hidden />
          {t('scope.title')}
          <span className="font-normal text-muted">
            {active === 0 ? t('scope.allFeedback') : t('scope.activeFilters', { count: active })}
          </span>
          <ChevronDown size={14} aria-hidden className={clsx('transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
        </button>
        <CountLabel {...count} />
        {active > 0 && (
          <button type="button" className="link min-h-9 text-[12px]" onClick={() => onChange({})}>
            {t('scope.clear')}
          </button>
        )}
      </div>
      {!count.isLoading && count.total > CHAT_SCOPE_MAX_ITEMS && <OverCapWarning />}
      <div id={bodyId} hidden={!expanded} className="py-3">
        {expanded && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
              <span>{t('scope.timeRange')}</span>
              <TimeRangeSelector />
            </div>
            <ScopeFields filters={filters} options={options} onChange={onChange} />
          </div>
        )}
      </div>
    </section>
  )
}
