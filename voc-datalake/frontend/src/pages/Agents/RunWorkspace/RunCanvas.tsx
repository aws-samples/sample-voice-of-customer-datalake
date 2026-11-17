/**
 * @fileoverview The run's canvas (7.51.00), on the workflow editor's read-only @xyflow canvas: the run's own copy of
 * its flow (as its start wrote it; for a run without one, the flow's current revision), each step a stage lit as the
 * conductor reads it, a gate step's pass or fail from the board's verdict, "you are here" on the step the run is on
 * (canvasFocus.ts `focusStepId`), and each step's agents as sibling lanes under it (runLanes.ts): a spinner on one at
 * work, dashed while planned, solid once it ran, the one open filled. (7.51.04) Lit from the run's real state
 * (runFlow.ts): once it ended or waits for a person, "Stopped here" on the step where it stopped, in the state it
 * stopped in, and no spinner anywhere; the orchestrator is the run itself, above the canvas (FlowPane.tsx).
 *
 * INERT, like KiroCrew's run graph: a click selects (a lane opens its agent's session; a step, its first agent's), it
 * never acts. Nothing on the canvas signals, restarts or spends.
 *
 * @module pages/Agents/RunWorkspace/RunCanvas
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkflowCanvas } from '../../../components/WorkflowEditor/WorkflowCanvas'
import { LANE_HEIGHT, LANE_WIDTH, layoutRun } from './runLanes'
import { runStepStates } from './runFlow'
import { runPhase } from './agentStatus'
import type { LaneFlowNode } from '../../../components/WorkflowEditor/CanvasNodes'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

interface Props {
  overview: EngineeringOverview
  definition: WorkflowDefinition
  /** The agent whose session is open. */
  current: string | null
  onOpen: (agent: string) => void
}

export function RunCanvas({ overview, definition, current, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const phase = runPhase(overview.run)
  const layout = useMemo(() => layoutRun(definition, overview.lanes, phase), [definition, overview.lanes, phase])
  const states = useMemo(() => runStepStates(overview, definition), [overview, definition])
  const lanes = useMemo((): LaneFlowNode[] => layout.lanes.map((lane) => ({
    id: lane.id, type: 'lane', position: lane.position,
    data: { label: lane.label, role: lane.role, state: lane.state, attempt: lane.attempt, open: lane.agent !== null && lane.agent === current,
      width: LANE_WIDTH, height: LANE_HEIGHT },
    ariaLabel: t('runWorkspace.canvas.lane', { label: lane.label, state: t(`run.laneStates.${lane.state}`) }),
    draggable: false, connectable: false, deletable: false, selectable: true, focusable: true,
  })), [layout.lanes, current, t])
  const select = (id: string) => {
    const lane = layout.lanes.find((candidate) => candidate.id === id) ?? layout.lanes.find((candidate) => candidate.step === id && candidate.agent !== null)
    if (lane?.agent !== undefined && lane.agent !== null) onOpen(lane.agent)
  }
  return <WorkflowCanvas definition={layout.definition} readOnly runStates={states} lanes={lanes} onStepClick={select} />
}
