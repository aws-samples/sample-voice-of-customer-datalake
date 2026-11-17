/**
 * @fileoverview The run monitor of an engineering run (`/agents/engineering/:runId`; plan v3 4.10, docs/autonomous-agents.md
 * "An engineering run"). The page is reached by its run id (there is no list of runs yet).
 *
 * The run's goal, status, MicroVM time and tokens (its cost once the run control reports it); the run's flow (the
 * revision its start copied, on the read-only canvas the agents' runs use) with each step lit as the conductor reads
 * it, or, for a run that follows no flow, the steps its agents are on; and
 * beside it the Agents, Board, Conversation and Reports panels (the conversation records the signals sent too; the
 * reports are the run's commit, PR and goal reports, each version's Markdown). An admin always has the run's Stop
 * while it has not ended (RunControlBar.tsx, 7.50.03: through the start function, so it reaches a run the signals
 * cannot), and signals the run or an agent on its task, and answers the conductor or an agent, where the deployment
 * lets the monitor reach the run (`actions_available`; else one line beside Stop says so). The reads poll every few
 * seconds while the run is under way (useEngineeringRun.ts: polling until the push lands); a failed read keeps the
 * last good one and its controls on screen, says "Couldn't refresh" with a Retry, and polling backs off.
 *
 * @module pages/Agents/EngineeringRun
 */
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bot, FileText, KanbanSquare, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { WorkflowCanvas } from '../../components/WorkflowEditor/WorkflowCanvas'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { useIsAdmin, useMySub } from '../../store/authStore'
import { BackToAgents } from './BackToAgents'
import { EngineeringRunHeader } from './EngineeringRunHeader'
import { EngineeringRunReactions } from './EngineeringRunReactions'
import { AgentsPanel, BoardPanel } from './EngineeringRunPanels'
import { ConversationPanel } from './EngineeringConversation'
import { ReportsPanel } from './EngineeringReports'
import { RunControlBar } from './RunControlBar'
import { isStopping } from './engineeringRunText'
import { liveSteps } from './engineeringRunText'
import { useEngineeringBoard, useEngineeringConversation, useEngineeringOverview } from './useEngineeringRun'
import type { EngineeringAgent, EngineeringOverview } from '../../api/engineeringRunsApi'

const TABS = ['agents', 'board', 'conversation', 'reports'] as const
type Tab = (typeof TABS)[number]
const TAB_ICONS = { agents: Bot, board: KanbanSquare, conversation: MessagesSquare, reports: FileText }

/**
 * The run's flow definition: its own copy, as its start wrote it (the one it follows, whatever the flow became
 * since), from the overview; for a run started without one, the flow's current revision.
 */
function useRunFlow(run: EngineeringOverview['run']) {
  const copied = run.flow_definition
  const current = useQuery({
    queryKey: workflowsKeys.detail(run.flow), queryFn: () => workflowsApi.get(run.flow),
    enabled: run.flow !== '' && copied === null,
  })
  if (copied !== null) return { definition: copied, isError: false, isLoading: false }
  return { definition: current.data?.workflow.definition ?? null, isError: current.isError, isLoading: current.isLoading }
}

/** The run's flow, its steps lit from the conductor's statuses when the run follows it. */
function FlowGraph({ run, agents }: Readonly<{ run: EngineeringOverview['run']; agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const { flow, flow_steps: flowSteps } = run
  const { definition, isError, isLoading } = useRunFlow(run)
  const states = useMemo(() => liveSteps(agents, new Set(definition?.nodes.map((node) => node.id)), flowSteps),
    [agents, definition, flowSteps])
  if (flow !== '' && isLoading) return <div className="skeleton h-full" />
  if (isError || definition === null) return <p className="p-4 text-sm text-muted">{t('engineeringRun.noFlow')}</p>
  return <WorkflowCanvas definition={definition} readOnly runStates={states} />
}

function Panels({ runId, overview, live, canAct, canSignal, readAt }: Readonly<{
  runId: string; overview: EngineeringOverview; live: boolean; canAct: boolean; readAt: number
  /** An agent may be signalled from its card: an admin where the signals reach the run, no Stop under way. */
  canSignal: boolean
}>) {
  const { t } = useTranslation('agents')
  const [tab, setTab] = useState<Tab>('agents')
  const me = useMySub()
  const board = useEngineeringBoard(runId, live)
  const conversation = useEngineeringConversation(runId, live)
  const tasks = board.data ?? []
  return (
    <section className="card min-w-0 space-y-3">
      <IconTabs tabs={TABS} active={tab} icons={TAB_ICONS} label={t('engineeringRun.panels')}
        labelOf={(id) => t(`engineeringRun.tabs.${id}`)} onSelect={setTab} />
      <div role="tabpanel" aria-label={t(`engineeringRun.tabs.${tab}`)} className="max-h-[70vh] overflow-y-auto">
        {tab === 'agents' && <AgentsPanel runId={runId} agents={overview.agents} tasks={tasks} isAdmin={canSignal && live}
          now={readAt} />}
        {tab === 'board' && <BoardPanel tasks={tasks} actor={canAct && live && me !== '' ? { runId, me } : undefined} />}
        {tab === 'conversation' && (
          <ConversationPanel runId={runId} messages={conversation.data?.messages ?? []} agents={overview.agents}
            isAdmin={canAct} live={live} />
        )}
        {tab === 'reports' && <ReportsPanel runId={runId} live={live} />}
      </div>
    </section>
  )
}

function RunMonitor({ runId, overview, live, readAt }: Readonly<{
  runId: string; overview: EngineeringOverview; live: boolean; readAt: number
}>) {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  // An admin signals and answers only where the monitor can reach the run; the run's Stop is always there.
  const canAct = isAdmin && overview.actions_available
  return (
    <>
      <EngineeringRunHeader overview={overview} />
      {/* (an ended run: only what this page's Stop did, if it ended it) */}
      {isAdmin && <RunControlBar runId={runId} overview={overview} />}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="card p-0 h-[420px] sm:h-[520px] overflow-hidden min-w-0" aria-label={t('engineeringRun.flow')}>
          <FlowGraph run={overview.run} agents={overview.agents} />
        </section>
        <Panels runId={runId} overview={overview} live={live} canAct={canAct} canSignal={canAct && !isStopping(overview.run)}
          readAt={readAt} />
      </div>
      <EngineeringRunReactions runId={runId} status={overview.run.status} reactions={overview.reactions} isAdmin={isAdmin} />
    </>
  )
}

/** A read that failed after a good one: the page keeps that read, says so, and offers a Retry (polling backs off). */
function RefreshFailed({ onRetry, retrying }: Readonly<{ onRetry: () => void; retrying: boolean }>) {
  const { t } = useTranslation('agents')
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-[12px] text-warn">
      <span>{t('engineeringRun.refreshFailed')}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={retrying} onClick={onRetry}>{t('engineeringRun.retry')}</button>
    </p>
  )
}

export default function EngineeringRun() {
  const { t } = useTranslation('agents')
  const { runId = '' } = useParams()
  const { data, dataUpdatedAt, error, isError, isLoading, refetch, isFetching, live, refreshFailed } =
    useEngineeringOverview(runId)
  const notFound = isError && apiErrorStatus(error) === 404
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <BackToAgents />
      {isLoading && <div className="skeleton h-40" />}
      {notFound && (
        <div className="card space-y-1">
          <h1 className="text-xl font-semibold text-text-strong">{t('engineeringRun.notFound')}</h1>
          <p className="text-sm text-muted">{t('engineeringRun.notFoundHint')}</p>
        </div>
      )}
      {isError && !notFound && data === undefined && <LoadFailed onRetry={() => { void refetch() }} retrying={isFetching} />}
      {refreshFailed && <RefreshFailed onRetry={() => { void refetch() }} retrying={isFetching} />}
      {data !== undefined && !notFound && <RunMonitor runId={runId} overview={data} live={live} readAt={dataUpdatedAt} />}
    </div>
  )
}
