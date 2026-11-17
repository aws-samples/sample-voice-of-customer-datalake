/**
 * @fileoverview The run canvas's model (7.51.00): the run's own copy of its flow, each step a STAGE, and the agents
 * of a step its LANES, sibling nodes with no edges between them (a stage's tasks may run at once), placed from each
 * task's `flow_step` (the overview's `lanes`). Edges run between stages only, as the flow draws them.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/workflows/planModel.ts` (`buildGraph`'s stage and sibling
 * model, run status apart from what was planned, `agentState`) and `WorkflowRunGraph.tsx` (`nodeTitle`, the bounded
 * titles; its `chipClass`, the state-to-border mapping, is components/WorkflowEditor/runState.ts `laneBorder`),
 * Apache-2.0 (THIRD-PARTY-LICENSES.md); redrawn on xyflow rather than as a list.
 *
 * The layout is the run's own: stages by their distance from the start (breadth first along the flow's edges), side
 * by side within a row, each as wide as its lanes, so lanes never cover the next step (a run's copy keeps no layout
 * of its own worth trusting).
 *
 * @module pages/Agents/RunWorkspace/runLanes
 */
import { STEP_HEIGHT, STEP_WIDTH } from '../../../components/WorkflowEditor/model'
import type { LaneState } from '../../../components/WorkflowEditor/runState'
import type { WorkflowDefinition } from '../../../api/workflowsApi'
import type { RunLane } from '../../../api/engineeringRunsApi'

export const LANE_WIDTH = 168
export const LANE_HEIGHT = 44
const LANE_GAP = 12
const STAGE_GAP = 48
const ROW_GAP = 64
const LANE_DROP = 20
/** The longest lane label shown (planModel's MAX_LABEL). */
const MAX_LABEL = 100

/** One lane as the canvas draws it. */
export interface LaneView {
  /** `lane:<step>:<task>`: unique on the canvas, never a step's id. */
  readonly id: string
  readonly step: string
  /** The agent on the task (null: none launched for its attempt yet). */
  readonly agent: string | null
  readonly label: string
  readonly role: string
  readonly state: LaneState
  readonly attempt: number
  readonly position: { readonly x: number; readonly y: number }
}

/** The lane's state, from its task's board state and whether the run has ended (planModel's `agentState`): a task
 * over reads as it ended, one nothing was launched for as planned, and one still under way when the run ended as stopped. */
export function laneState(lane: Pick<RunLane, 'state' | 'agent'>, runEnded: boolean): LaneState {
  if (lane.state === 'done') return 'ran_ok'
  if (lane.state === 'failed' || lane.state === 'needs_human') return 'ran_failed'
  if (lane.state === 'open' && lane.agent === null) return 'planned'
  return runEnded ? 'stopped' : 'running'
}

/** A lane's text, bounded (WorkflowRunGraph's `nodeTitle`): its agent, else its role. */
export function laneLabel(lane: Pick<RunLane, 'agent' | 'role' | 'task_id'>): string {
  const label = lane.agent ?? (lane.role || lane.task_id)
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/** A gate step's verdict as the board recorded it (`GO`, `NO-GO`), as pass or fail; null for none or unread. */
export function gateOutcome(verdict: string | undefined): 'pass' | 'fail' | null {
  if (verdict === 'GO') return 'pass'
  return verdict === 'NO-GO' || verdict === 'NO_GO' ? 'fail' : null
}

/** Each step's distance from the start along the edges; a step the start never reaches is one row past the rest. */
export function levelsOf(definition: WorkflowDefinition): Map<string, number> {
  const start = definition.nodes.find((node) => node.type === 'start') ?? definition.nodes[0]
  const levels = new Map<string, number>(start === undefined ? [] : [[start.id, 0]])
  const queue = start === undefined ? [] : [start.id]
  for (const id of queue) {
    const next = definition.edges.filter((edge) => edge.source === id && !levels.has(edge.target))
    next.forEach((edge) => { levels.set(edge.target, (levels.get(id) ?? 0) + 1) })
    queue.push(...next.map((edge) => edge.target))
  }
  const past = Math.max(-1, ...levels.values()) + 1
  definition.nodes.forEach((node) => { if (!levels.has(node.id)) levels.set(node.id, past) })
  return levels
}

const stageWidth = (lanes: number) => Math.max(STEP_WIDTH, lanes * LANE_WIDTH + Math.max(0, lanes - 1) * LANE_GAP)

/**
 * The run's flow laid out as stages, with each step's lanes under it: the definition with its steps placed (its
 * edges and loops kept), and the lanes. `runEnded`: an ended run's lanes still under way read as stopped.
 */
export function layoutRun(definition: WorkflowDefinition, lanes: Readonly<Record<string, readonly RunLane[]>>,
  runEnded: boolean): { definition: WorkflowDefinition; lanes: LaneView[] } {
  const levels = levelsOf(definition)
  const rows = [...new Set(levels.values())].sort((a, b) => a - b)
  const placed = new Map<string, { x: number; y: number }>()
  const views: LaneView[] = []
  const cursor = { top: 0 }
  for (const row of rows) {
    const steps = definition.nodes.filter((node) => levels.get(node.id) === row)
    const widths = steps.map((step) => stageWidth(lanes[step.id]?.length ?? 0))
    const total = widths.reduce((sum, width) => sum + width, 0) + STAGE_GAP * Math.max(0, steps.length - 1)
    const left = { x: -total / 2 }
    steps.forEach((step, index) => {
      const width = widths[index] ?? STEP_WIDTH
      placed.set(step.id, { x: left.x + (width - STEP_WIDTH) / 2, y: cursor.top })
      const stageLanes = lanes[step.id] ?? []
      stageLanes.forEach((lane, at) => {
        views.push({
          id: `lane:${step.id}:${lane.task_id}`, step: step.id, agent: lane.agent, label: laneLabel(lane), role: lane.role,
          state: laneState(lane, runEnded), attempt: lane.attempt,
          position: { x: left.x + at * (LANE_WIDTH + LANE_GAP), y: cursor.top + STEP_HEIGHT + LANE_DROP },
        })
      })
      left.x += width + STAGE_GAP
    })
    const tall = steps.some((step) => (lanes[step.id]?.length ?? 0) > 0)
    cursor.top += STEP_HEIGHT + (tall ? LANE_DROP + LANE_HEIGHT : 0) + ROW_GAP
  }
  const nodes = definition.nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position }))
  return { definition: { ...definition, nodes }, lanes: views }
}
