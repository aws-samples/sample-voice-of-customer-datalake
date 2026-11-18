/**
 * @fileoverview The run's timeline (7.51.00), the canvas's other view: what has happened, as steps, then the agents
 * on each, then each agent's attempts, newest first. Steps come in the flow's order from its start; the agents on no
 * step of the flow (a person's own task) close the list. (7.51.04) The orchestrator is the run's own, on no step: it
 * heads the timeline in a row of its own, never "on no step of the flow".
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/workflows/runModel.ts` (`groupByPhase`, and `agentState`:
 * an agent with no end while the run is over was stopped, never still running) and `WorkflowRunTree.tsx` (the phase
 * status: a phase with a failure failed; a phase the run moved past is done unless the run ended with work in it,
 * which stopped; the current phase of an ended run takes the run's own outcome), Apache-2.0 (THIRD-PARTY-LICENSES.md).
 * Where the canvas lights a step (the conductor's status, and since 7.51.04 the run's own state: runFlow.ts), the step
 * reads as it does; a step under way with nobody at work on it reads as ready, which never spins.
 *
 * @module pages/Agents/RunWorkspace/runTimelineModel
 */
import { laneLabel, laneState, sessionState } from './runLanes'
import { stepLevels } from '../../../components/WorkflowEditor/nodes/nodeKinds'
import { orchestratorOf, runPhase } from './agentStatus'
import type { LaneState, StepState } from '../../../components/WorkflowEditor/runState'
import type { EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { RunPhase } from './agentStatus'

export type TimelineState = 'running' | 'ready' | 'ok' | 'failed' | 'waiting' | 'paused' | 'stopped' | 'skipped' | 'planned'

export interface TimelineAgent {
  /** The agent's id, else its task's (a lane nothing was launched for). */
  readonly key: string
  readonly agent: string | null
  readonly label: string
  readonly role: string
  readonly state: LaneState
  /** Its attempts, newest first; the first is the one it is on. */
  readonly attempts: readonly number[]
}

export interface TimelineStep {
  /** The step's id ('' for the agents on no step of the flow). */
  readonly step: string
  readonly title: string
  readonly state: TimelineState
  /** (7.51.04) Where the run is (`on`) or stopped (`stopped`), as the canvas marks it. */
  readonly here?: 'on' | 'stopped'
  readonly agents: readonly TimelineAgent[]
}

export interface Timeline {
  /** (7.51.04) The run's orchestrator, its own row at the top; null for none started. */
  readonly orchestrator: (TimelineAgent & { readonly status: string }) | null
  readonly steps: readonly TimelineStep[]
}

const attemptsOf = (attempt: number) => Array.from({ length: Math.max(1, attempt) }, (_, index) => Math.max(1, attempt) - index)

/** A step's state from its lanes when the canvas lights none (WorkflowRunTree's `phaseStatus`). */
function lanesState(agents: readonly TimelineAgent[], phase: RunPhase, passed: boolean): TimelineState {
  const has = (state: LaneState) => agents.some((agent) => agent.state === state)
  if (has('ran_failed')) return 'failed'
  if (has('waiting')) return 'waiting'
  if (agents.length === 0 || agents.every((agent) => agent.state === 'planned')) return 'planned'
  const open = has('running') || has('paused') || has('stopped')
  if (passed || phase === 'ended') return open ? 'stopped' : 'ok'
  if (has('running')) return 'running'
  return has('paused') ? 'paused' : 'ok'
}

const LIT: Readonly<Record<StepState['status'], TimelineState>> = {
  running: 'running', done: 'ok', failed: 'failed', idle: 'planned', waiting: 'waiting', paused: 'paused',
  stopped: 'stopped', skipped: 'skipped',
}

/** A lit step as the timeline reads it: a running one nobody is at work on is ready (no spinner). */
const litState = (light: StepState): TimelineState => (light.status === 'running' && light.spin === false ? 'ready' : LIT[light.status])

/** An agent on no lane, from its session. */
const sessionAgent = (agent: EngineeringAgent, phase: RunPhase): TimelineAgent => ({
  key: agent.agent, agent: agent.agent, label: agent.agent, role: agent.role, state: sessionState(agent.status, phase),
  attempts: attemptsOf(agent.attempt),
})

/** The timeline of a run: `lit` the canvas's steps as runFlow.ts lights them (none: from the lanes alone). */
export function buildTimeline(overview: EngineeringOverview, lit: ReadonlyMap<string, StepState>): Timeline {
  const { run, lanes } = overview
  const phase = runPhase(run)
  const definition = run.flow_definition
  const levels = definition === null ? new Map<string, number>() : stepLevels(definition)
  const titles = new Map(definition?.nodes.map((node) => [node.id, node.data.title]) ?? [])
  const order = [...new Set([...[...levels.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ...Object.keys(lanes)])]
  const orchestrator = orchestratorOf(overview.agents)
  const placed = new Set<string>(orchestrator === null ? [] : [orchestrator.agent])
  const steps = order.map((step, index): TimelineStep => {
    const agents = (lanes[step] ?? []).map((lane): TimelineAgent => {
      if (lane.agent !== null) placed.add(lane.agent)
      return {
        key: lane.agent ?? lane.task_id, agent: lane.agent, label: laneLabel(lane), role: lane.role,
        state: laneState(lane, phase), attempts: attemptsOf(lane.attempt),
      }
    })
    const passed = order.slice(index + 1).some((later) => (lanes[later]?.length ?? 0) > 0)
    const light = lit.get(step)
    const state = light === undefined ? lanesState(agents, phase, passed) : litState(light)
    return { step, title: titles.get(step) ?? step, agents, state, ...(light?.here === undefined ? {} : { here: light.here }) }
  }).filter((step) => step.agents.length > 0 || step.state !== 'planned')
  const others = overview.agents.filter((agent) => !placed.has(agent.agent)).map((agent) => sessionAgent(agent, phase))
  const offFlow = others.length === 0 ? [] : [{ step: '', title: '', state: lanesState(others, phase, false), agents: others }]
  return {
    orchestrator: orchestrator === null ? null : { ...sessionAgent(orchestrator, phase), status: orchestrator.status },
    steps: [...steps, ...offFlow],
  }
}
