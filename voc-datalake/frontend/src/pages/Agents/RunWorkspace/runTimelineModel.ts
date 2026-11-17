/**
 * @fileoverview The run's timeline (7.51.00), the canvas's other view: what has happened, as steps, then the agents
 * on each, then each agent's attempts, newest first. Steps come in the flow's order from its start; the agents on no
 * step of the flow (the orchestrator, a person's own task) close the list.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/workflows/runModel.ts` (`groupByPhase`, and `agentState`:
 * an agent with no end while the run is over was stopped, never still running) and `WorkflowRunTree.tsx` (the phase
 * status: a phase with a failure failed; a phase the run moved past is done unless the run ended with work in it,
 * which stopped; the current phase of an ended run takes the run's own outcome), Apache-2.0 (THIRD-PARTY-LICENSES.md).
 * Where the conductor says a step's status (`flow_steps`), the step reads as it says.
 *
 * @module pages/Agents/RunWorkspace/runTimelineModel
 */
import { laneLabel, laneState, levelsOf } from './runLanes'
import type { LaneState, StepState } from '../../../components/WorkflowEditor/runState'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

export type TimelineState = 'running' | 'ok' | 'failed' | 'stopped' | 'planned'

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
  readonly agents: readonly TimelineAgent[]
}

const attemptsOf = (attempt: number) => Array.from({ length: Math.max(1, attempt) }, (_, index) => Math.max(1, attempt) - index)

/** A step's state from its lanes when the conductor says none (WorkflowRunTree's `phaseStatus`). */
function lanesState(agents: readonly TimelineAgent[], ended: boolean, passed: boolean): TimelineState {
  if (agents.some((agent) => agent.state === 'ran_failed')) return 'failed'
  if (agents.length === 0 || agents.every((agent) => agent.state === 'planned')) return 'planned'
  const open = agents.some((agent) => agent.state === 'running' || agent.state === 'stopped')
  if (passed || ended) return open ? 'stopped' : 'ok'
  return open ? 'running' : 'ok'
}

/** A session's status (the supervisor's) read as its task's board state, for an agent on no lane. */
const SESSION_STATES: Readonly<Record<string, string>> = { done: 'done', crashed: 'failed', failed: 'failed' }

const LIT: Readonly<Record<StepState['status'], TimelineState>> = { running: 'running', done: 'ok', failed: 'failed', idle: 'planned' }

/** The timeline of a run: `lit` the canvas's steps as the conductor reads them (none: from the lanes alone). */
export function buildTimeline(overview: EngineeringOverview, lit: ReadonlyMap<string, StepState>): TimelineStep[] {
  const { run, lanes } = overview
  const ended = run.ended_at !== null
  const definition = run.flow_definition
  const levels = definition === null ? new Map<string, number>() : levelsOf(definition)
  const titles = new Map(definition?.nodes.map((node) => [node.id, node.data.title]) ?? [])
  const order = [...new Set([...[...levels.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id), ...Object.keys(lanes)])]
  const placed = new Set<string>()
  const steps = order.map((step, index): TimelineStep => {
    const agents = (lanes[step] ?? []).map((lane): TimelineAgent => {
      if (lane.agent !== null) placed.add(lane.agent)
      return {
        key: lane.agent ?? lane.task_id, agent: lane.agent, label: laneLabel(lane), role: lane.role,
        state: laneState(lane, ended), attempts: attemptsOf(lane.attempt),
      }
    })
    const passed = order.slice(index + 1).some((later) => (lanes[later]?.length ?? 0) > 0)
    const light = lit.get(step)
    return { step, title: titles.get(step) ?? step, agents, state: light === undefined ? lanesState(agents, ended, passed) : LIT[light.status] }
  }).filter((step) => step.agents.length > 0 || step.state !== 'planned')
  const others = overview.agents.filter((agent) => !placed.has(agent.agent)).map((agent): TimelineAgent => ({
    key: agent.agent, agent: agent.agent, label: agent.agent, role: agent.role,
    state: laneState({ state: SESSION_STATES[agent.status] ?? 'in_progress', agent: agent.agent }, ended),
    attempts: attemptsOf(agent.attempt),
  }))
  return others.length === 0 ? steps : [...steps, { step: '', title: '', state: lanesState(others, ended, false), agents: others }]
}
