/**
 * @fileoverview What the run workspace's banner says of a run that stopped (7.51.04): a run waiting for a person,
 * failed or stopped. What happened in plain words (by the decision point it waits at, the agent that failed, or how
 * it was stopped), which agent, why (the plain reason its supervisor stored, 7.51.03's `waiting_detail`; else the
 * flow's own at a step's decision; else the agent's last word from the supervisor, `last_failure`; with its last
 * failed command, `last_exit`, behind "Show details"), and what to do next with the run's own controls (Resume or
 * Stop where the deployment reaches them, Restart run once it ended). Its tone by meaning (docs/kiro-design-system.md):
 * danger when something failed, warn when it waits for a person's decision, muted when a person stopped it.
 *
 * @module pages/Agents/RunWorkspace/runEnd
 */
import { CHECKOUT_FAILED, flowPointStep } from './runFlow'
import { failedAgent, orchestratorOf } from './agentStatus'
import type { AgentLastExit, EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'

export type RunEndTone = 'danger' | 'warn' | 'muted'

export interface RunEnd {
  readonly status: 'needs_human' | 'failed' | 'stopped'
  readonly tone: RunEndTone
  /** What happened: a key of `runWorkspace.end.what`. */
  readonly what: string
  /** The agent that failed (null: none did), and whether it is the run's orchestrator. */
  readonly agent: EngineeringAgent | null
  readonly orchestrator: boolean
  /** Why, in plain words; null when nothing says. */
  readonly reason: string | null
  readonly exit: AgentLastExit | null
  /** What to do next: a key of `runWorkspace.end.next`. */
  readonly next: string
}

const STOPPED: ReadonlySet<string> = new Set(['needs_human', 'failed', 'stopped'])
const isStopped = (status: string): status is RunEnd['status'] => STOPPED.has(status)
/** The decision points a run waits at, and what each says happened (runtime/supervisor.py, runtime/handler.py). */
const POINTS: Readonly<Record<string, string>> = {
  budget: 'budget', thirty_days: 'thirtyDays', checkout_cache: 'checkoutCache', coordinator: 'orchestratorNotStarted',
}

/** What happened to a run at a person: a checkout that failed, an agent that failed, else its decision point. */
function waitingWhat(waitingAt: string, agent: EngineeringAgent | null, orchestrator: boolean): string {
  if (waitingAt === CHECKOUT_FAILED) return 'checkoutFailed'
  if (agent !== null) return orchestrator ? 'orchestratorFailed' : 'agentFailed'
  if (flowPointStep(waitingAt) !== null) return 'flowStep'
  return POINTS[waitingAt] ?? 'waiting'
}

function whatHappened(overview: EngineeringOverview, agent: EngineeringAgent | null, orchestrator: boolean): string {
  const { status, waiting_at: waitingAt, stop } = overview.run
  if (status === 'stopped') return stop?.mode === 'stop_now' ? 'stoppedNow' : 'stopped'
  if (status === 'failed') {
    if (agent === null) return 'runFailed'
    return orchestrator ? 'runFailedOrchestrator' : 'runFailedAgent'
  }
  return waitingWhat(waitingAt, agent, orchestrator)
}

/** What to do next with the run's own controls: Restart run once it ended; at a person, Resume where the run's signals
 * reach it (7.51.02 `signals_available`: the start function; after raising the budget at a spent one; never past 30
 * days), else Stop and Restart run. */
function nextStep(overview: EngineeringOverview): string {
  const { status, waiting_at: waitingAt } = overview.run
  if (status !== 'needs_human') return 'restart'
  if (overview.signals_available && waitingAt !== 'thirty_days') return waitingAt === 'budget' ? 'resumeBudget' : 'resume'
  return overview.stop_available ? 'stopThenRestart' : 'nothing'
}

/** The reason in plain words: the supervisor's stored one, the flow's at its step's decision, the agent's last. */
function reasonOf(overview: EngineeringOverview, agent: EngineeringAgent | null): string | null {
  const { waiting_detail: detail, waiting_at: waitingAt, flow_outcome: outcome } = overview.run
  const flowReason = flowPointStep(waitingAt) === null ? null : outcome?.reason ?? null
  return [detail, flowReason, agent?.last_failure ?? null].find((reason) => reason !== null && reason.trim() !== '') ?? null
}

/** Danger when something failed, warn when the run waits for a person's decision, muted when a person stopped it. */
function toneOf(status: RunEnd['status'], failed: boolean): RunEndTone {
  if (status === 'stopped') return 'muted'
  return failed ? 'danger' : 'warn'
}

/** The banner of a run that stopped (waits for a person, failed or was stopped); null for one under way or done. */
export function runEnd(overview: EngineeringOverview): RunEnd | null {
  const { status, waiting_at: waitingAt } = overview.run
  if (!isStopped(status)) return null
  const agent = status === 'stopped' ? null : failedAgent(overview.agents)
  const orchestrator = agent !== null && agent.agent === orchestratorOf(overview.agents)?.agent
  const failed = status === 'failed' || agent !== null || waitingAt === CHECKOUT_FAILED
  return {
    status,
    tone: toneOf(status, failed),
    what: whatHappened(overview, agent, orchestrator),
    agent, orchestrator,
    reason: reasonOf(overview, agent),
    exit: agent?.last_exit ?? null,
    next: nextStep(overview),
  }
}
