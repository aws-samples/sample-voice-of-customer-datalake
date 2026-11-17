/**
 * @fileoverview What the run's canvas and its timeline share (7.51.00): the flow the run follows, and its steps lit
 * as the conductor reads them, each gate step with its verdict and the step the run is on marked ("you are here").
 *
 * @module pages/Agents/RunWorkspace/runFlow
 */
import { useQuery } from '@tanstack/react-query'
import { workflowsApi, workflowsKeys } from '../../../api/workflowsApi'
import { focusStepId } from '../../../components/WorkflowEditor/canvasFocus'
import { liveSteps } from '../engineeringRunText'
import { gateOutcome } from './runLanes'
import type { StepState } from '../../../components/WorkflowEditor/runState'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

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

/** The steps lit, each gate step with its verdict, and the one the run is on marked. */
export function runStepStates(overview: EngineeringOverview, definition: WorkflowDefinition): Map<string, StepState> {
  const ids = new Set(definition.nodes.map((node) => node.id))
  const lit = liveSteps(overview.agents, ids, overview.run.flow_steps)
  for (const [step, verdict] of Object.entries(overview.gates)) {
    const gate = gateOutcome(verdict)
    if (gate !== null && ids.has(step)) lit.set(step, { ...(lit.get(step) ?? { status: 'done', rounds: 1 }), gate })
  }
  const here = focusStepId(lit)
  const state = here === undefined ? undefined : lit.get(here)
  if (here !== undefined && state !== undefined) lit.set(here, { ...state, here: true })
  return lit
}
