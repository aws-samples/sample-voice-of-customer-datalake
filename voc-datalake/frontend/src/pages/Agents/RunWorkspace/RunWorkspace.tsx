/**
 * @fileoverview The run workspace (7.51.00; docs/autonomous-agents.md "The run workspace"): one live screen for an
 * engineering run, interactive like Slack rather than cards. Its address is the run's,
 * `/agents/engineering/<run>[/a/<agent>]` (runWorkspacePaths.ts; inside a workspace `/workspace/<slug>/…`), the
 * orchestrator's session without an agent, and it replaced the run monitor at the same place (7.51.00: no redirect
 * needed). Three panes, all live (the overview polled every 5 s while the run is under way):
 *
 * 1. the flow: the run's canvas, each step a stage with its agents as sibling lanes, a gate's pass or fail, "you are
 *    here" and a spinner on an agent at work, inert (a click opens a session, never acts); or its timeline;
 * 2. the sessions: the open agents' threads in time order (tabs, or a grid of 1, 2 or 4), each with the composer that
 *    steers the ORCHESTRATOR about it, and an agent's Save, Stop and Restart;
 * 3. the inspector of the agent open: Changes, Files, Gate, Assertions, Cost and Memory/Learn.
 *
 * Above them the header (status, budget used against the cap, the parent and child runs) and the run's controls
 * (Pause, Resume, Stop; Restart run once it ended); below them the run monitor's own panels (agents, board,
 * conversation, reports) and people's reactions on the host.
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
import { readRunAddress } from './runWorkspacePaths'
import { useSessionLayout } from './useSessionLayout'
import { RunHeader } from './RunHeader'
import { RunControls } from './RunControls'
import { FlowPane } from './FlowPane'
import { SessionsPane } from './SessionsPane'
import { Inspector } from './Inspector'
import { RunPanels } from './RunPanels'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

/** The run's orchestrator: its coordinator, whose session the run's own address shows. */
const orchestratorOf = (overview: EngineeringOverview) =>
  overview.agents.find((agent) => agent.task_id === COORDINATE_TASK || agent.role === 'coordinator')?.agent ?? null

function Workspace({ runId, agentInPath, overview, live, readAt }: Readonly<{
  runId: string; agentInPath: string | null; overview: EngineeringOverview; live: boolean; readAt: number
}>) {
  const isAdmin = useIsAdmin()
  // An admin acts only where the workspace can reach the run; until then RunControls says why there are no controls.
  const canAct = isAdmin && overview.actions_available
  const orchestrator = orchestratorOf(overview)
  const current = agentInPath ?? orchestrator
  const agentIds = useMemo(() => new Set(overview.agents.map((agent) => agent.agent)), [overview.agents])
  const sessions = useSessionLayout(runId, current, orchestrator, agentIds)
  const shown = overview.agents.find((agent) => agent.agent === current)
  return (
    <>
      <RunHeader overview={overview} />
      <RunControls runId={runId} overview={overview} live={live} isAdmin={isAdmin} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,26rem)]">
        <FlowPane overview={overview} current={current} onOpen={sessions.open} />
        <SessionsPane runId={runId} agents={overview.agents} current={current} orchestrator={orchestrator}
          canAct={canAct && live} sessions={sessions} />
        <div className="lg:col-span-2 2xl:col-span-1">
          <Inspector runId={runId} overview={overview} agent={shown} live={live} onOpen={sessions.open} />
        </div>
      </div>
      <RunPanels runId={runId} overview={overview} live={live} canAct={canAct} readAt={readAt} />
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
  const { data, dataUpdatedAt, error, isError, isLoading, refetch, isFetching, live } = useEngineeringOverview(runId)
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <BackToAgents />
      {isLoading && <div className="skeleton h-40" />}
      {isError && <NotRead error={error} retry={() => { void refetch() }} retrying={isFetching} />}
      {data !== undefined && (
        <Workspace runId={runId} agentInPath={read?.place.agent ?? null} overview={data} live={live} readAt={dataUpdatedAt} />
      )}
    </div>
  )
}
