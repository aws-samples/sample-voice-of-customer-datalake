/**
 * @fileoverview The workspace's centre (7.51.00): the open sessions, as tabs (the default) or a grid of 1, 2 or 4,
 * with the switch between them; the choice is kept for the run in this browser tab (useSessionLayout.ts).
 * (7.54.00) Beside it "Show thinking", the person's own choice for every thread (useShowThinking.ts); the tab panel is
 * named by the tab shown (AgentTabs.tsx).
 *
 * @module pages/Agents/RunWorkspace/SessionsPane
 */
import { useId } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import Switch from '../../../components/Switch/Switch'
import { GRID_SIZES, sizeOf } from './agentGridModel'
import { AgentTabs } from './AgentTabs'
import { AgentGrid } from './AgentGrid'
import { SessionThread } from './SessionThread'
import { ShowThinkingContext, useShowThinking } from './useShowThinking'
import type { EngineeringAgent, RunLane } from '../../../api/engineeringRunsApi'
import type { SessionActions } from './SessionThread'
import type { useSessionLayout } from './useSessionLayout'

interface Props {
  runId: string
  agents: readonly EngineeringAgent[]
  lanes: Readonly<Record<string, readonly RunLane[]>>
  /** The session the address names (null: none to show yet). */
  current: string | null
  orchestrator: string | null
  /** What an admin may do in a session (null: nothing, SessionThread.tsx). */
  actions: SessionActions | null
  sessions: ReturnType<typeof useSessionLayout>
}

function LayoutSwitch({ sessions }: Readonly<Pick<Props, 'sessions'>>) {
  const { t } = useTranslation('agents')
  const size = sessions.mode === 'grid' ? sizeOf(sessions.grid) : null
  const button = (pressed: boolean) => clsx('btn btn-secondary btn-sm', pressed && 'border-accent bg-accent-subtle text-accent-text')
  return (
    <div role="group" aria-label={t('runWorkspace.sessions.layout')} className="flex items-center gap-1">
      <button type="button" className={button(size === null)} aria-pressed={size === null} onClick={sessions.showTabs}>
        {t('runWorkspace.sessions.asTabs')}
      </button>
      {GRID_SIZES.map((count) => (
        <button key={count} type="button" className={button(size === count)} aria-pressed={size === count}
          aria-label={t('runWorkspace.sessions.asGrid', { count })} onClick={() => sessions.showGrid(count)}>
          {count}
        </button>
      ))}
    </div>
  )
}

export function SessionsPane({ runId, agents, lanes, current, orchestrator, actions, sessions }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const ids = useId()
  const thinking = useShowThinking()
  const shown = agents.find((agent) => agent.agent === current)
  const panelId = `${ids}-panel`
  const tabId = (agent: string) => `${ids}-tab-${agent}`
  const named = current !== null && sessions.tabs.includes(current)
  return (
    <section className="card flex min-h-[28rem] min-w-0 flex-col p-0" aria-label={t('runWorkspace.sessions.label')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium text-text-strong">{t('runWorkspace.sessions.title')}</h2>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <Switch label={t('runWorkspace.sessions.showThinking')} checked={thinking.on} onChange={thinking.set} disabled={false} />
          <LayoutSwitch sessions={sessions} />
        </span>
      </div>
      <ShowThinkingContext.Provider value={thinking.on}>
        {sessions.mode === 'grid' && sessions.grid !== null ? (
          <div className="h-[min(36rem,70vh)] min-h-0">
            <AgentGrid runId={runId} grid={sessions.grid} agents={agents} orchestrator={orchestrator} current={current}
              actions={actions} lanes={lanes} onFocus={sessions.open} onFill={sessions.fillPane} onClosePane={sessions.closePane}
              onResize={sessions.resize} />
          </div>
        ) : (
          <>
            <AgentTabs tabs={sessions.tabs} current={current} agents={agents} orchestrator={orchestrator}
              onOpen={sessions.open} onClose={sessions.close} panelId={panelId} tabId={tabId} />
            <div id={panelId} className="flex h-[min(36rem,70vh)] min-h-0 flex-col" role="tabpanel"
              aria-labelledby={named ? tabId(current) : undefined}
              aria-label={named ? undefined : t('runWorkspace.sessions.label')}>
              {shown === undefined
                ? <p className="p-3 text-sm text-muted">{current === null ? t('engineeringRun.noAgents') : t('runWorkspace.sessions.noAgent', { agent: current })}</p>
                : <SessionThread key={shown.agent} runId={runId} agent={shown} orchestrator={shown.agent === orchestrator} orchestratorId={orchestrator} actions={actions}
                  focused lanes={lanes} />}
            </div>
          </>
        )}
      </ShowThinkingContext.Provider>
    </section>
  )
}
