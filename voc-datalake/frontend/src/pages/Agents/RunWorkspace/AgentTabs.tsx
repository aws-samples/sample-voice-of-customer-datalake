/**
 * @fileoverview The open sessions as tabs (7.51.00, the default; KiroCrew's SessionTabStrip, adapted in
 * agentGridModel.ts), on the app's own tabs component (IconTabs: the `tabs-rail` that scrolls, one `tab` per session,
 * the one shown selected, a spinner on an agent at work). Following the APG tabs pattern, nothing but the tabs sits in
 * the tablist: the close button (a 28 px `icon-btn`, "Close <session>") is beside it and closes the session shown,
 * and one "Open another agent" menu opens any agent of the run not open yet.
 *
 * @module pages/Agents/RunWorkspace/AgentTabs
 */
import { useId } from 'react'
import { Bot, Loader2, Workflow, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../../components/IconTabs/IconTabs'
import { useSessionName } from './useSessionLayout'
import type { LucideIcon } from 'lucide-react'
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
  const openId = useId()
  const nameOf = useSessionName(orchestrator)
  const others = agents.filter((agent) => !tabs.includes(agent.agent))
  const working = new Set(agents.filter((agent) => agent.status === 'working').map((agent) => agent.agent))
  const icons: Readonly<Record<string, LucideIcon>> = Object.fromEntries(tabs.map((tab) => [tab, tab === orchestrator ? Workflow : Bot]))
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1">
      <div className="min-w-0 flex-1">
        <IconTabs tabs={tabs} active={current ?? ''} icons={icons} label={t('runWorkspace.sessions.tabs')} onSelect={onOpen}
          labelOf={(tab) => (
            <>
              <span className="max-w-[12rem] truncate">{nameOf(tab)}</span>
              {working.has(tab) && <Loader2 size={12} className="animate-spin text-accent-text" aria-label={t('runWorkspace.working')} />}
            </>
          )} />
      </div>
      {current !== null && tabs.includes(current) && (
        <button type="button" className="icon-btn" onClick={() => onClose(current)}
          aria-label={t('runWorkspace.sessions.close', { name: nameOf(current) })} title={t('runWorkspace.sessions.close', { name: nameOf(current) })}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
      {others.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[12px]">
          <label htmlFor={openId} className="sr-only">{t('runWorkspace.sessions.openAnother')}</label>
          <select id={openId} className="select w-auto text-[12px]" value="" onChange={(event) => onOpen(event.target.value)}>
            <option value="" disabled>{t('runWorkspace.sessions.openAnother')}</option>
            {others.map((agent) => <option key={agent.agent} value={agent.agent}>{nameOf(agent.agent)}</option>)}
          </select>
        </span>
      )}
    </div>
  )
}
