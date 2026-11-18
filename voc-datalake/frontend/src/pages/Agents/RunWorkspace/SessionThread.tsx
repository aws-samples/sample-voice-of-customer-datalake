/**
 * @fileoverview One session open in the workspace (7.51.00): an agent's thread, or the orchestrator's, as a
 * Slack-like conversation in time order (ThreadItem.tsx), its header (who, role, its status in its tone, model and
 * skill, why it looks stuck, and for an admin on a run under way the agent's Stop and ⋯), and the composer that steers
 * the orchestrator about it (its Send the primary button only in the session in focus). An agent's own question in
 * the thread carries a Reply (QuestionReply.tsx), its thread read from the run's conversation. Each is shown by its own
 * flag (7.51.02): the agent's Stop and ⋯ where its signals reach the run (the start function), the Reply and the
 * composer where steering and replies do (the bus); where the deployment names no bus for the Agents API, an admin's
 * composer is shown off with why. One conversation, one
 * session: the thread is the run's own record, read live, never a private copy.
 *
 * The list follows its end while the reader is at it, and stays where they scrolled to otherwise. (7.51.04) The
 * supervisor's lines read in plain words, a run of its same health line as one line (supervisorLines.ts), and the
 * line under an ended thread says how its session ended. (7.54.00) The header and the agent's controls stay above
 * the list, never over it, with a shadow while it is scrolled under them; the agent's thinking shows while the
 * Sessions pane's "Show thinking" is on.
 *
 * @module pages/Agents/RunWorkspace/SessionThread
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { useEngineeringConversation } from '../useEngineeringRun'
import { startsGroup, withoutThinking } from './threadModel'
import { useThinkingShown } from './useShowThinking'
import { foldRepeats } from './supervisorLines'
import { ThreadItemView } from './ThreadItem'
import { SteerComposer } from './SteerComposer'
import { AgentControls } from './AgentControls'
import { useAgentThread } from './useRunWorkspace'
import { statusChipClass, takesSignals } from './agentStatus'
import type { ReactNode } from 'react'
import type { EngineeringAgent, RunLane } from '../../../api/engineeringRunsApi'

/**
 * What an admin may do in a session of a run under way (7.51.02), each by its own flag: steer the orchestrator and
 * reply to the agent's questions where steering reaches the run (else the composer is off, saying why), and signal
 * the agent where its signals do. A session takes `null` for none (not an admin, an ended run, or one a Stop is
 * ending).
 */
export interface SessionActions {
  steer: boolean
  signals: boolean
}

/** How close to its end (px) the list must be to follow new items. */
const FOLLOW_SLACK = 80
/** The conversation's type of an agent's question (bus schema `msg.question`). */
const QUESTION = 'msg.question'

interface Props {
  runId: string
  /** The session's agent (the orchestrator's is the run's coordinator). */
  agent: EngineeringAgent
  orchestrator: boolean
  /** The run's orchestrator (7.51.04: its failure sends the run to a person, as its thread says). */
  orchestratorId: string | null
  actions: SessionActions | null
  /** The session in focus (the one the address names): its composer's Send is the primary button. */
  focused: boolean
  /** The run's lanes (an agent whose task is over takes no signal). */
  lanes: Readonly<Record<string, readonly RunLane[]>>
  /** Shown beside the header (a grid pane's picker and close). */
  tools?: ReactNode
}

/**
 * (7.54.00) The header never shares a line with the thread: it is outside the list that scrolls, never shrinks, has
 * the card's own background, and takes a shadow while the thread is scrolled under it, so a cut row reads as the
 * thread going on above it. Who it is (and a pane's tools) on the first line, the role, state, model and skill on the
 * second, cut with their whole text on hover; it holds in a quarter pane.
 */
function SessionHeader({ agent, orchestrator, tools }: Readonly<Pick<Props, 'agent' | 'orchestrator' | 'tools'>>) {
  const { t } = useTranslation('agents')
  const facts = [agent.model, agent.skill_label].filter((fact): fact is string => fact !== null && fact !== '')
  const name = orchestrator ? t('runWorkspace.orchestrator') : agent.agent
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <TruncatedText as="h3" className="min-w-0 flex-1 truncate text-sm font-semibold text-text-strong" text={name} />
        {tools !== undefined && <div className="flex shrink-0 items-center gap-1">{tools}</div>}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        {agent.role !== '' && <span className="badge badge-muted shrink-0">{agent.role}</span>}
        <span className={clsx(statusChipClass(agent.status), 'shrink-0')}>{t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status })}</span>
        {facts.length > 0 && <TruncatedText as="span" className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" text={facts.join(' · ')} />}
      </div>
      {agent.stuck_why !== null && (
        <p role="note" className="mt-1 rounded-md bg-warn-subtle px-2 py-1 text-[12px] text-warn break-words">
          {t('engineeringRun.agent.stuck', { reason: agent.stuck_why })}
        </p>
      )}
    </div>
  )
}

/** The agent's own questions in the run's conversation, by their thread item's ref (`c<seq>`) → their thread. */
function useQuestions(runId: string, agent: string, live: boolean): ReadonlyMap<string, string> {
  const conversation = useEngineeringConversation(runId, live)
  const messages = conversation.data?.messages
  return useMemo(() => new Map((messages ?? [])
    .filter((message) => message.type === QUESTION && message.message.from.kind === 'agent' && message.message.from.id === agent)
    .map((message) => [`c${String(message.seq)}`, message.message.thread_id] as const)), [messages, agent])
}

/** The line under a thread that has ended, by how its session ended (7.51.04). */
const ENDED_LINES: Readonly<Record<string, string>> = {
  done: 'runWorkspace.thread.endedDone', failed: 'runWorkspace.thread.endedFailed', stopped: 'runWorkspace.thread.endedStopped',
}

/** Loading: the shape of a thread (a sender line, two tool lines, a reply), not one grey block. */
function ThreadSkeleton() {
  const { t } = useTranslation('agents')
  return (
    <div className="min-h-0 flex-1 space-y-2 p-3" role="status" aria-label={t('runWorkspace.loading')}>
      <div className="skeleton h-3 w-32" />
      <div className="skeleton h-4 w-3/4" />
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-12 w-full" />
    </div>
  )
}

function Items({ runId, agent, status, orchestrator, canReply, onScrolled }: Readonly<{
  runId: string; agent: string; status: string; orchestrator: string | null; canReply: boolean
  /** Whether the list is scrolled down from its top (its header then takes a shadow). */
  onScrolled: (scrolled: boolean) => void
}>) {
  const { t } = useTranslation('agents')
  const thread = useAgentThread(runId, agent)
  const questions = useQuestions(runId, agent, canReply)
  const thinking = useThinkingShown()
  const list = useRef<HTMLDivElement>(null)
  // Whether the reader is at the list's end (as of their last scroll): new items then scroll into view.
  const following = useRef(true)
  const items = thread.data?.items
  // (7.51.04) A run of the supervisor's same health line is one line, its latest; (7.54.00) the agent's thinking only
  // while "Show thinking" is on.
  const shown = useMemo(() => {
    const folded = foldRepeats(items ?? [])
    return thinking ? folded : withoutThinking(folded)
  }, [items, thinking])
  const count = items?.length ?? 0
  useEffect(() => {
    const element = list.current
    if (element === null) return
    if (following.current) element.scrollTop = element.scrollHeight
    onScrolled(element.scrollTop > 0)
  }, [count, onScrolled])
  const onScroll = () => {
    const element = list.current
    if (element === null) return
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK
    onScrolled(element.scrollTop > 0)
  }
  if (thread.isLoading) return <ThreadSkeleton />
  if (thread.isError && apiErrorStatus(thread.error) === 404) return <p className="p-3 text-sm text-muted">{t('runWorkspace.thread.notFound')}</p>
  if (thread.isError) return <div className="p-3"><LoadFailed onRetry={() => { void thread.refetch() }} retrying={thread.isFetching} /></div>
  return (
    <div ref={list} data-thread-scroll className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 pt-1" onScroll={onScroll}>
      {shown.length === 0 && <p className="p-3 text-sm text-muted">{t('runWorkspace.thread.empty')}</p>}
      <ol aria-label={t('runWorkspace.thread.label', { agent })}>
        {shown.map(({ key, item, said }, index) => (
          <ThreadItemView key={key} runId={runId} agent={agent} item={item} header={startsGroup(shown[index - 1]?.item, item)}
            reply={canReply ? questions.get(item.ref) : undefined} said={said} orchestrator={orchestrator}
            ended={thread.data?.done === true} />
        ))}
      </ol>
      {thread.data?.done === true && (
        <p className="px-3 pt-2 text-[12px] text-muted">{t(ENDED_LINES[status] ?? 'runWorkspace.thread.ended')}</p>
      )}
    </div>
  )
}

export function SessionThread({ runId, agent, orchestrator, orchestratorId, actions, focused, lanes, tools }: Readonly<Props>) {
  const steer = actions?.steer === true
  const [scrolled, setScrolled] = useState(false)
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={agent.agent}>
      {/* (7.54.00) What stays above the thread: outside the list that scrolls, the card's own background, never shrunk,
          a shadow while the thread is scrolled under it. Positioned (no z-index) so the shadow paints over the list. */}
      <div data-scrolled={scrolled} className={clsx('relative shrink-0 bg-card transition-shadow', scrolled && 'shadow-sm')}>
        <SessionHeader agent={agent} orchestrator={orchestrator} tools={tools} />
        {actions?.signals === true && !orchestrator && takesSignals(agent, lanes) && <AgentControls runId={runId} agent={agent} />}
      </div>
      <Items runId={runId} agent={agent.agent} status={agent.status} orchestrator={orchestratorId} canReply={steer}
        onScrolled={setScrolled} />
      {actions !== null && <SteerComposer runId={runId} agent={orchestrator ? null : agent.agent} primary={focused} connected={steer} />}
    </section>
  )
}
