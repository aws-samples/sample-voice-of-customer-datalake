/**
 * @fileoverview What the workspace reads in a run's or an agent's status (7.51.00): its chip's tone
 * (docs/kiro-design-system.md rule 15: colour carries meaning, never identity: at work in the accent, waiting or
 * paused, or waiting for a person, in warn, done in ok, failed in danger, and stopped, posted again or unknown in the
 * neutral tone; never `info`, a provenance tone), and whether an agent can still take a signal; and (7.51.04) where
 * the run stands (under way, held for a person, or ended), its orchestrator, and the agent whose failure stopped it.
 *
 * @module pages/Agents/RunWorkspace/agentStatus
 */
import { COORDINATE_TASK, ENDED_RUN_STATUSES, FINAL_TASK_STATES } from '../../../api/engineeringRunsApi'
import type { EngineeringAgent, EngineeringOverview, RunLane } from '../../../api/engineeringRunsApi'

const TONES: Readonly<Record<string, string>> = {
  working: 'badge-accent', booting: 'badge-accent', active: 'badge-accent', running: 'badge-accent',
  waiting: 'badge-warn', paused: 'badge-warn', pause_requested: 'badge-warn', needs_human: 'badge-warn',
  done: 'badge-ok', completed: 'badge-ok',
  failed: 'badge-danger', crashed: 'badge-danger',
}

/** The chip's classes for a status (a session's, or a run's). */
export function statusChipClass(status: string): string {
  return `badge ${TONES[status] ?? 'badge-muted'}`
}

/** An agent's session statuses that are over. */
const ENDED_SESSIONS: ReadonlySet<string> = new Set(['done', 'failed', 'stopped'])

/** Whether the agent can take a signal: it has a task at an attempt, and neither its session nor its task is over. */
export function takesSignals(agent: EngineeringAgent, lanes: Readonly<Record<string, readonly RunLane[]>>): boolean {
  const task = Object.values(lanes).flat().find((lane) => lane.task_id === agent.task_id && lane.agent === agent.agent)
  return agent.task_id !== null && agent.attempt > 0 && !ENDED_SESSIONS.has(agent.status)
    && (task === undefined || !FINAL_TASK_STATES.includes(task.state))
}

/** Where a run stands (7.51.04): under way, held at a person's decision point, or ended (nothing moves). */
export type RunPhase = 'active' | 'halted' | 'ended'

export function runPhase(run: Pick<EngineeringOverview['run'], 'status' | 'ended_at'>): RunPhase {
  if (run.ended_at !== null || ENDED_RUN_STATUSES.includes(run.status)) return 'ended'
  return run.status === 'needs_human' ? 'halted' : 'active'
}

/** An agent's session statuses of a failure. */
const FAILED_SESSIONS: ReadonlySet<string> = new Set(['failed', 'crashed'])

export const hasFailed = (agent: Pick<EngineeringAgent, 'status'>): boolean => FAILED_SESSIONS.has(agent.status)

/**
 * The run's orchestrator: its coordinator, whose session the run's own address shows. A Resume that replaces a
 * failed one launches the next (`coordinator-2`), so the newest started is the one; none started yet, the first.
 */
export function orchestratorOf(agents: readonly EngineeringAgent[]): EngineeringAgent | null {
  const coordinators = agents.filter((agent) => agent.task_id === COORDINATE_TASK || agent.role === 'coordinator')
  return coordinators.reduce<EngineeringAgent | null>((newest, agent) => (
    newest === null || (agent.started_at ?? 0) > (newest.started_at ?? 0) ? agent : newest), null)
}

/**
 * The agent whose failure stopped the run: its orchestrator when that failed, else the first agent that failed with
 * a word on why (its last exit, or the supervisor's), else the first that failed; null for none.
 */
export function failedAgent(agents: readonly EngineeringAgent[]): EngineeringAgent | null {
  const orchestrator = orchestratorOf(agents)
  if (orchestrator !== null && hasFailed(orchestrator)) return orchestrator
  const failed = agents.filter(hasFailed)
  return failed.find((agent) => agent.last_exit !== null || agent.last_failure !== null) ?? failed.at(0) ?? null
}
