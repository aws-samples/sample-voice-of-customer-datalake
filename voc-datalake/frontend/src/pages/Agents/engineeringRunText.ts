/**
 * @fileoverview What the run monitor's parts share: an age in the reader's units, the text of a refused action, and
 * the steps the agents are on (the run graph's light).
 *
 * @module pages/Agents/engineeringRunText
 */
import { useTranslation } from 'react-i18next'
import { apiErrorStatus, messageKeyForStatus } from '../../api/apiErrorStatus'
import { serverReason } from '../../lib/errors'
import type { StepState } from '../../components/WorkflowEditor/runState'
import type { EngineeringAgent } from '../../api/engineeringRunsApi'

/** The largest whole unit of an age in seconds (never negative). */
function ageParts(seconds: number): [number, 'second' | 'minute' | 'hour' | 'day'] {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return [whole, 'second']
  if (whole < 3600) return [Math.floor(whole / 60), 'minute']
  if (whole < 86_400) return [Math.floor(whole / 3600), 'hour']
  return [Math.floor(whole / 86_400), 'day']
}

/** An age in seconds, in the reader's units ("45 sec", "12 min", "3 hr", "2 days"). */
export function useAge(): (seconds: number) => string {
  const { i18n } = useTranslation()
  return (seconds) => {
    const [value, unit] = ageParts(seconds)
    return new Intl.NumberFormat(i18n.language, { style: 'unit', unit, unitDisplay: 'short' }).format(value)
  }
}

/** The status messages a refused action shows when the server gives no reason of its own. */
const ACTION_ERRORS = [
  { status: 403, messageKey: 'agents:engineeringRun.errors.forbidden' },
  { status: 404, messageKey: 'agents:engineeringRun.errors.notFound' },
  { status: 409, messageKey: 'agents:engineeringRun.errors.movedOn' },
  { status: 503, messageKey: 'agents:engineeringRun.errors.unavailable' },
] as const
const ACTION_ERROR = { messageKey: 'agents:engineeringRun.errors.generic' } as const
/** The refusals whose own reason says more than the status: the supervisor's (a 409 "run R has spent its budget:
 * raise it before resuming", a 503 "The agent is busy with another move: send the signal again"). */
const SERVER_REASONS: ReadonlySet<number> = new Set([409, 503])

/**
 * What a refused action says: for a conflict, an unavailable supervisor, or a refusal the table does not name (a bad
 * request), the server's own reason when it gave one; else the status's message.
 */
export function useActionError(): (error: unknown) => string {
  const { t } = useTranslation()
  return (error) => {
    const key = messageKeyForStatus(error, ACTION_ERRORS, ACTION_ERROR)
    const ownReason = key === ACTION_ERROR.messageKey || SERVER_REASONS.has(apiErrorStatus(error) ?? 0)
    return (ownReason ? serverReason(error) : null) ?? t(key)
  }
}

/**
 * The groups present (a board's states, the reports' levels) in the page's own order, then any the server has that
 * the page does not know, by name: an unknown one is shown as it is named, never dropped.
 */
export function groupsInOrder(known: readonly string[], present: readonly string[]): string[] {
  const seen = new Set(present)
  const others = [...seen].filter((group) => !known.includes(group)).sort((a, b) => a.localeCompare(b))
  return [...known, ...others].filter((group) => seen.has(group))
}

/**
 * How the canvas lights a step of the conductor's (`lambda/engineering/flow/conductor.py`): its turn, under way or at a
 * person as running; done, or passed by a person, as done; blocked or stopped (a person decides) as failed; not run
 * yet, or on a way not taken, dimmed. A step still waiting is left as it is.
 */
const FLOW_LIGHT: Readonly<Record<string, StepState['status']>> = {
  ready: 'running', running: 'running', collecting: 'running', human: 'running',
  done: 'done', passed: 'done', blocked: 'failed', stopped: 'failed', not_yet_run: 'idle', skipped: 'idle',
}

/**
 * The run's steps lit. With the conductor's statuses (`flowSteps`, a run that follows its flow), each step as it is;
 * else the steps the agents are on, lit as running (an agent's `step` is the harness's own words: a step is lit only
 * when they are one of the flow's node ids, `nodeIds`). One round each: the canvas reads rounds as an agents
 * workflow's loop rounds ("Round 2"), which an engineering flow does not have; who is on a step is the Agents panel's
 * to say.
 */
export function liveSteps(agents: readonly EngineeringAgent[], nodeIds: ReadonlySet<string>,
  flowSteps: Readonly<Record<string, string>> | null = null): Map<string, StepState> {
  if (flowSteps !== null) {
    return new Map(Object.entries(flowSteps).flatMap(([step, status]) => {
      const light = FLOW_LIGHT[status]
      return nodeIds.has(step) && light !== undefined ? [[step, { status: light, rounds: 1 }] as const] : []
    }))
  }
  return new Map(agents.flatMap((agent) => (
    agent.step !== null && nodeIds.has(agent.step) ? [[agent.step, { status: 'running', rounds: 1 }] as const] : [])))
}
