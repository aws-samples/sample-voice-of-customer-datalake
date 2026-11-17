/**
 * @fileoverview The run's canvas (7.51.00), on the one flow canvas in its `run` mode (7.52.00 C2,
 * components/WorkflowEditor/FlowCanvas.tsx): the run's own copy of its flow (as its start wrote it; for a run without
 * one, the flow's current revision), each step a stage in its kind's shape, lit as the conductor reads it (the
 * outline and the corner badge), a gate's GO or NO-GO from the board's verdict, "you are here" on the step the run is
 * on (canvasFocus.ts `focusStepId`), each step's agents as sibling lanes under it (runLanes.ts), and (7.52.00) a call's
 * `<call>.<child>` steps framed under the call they came from (`run.expansion`, callGroups.ts) with how many are done.
 * An agent step's chips are what ran: its model, its skill's label, its cost, how many agents.
 *
 * INERT, like KiroCrew's run graph: a selection never acts. A step opens its Step view in the inspector (owner
 * decision N-D3: Agents, Setup, Checks); a lane opens its agent's session. Opening follows the selection, so Enter
 * works as a click does (N14). Nothing on the canvas signals, restarts or spends.
 *
 * @module pages/Agents/RunWorkspace/RunCanvas
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FlowCanvas } from '../../../components/WorkflowEditor/FlowCanvas'
import { callGroups } from '../../../components/WorkflowEditor/callGroups'
import { useFlowLibrary } from '../../../components/WorkflowEditor/inspector/useFlowSetup'
import { LANE_HEIGHT, LANE_WIDTH, layoutRun } from './runLanes'
import { ranOnSteps, runStepStates } from './runFlow'
import { runPhase } from './agentStatus'
import type { FlowRunState, FlowSelection } from '../../../components/WorkflowEditor/FlowCanvas'
import type { LaneFlowNode } from '../../../components/WorkflowEditor/nodes/nodeData'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { CanvasSelection } from '../../../components/WorkflowEditor/selection'

interface Props {
  overview: EngineeringOverview
  definition: WorkflowDefinition
  /** The agent whose session is open. */
  current: string | null
  onOpen: (agent: string) => void
  /** The step whose Step view the inspector shows (null: none). */
  step?: string | null
  onSelectStep?: (step: string | null) => void
}

/** The canvas selection that shows `step` selected (none: nothing). */
const selectionOf = (step: string | null | undefined): CanvasSelection =>
  ({ nodeIds: step === null || step === undefined ? [] : [step], edgeIds: [], loopIndexes: [] })

export function RunCanvas({ overview, definition, current, onOpen, step, onSelectStep }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const phase = runPhase(overview.run)
  const layout = useMemo(() => layoutRun(definition, overview.lanes, phase), [definition, overview.lanes, phase])
  const library = useFlowLibrary(overview.run.expansion.length > 0)
  const runState = useMemo((): FlowRunState => {
    const lit = runStepStates(overview, definition)
    const ran = ranOnSteps(overview)
    for (const [id, what] of ran) {
      const state = lit.get(id)
      if (state !== undefined) lit.set(id, { ...state, ran: what })
    }
    const names = new Map((library.data ?? []).map((flow) => [flow.workflow_id, flow.name]))
    const calls = callGroups(layout.definition, overview.run.expansion, lit).map((group) => ({
      call: group.call,
      label: t('canvas.call.line', { name: names.get(group.flow) ?? group.flow, revision: group.revision }),
      progress: t('canvas.call.progress', { done: group.done, total: group.total }),
      nodeIds: group.nodeIds,
    }))
    const lanes = layout.lanes.map((lane): LaneFlowNode => ({
      id: lane.id, type: 'lane', position: lane.position,
      data: {
        label: lane.label, role: lane.role, state: lane.state, attempt: lane.attempt,
        open: lane.agent !== null && lane.agent === current, width: LANE_WIDTH, height: LANE_HEIGHT,
      },
      ariaLabel: t('runWorkspace.canvas.lane', { label: lane.label, state: t(`run.laneStates.${lane.state}`) }),
      draggable: false, connectable: false, deletable: false, selectable: true, focusable: true,
    }))
    return { steps: lit, lanes, calls }
  }, [overview, definition, layout, library.data, current, t])
  const selection = useMemo(() => selectionOf(step), [step])
  const select = (picked: FlowSelection) => {
    if (picked?.kind === 'lane') {
      const lane = layout.lanes.find((candidate) => candidate.id === picked.id)
      if (lane !== undefined && lane.agent !== null) onOpen(lane.agent)
      return
    }
    if (picked?.kind === 'step') onSelectStep?.(picked.id)
    else if (picked === null) onSelectStep?.(null)
  }
  return <FlowCanvas definition={layout.definition} mode="run" runState={runState} selection={selection} onSelect={select} />
}
