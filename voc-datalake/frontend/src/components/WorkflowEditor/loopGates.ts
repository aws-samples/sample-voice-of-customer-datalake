/**
 * @fileoverview A loop's gate: the review that decides whether the loop goes
 * round again. A `persona_agreement` loop is gated by its persona reviews
 * (`agreed` leaves the loop, `not_agreed` stays inside); a `review_pass` loop by
 * its final reviews (`pass` leaves, `fail` stays). Shared by the graph rules
 * (graphRules.ts) and the arrow defaults (model.ts `connect`).
 *
 * @module components/WorkflowEditor/loopGates
 */
import type { WorkflowDefinition, WorkflowEdgeLabel, WorkflowLoop, WorkflowNodeType } from '../../api/workflowsApi'

export interface GateLabels {
  /** The verdict that leaves the loop. */
  pass: WorkflowEdgeLabel
  /** The verdict that goes round again, inside the loop. */
  fail: WorkflowEdgeLabel
}

const PERSONA_GATE: GateLabels = { pass: 'agreed', fail: 'not_agreed' }
const REVIEW_GATE: GateLabels = { pass: 'pass', fail: 'fail' }

/** The labels a step of `type` gates `loop` with, or null when it is not the loop's review. */
export function gateOf(loop: Pick<WorkflowLoop, 'until'>, type: WorkflowNodeType | undefined): GateLabels | null {
  if (loop.until === 'persona_agreement' && type === 'persona_review') return PERSONA_GATE
  if (loop.until === 'review_pass' && type === 'final_review') return REVIEW_GATE
  return null
}

/**
 * The label an arrow from `source` to `target` should carry when `source` gates
 * its loop: the failing verdict for a target inside the loop, the passing one
 * for a target outside. Undefined when `source` is not a gate.
 */
export function gateLabelFor(definition: WorkflowDefinition, source: string, target: string): WorkflowEdgeLabel | undefined {
  const loop = definition.loops.find((l) => l.node_ids.includes(source))
  if (loop === undefined) return undefined
  const gate = gateOf(loop, definition.nodes.find((n) => n.id === source)?.type)
  if (gate === null) return undefined
  return loop.node_ids.includes(target) ? gate.fail : gate.pass
}
