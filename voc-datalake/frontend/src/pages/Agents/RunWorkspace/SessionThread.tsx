/**
 * @fileoverview One session open in the workspace (7.51.00): an agent's thread, or the orchestrator's, as a
 * Slack-like conversation in time order (ThreadItem.tsx), its header (who, role, status, model and skill, and for an
 * admin on a run under way the agent's Save, Stop and Restart), and the composer that steers the orchestrator about
 * it. One conversation, one session: the thread is the run's own record, read live, never a private copy.
 *
 * The list follows its end while the reader is at it, and stays where they scrolled to otherwise.
 *
 * @module pages/Agents/RunWorkspace/SessionThread
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { startsGroup } from './threadModel'
import { ThreadItemView } from './ThreadItem'
import { SteerComposer } from './SteerComposer'
import { AgentControls } from './AgentControls'
import { useAgentThread } from './useRunWorkspace'
import type { ReactNode } from 'react'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

/** How close to its end (px) the list must be to follow new items. */
const FOLLOW_SLACK = 80

interface Props {
  runId: string
  /** The session's agent (the orchestrator's is the run's coordinator). */
  agent: EngineeringAgent
  orchestrator: boolean
  /** An admin may act (signals, steering) and the run is under way. */
  canAct: boolean
  /** Shown beside the header (a grid pane's picker and close). */
  tools?: ReactNode
}

function SessionHeader({ agent, orchestrator, tools }: Readonly<Pick<Props, 'agent' | 'orchestrator' | 'tools'>>) {
  const { t } = useTranslation('agents')
  const facts = [agent.model, agent.skill_label].filter((fact): fact is string => fact !== null && fact !== '')
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <h3 className="min-w-0 truncate text-sm font-semibold text-text-strong">
        {orchestrator ? t('runWorkspace.orchestrator') : agent.agent}
      </h3>
      {agent.role !== '' && <span className="badge badge-muted">{agent.role}</span>}
      <span className="badge badge-info">{t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status })}</span>
      {facts.length > 0 && <span className="truncate text-[12px] text-muted font-mono">{facts.join(' · ')}</span>}
      {tools !== undefined && <div className="ml-auto flex items-center gap-1">{tools}</div>}
    </div>
  )
}

function Items({ runId, agent }: Readonly<{ runId: string; agent: string }>) {
  const { t } = useTranslation('agents')
  const thread = useAgentThread(runId, agent)
  const list = useRef<HTMLDivElement>(null)
  // Whether the reader is at the list's end (as of their last scroll): new items then scroll into view.
  const following = useRef(true)
  const items = thread.data?.items ?? []
  const count = items.length
  useEffect(() => {
    const element = list.current
    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [count])
  const onScroll = () => {
    const element = list.current
    if (element !== null) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK
  }
  if (thread.isLoading) return <div className="skeleton m-3 h-24" />
  if (thread.isError && apiErrorStatus(thread.error) === 404) return <p className="p-3 text-sm text-muted">{t('runWorkspace.thread.notFound')}</p>
  if (thread.isError) return <div className="p-3"><LoadFailed onRetry={() => { void thread.refetch() }} retrying={thread.isFetching} /></div>
  return (
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1" onScroll={onScroll}>
      {count === 0 && <p className="p-3 text-sm text-muted">{t('runWorkspace.thread.empty')}</p>}
      <ol aria-label={t('runWorkspace.thread.label', { agent })}>
        {items.map((item, index) => (
          <ThreadItemView key={item.ref} runId={runId} agent={agent} item={item} header={startsGroup(items[index - 1], item)} />
        ))}
      </ol>
      {thread.data?.done === true && <p className="px-3 pt-2 text-[12px] text-muted">{t('runWorkspace.thread.ended')}</p>}
    </div>
  )
}

export function SessionThread({ runId, agent, orchestrator, canAct, tools }: Readonly<Props>) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={agent.agent}>
      <SessionHeader agent={agent} orchestrator={orchestrator} tools={tools} />
      {canAct && !orchestrator && <AgentControls runId={runId} agent={agent} />}
      <Items runId={runId} agent={agent.agent} />
      {canAct && <SteerComposer runId={runId} agent={orchestrator ? null : agent.agent} />}
    </section>
  )
}
