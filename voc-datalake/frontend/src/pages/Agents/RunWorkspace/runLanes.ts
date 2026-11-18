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
 * by side within a row (a run's copy keeps no layout of its own worth trusting). (7.54.00, the owner: a lane was drawn
 * on top of its step's card, over its cost chip, and the arrows ran through it) A step's lanes sit BESIDE its card, to
 * its right, parallel lanes side by side (a second line from the fourth), centred on the card; a row is as tall as its
 * tallest card or lane block, and a single step's row is centred on the step, so the arrows, which leave a card at its
 * bottom and enter the next at its top, run straight down between the rows and never through a lane. A run's card
 * grows with what ran on it (its chips wrap): its height is the one the canvas measured (FlowCanvas `onMeasured`),
 * else an estimate with room for two lines of chips.
 *
 * @module pages/Agents/RunWorkspace/runLanes
 */
import { STEP_WIDTH } from '../../../components/WorkflowEditor/model'
import { NO_SIZES } from '../../../components/WorkflowEditor/flowCanvasModel'
import { kindOf, nodeSize, stepLevels } from '../../../components/WorkflowEditor/nodes/nodeKinds'
import type { MeasuredSizes } from '../../../components/WorkflowEditor/flowCanvasModel'
import type { LaneState } from '../../../components/WorkflowEditor/runState'
import type { NodeKind } from '../../../components/WorkflowEditor/nodes/nodeKinds'
import type { WorkflowDefinition, WorkflowNode } from '../../../api/workflowsApi'
import type { RunLane } from '../../../api/engineeringRunsApi'
import type { RunPhase } from './agentStatus'

export const LANE_WIDTH = 168
export const LANE_HEIGHT = 44
/** Between two lanes of a step, across and down. */
const LANE_GAP = 12
/** Between a step's card and its first lane. */
export const LANE_OFFSET = 32
/** The lanes of a step on one line, side by side; more go on a second line under them. */
export const LANES_PER_LINE = 3
/** Between two stages of a row, and between two rows (the arrows and the "You are here" tag live there). */
const STAGE_GAP = 56
export const ROW_GAP = 80
/** What a run card of these kinds may grow by before it is measured: its chips on a second line (and a team's avatars). */
const RUN_GROWTH: Readonly<Partial<Record<NodeKind, number>>> = { agent: 32, team: 40, call: 32, gate: 8 }
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

/** An agent's session statuses held with no session at work (runtime/sessions.py), and those over. */
const HELD: ReadonlySet<string> = new Set(['paused', 'waiting'])
const OVER: ReadonlySet<string> = new Set(['stopped', 'reposted'])

/**
 * An agent's state from its session's status and where the run stands (7.51.04): done, failed, stopped (or posted
 * again) as they say; held (paused) while the run waits for a person or the session is held; stopped once the run
 * has ended; else at work (booting, working, pausing, or a launch with no session row yet), the only state that spins.
 */
export function sessionState(status: string | null, phase: RunPhase): LaneState {
  if (status === 'done') return 'ran_ok'
  if (status === 'failed' || status === 'crashed') return 'ran_failed'
  if (phase === 'ended' || (status !== null && OVER.has(status))) return 'stopped'
  return phase === 'halted' || (status !== null && HELD.has(status)) ? 'paused' : 'running'
}

/** The lane's state, from its task's board state, its agent's session and where the run stands (planModel's
 * `agentState`): a task over reads as it ended, one waiting for a person as waiting (7.51.04, never a failure), one
 * nothing was launched for as planned, and one under way as its agent's session (sessionState). */
export function laneState(lane: Pick<RunLane, 'state' | 'agent' | 'status'>, phase: RunPhase): LaneState {
  if (lane.state === 'done') return 'ran_ok'
  if (lane.state === 'failed') return 'ran_failed'
  if (lane.state === 'needs_human') return 'waiting'
  if (lane.state === 'open' && lane.agent === null) return 'planned'
  return sessionState(lane.status, phase)
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

/** How wide a step's lanes are beside it (none: 0), and how tall. */
function laneBlock(count: number): { width: number; height: number } {
  if (count === 0) return { width: 0, height: 0 }
  const across = Math.min(count, LANES_PER_LINE)
  const lines = Math.ceil(count / LANES_PER_LINE)
  return {
    width: LANE_OFFSET + across * LANE_WIDTH + (across - 1) * LANE_GAP,
    height: lines * LANE_HEIGHT + (lines - 1) * LANE_GAP,
  }
}

/** A step's card height in the run: as measured, else its kind's least height with room for what ran on it. */
function cardHeight(step: WorkflowNode, sizes: MeasuredSizes): number {
  const measured = sizes.get(step.id)?.height
  if (measured !== undefined && measured > 0) return measured
  return nodeSize(step).height + (RUN_GROWTH[kindOf(step)] ?? 0)
}

/**
 * The run's flow laid out as stages, with each step's lanes beside it: the definition with its steps placed (its
 * edges and loops kept), and the lanes. `phase`: where the run stands (an ended run's lanes still under way read as
 * stopped, a run's at a person as held: laneState). `sizes`: the cards as the canvas measured them (none yet: their
 * estimate).
 */
export function layoutRun(definition: WorkflowDefinition, lanes: Readonly<Record<string, readonly RunLane[]>>,
  phase: RunPhase, sizes: MeasuredSizes = NO_SIZES): { definition: WorkflowDefinition; lanes: LaneView[] } {
  const levels = stepLevels(definition)
  const rows = [...new Set(levels.values())].sort((a, b) => a - b)
  const placed = new Map<string, { x: number; y: number }>()
  const views: LaneView[] = []
  const cursor = { top: 0 }
  for (const row of rows) {
    const steps = definition.nodes.filter((node) => levels.get(node.id) === row)
    const blocks = steps.map((step) => laneBlock(lanes[step.id]?.length ?? 0))
    const total = blocks.reduce((sum, block) => sum + STEP_WIDTH + block.width, 0) + STAGE_GAP * Math.max(0, steps.length - 1)
    // (centred on its steps: the last stage's lanes trail to the right, so a step alone in its row sits on the axis)
    const left = { x: -(total - (blocks.at(-1)?.width ?? 0)) / 2 }
    const heights = steps.map((step) => cardHeight(step, sizes))
    steps.forEach((step, index) => {
      const block = blocks[index] ?? { width: 0, height: 0 }
      const height = heights[index] ?? nodeSize(step).height
      placed.set(step.id, { x: left.x, y: cursor.top })
      // (the lane block centred on the card, or the card's top when it is the taller)
      const top = cursor.top + Math.max(0, (height - block.height) / 2)
      const laneLeft = left.x + STEP_WIDTH + LANE_OFFSET
      const stageLanes = lanes[step.id] ?? []
      stageLanes.forEach((lane, at) => {
        const column = at % LANES_PER_LINE
        const line = Math.floor(at / LANES_PER_LINE)
        views.push({
          id: `lane:${step.id}:${lane.task_id}`, step: step.id, agent: lane.agent, label: laneLabel(lane), role: lane.role,
          state: laneState(lane, phase), attempt: lane.attempt,
          position: { x: laneLeft + column * (LANE_WIDTH + LANE_GAP), y: top + line * (LANE_HEIGHT + LANE_GAP) },
        })
      })
      left.x += STEP_WIDTH + block.width + STAGE_GAP
    })
    const rowHeight = Math.max(0, ...steps.map((_step, index) => Math.max(heights[index] ?? 0, blocks[index]?.height ?? 0)))
    cursor.top += rowHeight + ROW_GAP
  }
  const nodes = definition.nodes.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position }))
  return { definition: { ...definition, nodes }, lanes: views }
}
