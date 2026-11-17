/**
 * @fileoverview A step's view in the run workspace's inspector (7.52.00 C2; docs/ux part 5 §5.4, owner decision N-D3):
 * a step clicked (or Enter) on the run's canvas opens its setup as this run used it, through the one inspector
 * (FlowInspector, `run` mode): an agent's **Agents** (its lanes: each agent, its state, what it cost, Open session),
 * **Setup** (In this flow as text, and the card at the version that ran: the overview's `card`, `card_version`) and
 * **Assertions** (what the board recorded of this step's); a gate's **Checks** (its gate runner's gate: the round,
 * why it stopped, the final go and each check by pack, failures first, the reviewers' findings), **Reviewers** and
 * **Setup**. A lane still opens its agent's session.
 *
 * @module pages/Agents/RunWorkspace/RunStepView
 */
import { useMemo } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { FlowInspector } from '../../../components/WorkflowEditor/FlowInspector'
import { useDollars } from './useDollars'
import { GateTab } from './GateTab'
import { laneLabel, laneState } from './runLanes'
import { runPhase } from './agentStatus'
import { runStepStates, useRunFlow } from './runFlow'
import { useAgentGate, useRunAssertions } from './useRunWorkspace'
import type { ReactNode } from 'react'
import type { EngineeringAgent, EngineeringOverview, RunLane } from '../../../api/engineeringRunsApi'
import type { LaneState } from '../../../components/WorkflowEditor/runState'
import type { InspectorRun } from '../../../components/WorkflowEditor/inspector/inspectorParts'

/** The roles that run a gate's checks and its final go: a gate step's lanes. */
const GATE_RUNNER = 'gate-runner'

const LANE_TONE: Readonly<Record<string, string>> = {
  ran_ok: 'badge badge-ok', ran_failed: 'badge badge-danger', running: 'badge badge-accent', waiting: 'badge badge-warn',
  paused: 'badge badge-warn', stopped: 'badge badge-muted', planned: 'badge badge-muted',
}

/** One lane of a step: its agent, its state, what it cost and what ran, and Open session. */
function LaneRow({ lane, agent, state, onOpen }: Readonly<{
  lane: RunLane; agent: EngineeringAgent | undefined; state: LaneState; onOpen: (agent: string) => void
}>) {
  const { t } = useTranslation('agents')
  const dollars = useDollars()
  const cost = agent?.cost_usd ?? null
  const skill = agent?.skill_label ?? null
  const opened = lane.agent
  return (
    <li className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="min-w-0 flex-1 truncate font-medium text-text-strong">{laneLabel(lane)}</span>
      <span className={LANE_TONE[state] ?? 'badge badge-muted'}>{t(`run.laneStates.${state}`)}</span>
      {cost !== null && <span className="text-[12px] text-muted">{dollars(cost)}</span>}
      {skill !== null && <span className="w-full text-[12px] text-muted">{t('inspector.run.ran', { skill, model: agent?.model ?? '' })}</span>}
      {opened !== null && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(opened)}>{t('runWorkspace.flow.openSession')}</button>
      )}
    </li>
  )
}

/** A step's agents: its lanes, each with its state, its cost and Open session. */
function StepAgents({ overview, step, onOpen }: Readonly<{ overview: EngineeringOverview; step: string; onOpen: (agent: string) => void }>) {
  const { t } = useTranslation('agents')
  const phase = runPhase(overview.run)
  const lanes = overview.lanes[step] ?? []
  if (lanes.length === 0) return <p className="text-sm text-muted">{t('inspector.empty.notRun')}</p>
  const agents = new Map(overview.agents.map((agent) => [agent.agent, agent]))
  return (
    <ul className="space-y-1.5" aria-label={t('inspector.run.agents')}>
      {lanes.map((lane) => (
        <LaneRow key={lane.task_id} lane={lane} agent={lane.agent === null ? undefined : agents.get(lane.agent)}
          state={laneState(lane, phase)} onOpen={onOpen} />
      ))}
    </ul>
  )
}

/** The gate's own read beside its checks (gap K): its round, why it stopped, the final go, the tools' versions. */
function GateSummary({ runId, agent, live }: Readonly<{ runId: string; agent: string; live: boolean }>) {
  const { t } = useTranslation('agents')
  const gate = useAgentGate(runId, agent, live)
  const read = gate.data
  if (read === undefined) return null
  const tools = Object.entries(read.tool_versions).map(([tool, version]) => `${tool} ${version}`).join(', ')
  const stop = read.stop
  return (
    <div className="space-y-1 text-[13px]">
      {read.round !== null && <p className="text-text">{t('inspector.run.round', { n: read.round })}</p>}
      {stop?.code !== null && stop?.code !== undefined && (
        <p className="text-text">{t(`inspector.gate.stops.${stop.code}`, { defaultValue: stop.recorded ?? stop.code })}</p>
      )}
      {read.final_go !== null && (
        <p className={clsx('text-text', read.final_go.verdict === 'NO-GO' && 'text-danger')}>
          {t('inspector.run.finalGo', { verdict: read.final_go.verdict, reasons: read.final_go.reasons.join('; ') })}
        </p>
      )}
      {tools !== '' && <p className="text-[12px] text-muted">{t('inspector.gate.ownPinsRecorded', { list: tools })}</p>}
    </div>
  )
}

/** A gate step's checks: its gate runner's gate (GateTab), with the gate's own read above them. */
function StepChecks({ runId, overview, step, live, onOpen }: Readonly<{
  runId: string; overview: EngineeringOverview; step: string; live: boolean; onOpen: (agent: string) => void
}>) {
  const { t } = useTranslation('agents')
  const lanes = overview.lanes[step] ?? []
  const runner = lanes.find((lane) => lane.role === GATE_RUNNER && lane.agent !== null)?.agent ?? lanes.find((lane) => lane.agent !== null)?.agent ?? null
  if (runner === null) return <p className="text-sm text-muted">{t('inspector.empty.gateNotRun')}</p>
  const gateAgents = lanes.flatMap((lane) => (lane.agent === null ? [] : [lane.agent]))
  return (
    <div className="space-y-2">
      <GateSummary runId={runId} agent={runner} live={live} />
      <GateTab runId={runId} agent={runner} live={live} gateAgents={gateAgents} onOpen={onOpen} />
    </div>
  )
}

export function RunStepView({ runId, overview, step, live, onOpen, onClose }: Readonly<{
  runId: string; overview: EngineeringOverview; step: string; live: boolean
  /** Open an agent's session (a lane's, from the Agents tab). */
  onOpen: (agent: string) => void
  onClose: () => void
}>) {
  const { definition } = useRunFlow(overview.run)
  const assertions = useRunAssertions(runId, live)
  const run = useMemo((): InspectorRun | null => {
    if (definition === null) return null
    const agents = new Map(overview.agents.map((agent) => [agent.agent, agent]))
    const ranOn = (id: string) => (overview.lanes[id] ?? []).flatMap((lane) => {
      const agent = lane.agent === null ? undefined : agents.get(lane.agent)
      return agent === undefined ? [] : [agent]
    })
    return {
      revision: overview.run.flow_revision,
      states: runStepStates(overview, definition),
      assertions: assertions.data,
      agentsOf: (id): ReactNode => <StepAgents overview={overview} step={id} onOpen={onOpen} />,
      checksOf: (id): ReactNode => <StepChecks runId={runId} overview={overview} step={id} live={live} onOpen={onOpen} />,
      cardOf: (id) => {
        const card = ranOn(id).find((agent) => agent.card !== null)
        return card?.card === undefined || card.card === null ? null : { card: card.card, version: card.card_version }
      },
      pullRequest: overview.run.pull_request,
    }
  }, [definition, overview, assertions.data, onOpen, runId, live])
  if (definition === null || run === null) return null
  return <FlowInspector definition={definition} mode="run" selection={{ kind: 'step', id: step }} onClose={onClose} run={run} />
}
