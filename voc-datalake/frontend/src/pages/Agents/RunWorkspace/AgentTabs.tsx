/**
 * @fileoverview The open sessions as tabs (7.51.00, the default; KiroCrew's SessionTabStrip, adapted in agentGridModel.ts):
 * one tab per session open, the one shown selected, a spinner on an agent at work, a close on each, the tabs past
 * the strip's room in a "more" menu, and a picker that opens any other agent of the run.
 *
 * @module pages/Agents/RunWorkspace/AgentTabs
 */
import { useId } from 'react'
import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { splitOverflow } from './agentGridModel'
import { useSessionName } from './useSessionLayout'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

interface Props {
  tabs: readonly string[]
  current: string | null
  agents: readonly EngineeringAgent[]
  orchestrator: string | null
  onOpen: (agent: string) => void
  onClose: (agent: string) => void
}

export function AgentTabs({ tabs, current, agents, orchestrator, onOpen, onClose }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const moreId = useId()
  const nameOf = useSessionName(orchestrator)
  const { shown, more } = splitOverflow(tabs, current)
  const others = agents.filter((agent) => !tabs.includes(agent.agent))
  const working = new Set(agents.filter((agent) => agent.status === 'working').map((agent) => agent.agent))
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
      <div role="tablist" aria-label={t('runWorkspace.sessions.tabs')} className="flex min-w-0 flex-wrap gap-1">
        {shown.map((tab) => (
          <span key={tab} className={clsx('inline-flex items-center rounded-md border', tab === current ? 'border-accent bg-accent-subtle' : 'border-border')}>
            <button type="button" role="tab" aria-selected={tab === current} onClick={() => onOpen(tab)}
              className="inline-flex max-w-[12rem] items-center gap-1 px-2 py-0.5 text-[12px] font-medium">
              {working.has(tab) && <Loader2 size={12} className="animate-spin text-accent-text" aria-label={t('runWorkspace.working')} />}
              <span className="truncate">{nameOf(tab)}</span>
            </button>
            <button type="button" className="px-1 text-muted hover:text-text" onClick={() => onClose(tab)}
              aria-label={t('runWorkspace.sessions.close', { name: nameOf(tab) })}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {more.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[12px]">
          <label htmlFor={`${moreId}-more`} className="text-muted">{t('runWorkspace.sessions.more', { count: more.length })}</label>
          <select id={`${moreId}-more`} className="select w-auto text-[12px]" value="" onChange={(event) => onOpen(event.target.value)}>
            <option value="" disabled>{t('runWorkspace.sessions.choose')}</option>
            {more.map((tab) => <option key={tab} value={tab}>{nameOf(tab)}</option>)}
          </select>
        </span>
      )}
      {others.length > 0 && (
        <span className="ml-auto inline-flex items-center gap-1 text-[12px]">
          <label htmlFor={`${moreId}-open`} className="text-muted">{t('runWorkspace.sessions.open')}</label>
          <select id={`${moreId}-open`} className="select w-auto text-[12px]" value="" onChange={(event) => onOpen(event.target.value)}>
            <option value="" disabled>{t('runWorkspace.sessions.choose')}</option>
            {others.map((agent) => <option key={agent.agent} value={agent.agent}>{nameOf(agent.agent)}</option>)}
          </select>
        </span>
      )}
    </div>
  )
}
