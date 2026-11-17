/**
 * @fileoverview What the workspace reads in a run's or an agent's status (7.51.00): its chip's tone
 * (docs/kiro-design-system.md rule 15: colour carries meaning, never identity: at work in the accent, waiting or
 * paused, or waiting for a person, in warn, done in ok, failed in danger, and stopped, posted again or unknown in the
 * neutral tone; never `info`, a provenance tone), and whether an agent can still take a signal.
 *
 * @module pages/Agents/RunWorkspace/agentStatus
 */
import { FINAL_TASK_STATES } from '../../../api/engineeringRunsApi'
import type { EngineeringAgent, RunLane } from '../../../api/engineeringRunsApi'

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
