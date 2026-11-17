/**
 * @fileoverview The run workspace (7.51.00; docs/autonomous-agents.md "The run workspace"): one live screen for an
 * engineering run, interactive like Slack rather than cards. Its address is the run's,
 * `/agents/engineering/<run>[/a/<agent>]` (runWorkspacePaths.ts; inside a workspace `/workspace/<slug>/…`), the
 * orchestrator's session without an agent, and it replaced the run monitor at the same place (7.51.00: no redirect
 * needed). Three panes, all live (the overview polled every 5 s while the run is under way):
 *
 * 1. the sessions: the open agents' threads in time order (tabs, or a grid of 1, 2 or 4), each with the composer that
 *    steers the ORCHESTRATOR about it, an agent's Stop and ⋯ (Save, Stop now, Restart), and a Reply under an agent's
 *    own question (where the deployment does not connect the bus and the runtime, the composer is off and says why);
 * 2. the flow: the run's canvas, each step a stage with its agents as sibling lanes, a gate's pass or fail, "you are
 *    here" and a spinner on an agent at work, inert (a click opens a session, never acts); or its timeline;
 * 3. the inspector: the agent open's Changes, Files, Gate, Cost and Memory/Learn, and the run's Assertions, Board and
 *    Reports.
 *
 * Wide, the flow comes first and the inspector last; narrow, the sessions (the main task) come first. Above them the
 * header (budget used against the cap, the parent and child runs) with the run's control bar (RunControlBar.tsx:
 * Pause or Resume, the run's Stop with "Stop now, without saving", Save; Restart run once it ended), which a failed
 * read keeps (its last good state, retried with a backoff); below them people's reactions on the host.
 *
 * @module pages/Agents/RunWorkspace/RunWorkspace
 */
import { useMemo } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { COORDINATE_TASK } from '../../../api/engineeringRunsApi'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { useIsAdmin } from '../../../store/authStore'
import { useReplaceAddress } from '../../../utils/pathPlace'
import { BackToAgents } from '../BackToAgents'
import { EngineeringRunReactions } from '../EngineeringRunReactions'
import { useEngineeringOverview } from '../useEngineeringRun'
import { isStopping } from '../engineeringRunText'
import { readRunAddress } from './runWorkspacePaths'
import { useSessionLayout } from './useSessionLayout'
import { RunHeader } from './RunHeader'
import { RunControlBar } from './RunControlBar'
import { FlowPane } from './FlowPane'
import { SessionsPane } from './SessionsPane'
import { Inspector } from './Inspector'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { SessionActions } from './SessionThread'

/**
 * What an admin may do in the sessions: act on a run under way that the signals, steering and answers reach; where
 * the deployment does not connect them (`actions_available` false), see the composer off and why; nothing on an
 * ended run, or while a Stop of the run is under way (7.50.03: no agent is signalled while it stops).
 */
function sessionActions(isAdmin: boolean, live: boolean, overview: EngineeringOverview): SessionActions {
  if (!isAdmin || !live || isStopping(overview.run)) return 'none'
  return overview.actions_available ? 'act' : 'unconnected'
}

/** The run's orchestrator: its coordinator, whose session the run's own address shows. */
const orchestratorOf = (overview: EngineeringOverview) =>
  overview.agents.find((agent) => agent.task_id === COORDINATE_TASK || agent.role === 'coordinator')?.agent ?? null

function Workspace({ runId, agentInPath, overview, live, readAt, refresh }: Readonly<{
  runId: string; agentInPath: string | null; overview: EngineeringOverview; live: boolean; readAt: number
  /** The last read of the run failed (the one shown is the last good one), and its retry. */
  refresh: { failed: boolean; retry: () => void }
}>) {
  const isAdmin = useIsAdmin()
  // Signals other than the run's Stop, steering, answers and the board's actions need the runtime and the bus.
  const canAct = isAdmin && overview.actions_available
  const orchestrator = orchestratorOf(overview)
  const current = agentInPath ?? orchestrator
  const agentIds = useMemo(() => new Set(overview.agents.map((agent) => agent.agent)), [overview.agents])
  const sessions = useSessionLayout(runId, current, orchestrator, agentIds)
  const shown = overview.agents.find((agent) => agent.agent === current)
  return (
    <>
      <RunHeader overview={overview} controls={(
        <RunControlBar runId={runId} overview={overview} live={live} isAdmin={isAdmin} refreshFailed={refresh.failed} onRetry={refresh.retry} />
      )} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,26rem)]">
        <div className="order-2 min-w-0 2xl:order-1">
          <FlowPane overview={overview} current={current} onOpen={sessions.open} />
        </div>
        <div className="order-1 min-w-0 2xl:order-2">
          <SessionsPane runId={runId} agents={overview.agents} lanes={overview.lanes} current={current} orchestrator={orchestrator}
            actions={sessionActions(isAdmin, live, overview)} sessions={sessions} />
        </div>
        <div className="order-3 min-w-0 lg:col-span-2 2xl:col-span-1">
          <Inspector runId={runId} overview={overview} agent={shown} live={live} canAct={canAct} readAt={readAt} onOpen={sessions.open} />
        </div>
      </div>
      <EngineeringRunReactions runId={runId} status={overview.run.status} reactions={overview.reactions} isAdmin={isAdmin} />
    </>
  )
}

/** A run that is not there (404), or a read that failed (with a retry). */
function NotRead({ error, retry, retrying }: Readonly<{ error: unknown; retry: () => void; retrying: boolean }>) {
  const { t } = useTranslation('agents')
  if (apiErrorStatus(error) !== 404) return <LoadFailed onRetry={retry} retrying={retrying} />
  return (
    <div className="card space-y-1">
      <h1 className="text-xl font-semibold text-text-strong">{t('engineeringRun.notFound')}</h1>
      <p className="text-sm text-muted">{t('engineeringRun.notFoundHint')}</p>
    </div>
  )
}

export default function RunWorkspace() {
  const { runId = '' } = useParams()
  // The agent open in it is the path's own place after the run (`/a/<agent>`); a path off that form is replaced.
  const read = readRunAddress(useLocation())
  useReplaceAddress(read?.replaceWith ?? null)
  const { data, dataUpdatedAt, error, isError, isLoading, refetch, isFetching, live, refreshFailed } = useEngineeringOverview(runId)
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <BackToAgents />
      {isLoading && <div className="skeleton h-40" />}
      {isError && data === undefined && <NotRead error={error} retry={() => { void refetch() }} retrying={isFetching} />}
      {data !== undefined && (
        <Workspace runId={runId} agentInPath={read?.place.agent ?? null} overview={data} live={live} readAt={dataUpdatedAt}
          refresh={{ failed: refreshFailed, retry: () => { void refetch() } }} />
      )}
    </div>
  )
}
