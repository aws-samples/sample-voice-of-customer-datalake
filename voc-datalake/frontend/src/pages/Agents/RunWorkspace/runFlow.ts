/**
 * @fileoverview What the run's canvas and its timeline share (7.51.00): the flow the run follows, and its steps lit
 * as the conductor reads them, each gate step with its verdict and the step the run is on marked ("you are here").
 *
 * (7.51.04) And lit from the run's real state, so a run that stopped says so: once it ended or waits for a person,
 * the step where it stopped is marked "Stopped here" and reads as failed (an agent failed, or its checkout did), as
 * waiting for a person, or as stopped, with no spinner; any other step still under way reads as held (a run at a
 * person) or stopped (an ended one). A step spins only while the run is under way and an agent is at work on it.
 *
 * @module pages/Agents/RunWorkspace/runFlow
 */
import { useQuery } from '@tanstack/react-query'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { focusStepId } from '../../../components/WorkflowEditor/canvasFocus'
import { liveSteps } from '../engineeringRunText'
import { gateOutcome, laneState } from './runLanes'
import { failedAgent, runPhase } from './agentStatus'
import type { StepState } from '../../../components/WorkflowEditor/runState'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { RunPhase } from './agentStatus'

/**
 * The run's flow definition: its own copy, as its start wrote it (the one it follows, whatever the flow became
 * since), from the overview; for a run started without one, the flow's current revision.
 */
export function useRunFlow(run: EngineeringOverview['run']) {
  const copied = run.flow_definition
  const current = useQuery({
    queryKey: workflowsKeys.detail(run.flow), queryFn: () => workflowsApi.get(run.flow),
    enabled: run.flow !== '' && copied === null,
  })
  if (copied !== null) return { definition: copied, isError: false, isLoading: false }
  return { definition: current.data?.workflow.definition ?? null, isError: current.isError, isLoading: current.isLoading }
}

/** The decision point a run at a person waits at for one of its flow's steps (`flow:<step>`). */
const FLOW_POINT = 'flow:'

/** The step of the flow a run at a person waits at (`flow:<step>`), else null. */
export const flowPointStep = (waitingAt: string): string | null =>
  (waitingAt.startsWith(FLOW_POINT) ? waitingAt.slice(FLOW_POINT.length) : null)
/** The decision point of a checkout that failed (7.51.03): a failure, whoever was on it. */
export const CHECKOUT_FAILED = 'checkout_failed'

/** The state the step where the run stopped reads as: a failure (a failed run, an agent that failed, a checkout that
 * failed, or a step that failed already) before waiting for a person, before stopped. */
function stoppedAs(overview: EngineeringOverview, state: StepState | undefined): StepState['status'] {
  const { status, waiting_at: waitingAt } = overview.run
  if (status === 'failed' || state?.status === 'failed' || waitingAt === CHECKOUT_FAILED) return 'failed'
  if (status === 'needs_human') return failedAgent(overview.agents) === null ? 'waiting' : 'failed'
  return 'stopped'
}

/** Where a run that stopped stopped: the step it waits at, else the failed agent's step, else the canvas's focus. */
function stoppedStep(overview: EngineeringOverview, ids: ReadonlySet<string>, lit: ReadonlyMap<string, StepState>) {
  const point = flowPointStep(overview.run.waiting_at)
  if (point !== null && ids.has(point)) return point
  const failed = failedAgent(overview.agents)
  if (failed === null) return focusStepId(lit)
  const lane = Object.entries(overview.lanes).find(([step, lanes]) => ids.has(step) && lanes.some((entry) => entry.agent === failed.agent))
  return lane?.[0] ?? focusStepId(lit)
}

/** Whether an agent is at work on a step's lanes now. */
const atWork = (overview: EngineeringOverview, step: string, phase: RunPhase) =>
  (overview.lanes[step] ?? []).some((lane) => laneState(lane, phase) === 'running')

/** A step still under way in a run that stopped: held while the run waits for a person, stopped once it ended. */
const HALTED_AS: Readonly<Record<Exclude<RunPhase, 'active'>, StepState['status']>> = { halted: 'paused', ended: 'stopped' }

/** A run under way: a running step spins only while an agent is at work on it, and the one it is on is marked. */
function markUnderWay(overview: EngineeringOverview, lit: Map<string, StepState>): Map<string, StepState> {
  for (const [step, state] of lit) if (state.status === 'running') lit.set(step, { ...state, spin: atWork(overview, step, 'active') })
  const here = focusStepId(lit)
  const state = here === undefined ? undefined : lit.get(here)
  if (here !== undefined && state !== undefined) lit.set(here, { ...state, here: 'on' })
  return lit
}

/** A run that stopped: its steps under way held or stopped, and where it stopped marked (a finished run: nowhere). */
function markStopped(overview: EngineeringOverview, ids: ReadonlySet<string>, lit: Map<string, StepState>,
  phase: Exclude<RunPhase, 'active'>): Map<string, StepState> {
  const here = overview.run.status === 'done' ? undefined : stoppedStep(overview, ids, lit)
  const state = here === undefined ? undefined : lit.get(here)
  for (const [step, each] of lit) if (each.status === 'running') lit.set(step, { ...each, status: HALTED_AS[phase], spin: false })
  if (here !== undefined) lit.set(here, { ...(state ?? { rounds: 1 }), status: stoppedAs(overview, state), here: 'stopped', spin: false })
  return lit
}

/** The steps lit, each gate step with its verdict, the one the run is on marked, or the one where it stopped. */
export function runStepStates(overview: EngineeringOverview, definition: WorkflowDefinition): Map<string, StepState> {
  const ids = new Set(definition.nodes.map((node) => node.id))
  const lit = liveSteps(overview.agents, ids, overview.run.flow_steps)
  for (const [step, verdict] of Object.entries(overview.gates)) {
    const gate = gateOutcome(verdict)
    if (gate !== null && ids.has(step)) lit.set(step, { ...(lit.get(step) ?? { status: 'done', rounds: 1 }), gate })
  }
  const phase = runPhase(overview.run)
  return phase === 'active' ? markUnderWay(overview, lit) : markStopped(overview, ids, lit, phase)
}
