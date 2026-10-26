/**
 * @fileoverview What is selected in the workflow editor: steps, arrows and
 * loop frames. Shared by the canvas (which reports React Flow's selection and
 * applies one chosen in the side panel) and the side panel (which configures
 * whatever is selected).
 *
 * @module components/WorkflowEditor/selection
 */
import type { WorkflowDefinition, WorkflowNode } from '../../api/workflowsApi'

export interface CanvasSelection {
  nodeIds: string[]
  edgeIds: string[]
  /** Indexes into `definition.loops` of the selected loop frames. */
  loopIndexes: number[]
}

export const EMPTY_SELECTION: CanvasSelection = { nodeIds: [], edgeIds: [], loopIndexes: [] }

export const selectStep = (nodeId: string): CanvasSelection => ({ nodeIds: [nodeId], edgeIds: [], loopIndexes: [] })

export const selectLoop = (index: number): CanvasSelection => ({ nodeIds: [], edgeIds: [], loopIndexes: [index] })

/** What the panel shows for a selection: pure, so the precedence is easy to read and test. */
export type PanelView =
  | { kind: 'workflow' }
  | { kind: 'steps'; nodeIds: readonly string[] }
  | { kind: 'step'; node: WorkflowNode }
  | { kind: 'arrow'; edgeId: string }
  | { kind: 'loop'; index: number }

const only = <T>(items: readonly T[]): T | undefined => (items.length === 1 ? items[0] : undefined)

/**
 * Several steps → group them; one step → its settings; one arrow → its
 * condition; one loop frame (and no arrow) → the loop; anything else (nothing,
 * or ids that no longer exist) → the workflow itself.
 */
export function viewOf(definition: WorkflowDefinition, { nodeIds, edgeIds, loopIndexes }: CanvasSelection): PanelView {
  if (nodeIds.length > 1) return { kind: 'steps', nodeIds }
  const node = definition.nodes.find((n) => n.id === only(nodeIds))
  if (node !== undefined) return { kind: 'step', node }
  if (nodeIds.length > 0) return { kind: 'workflow' }
  const edgeId = only(edgeIds)
  if (edgeId !== undefined && definition.edges.some((e) => e.id === edgeId)) return { kind: 'arrow', edgeId }
  const index = only(loopIndexes)
  if (edgeIds.length === 0 && index !== undefined && definition.loops.at(index) !== undefined) return { kind: 'loop', index }
  return { kind: 'workflow' }
}

const sameMembers = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item) => b.includes(item))

/** Same steps, arrows and loops (order ignored). */
export function sameSelection(a: CanvasSelection, b: CanvasSelection): boolean {
  return sameMembers(a.nodeIds, b.nodeIds) && sameMembers(a.edgeIds, b.edgeIds) && sameMembers(a.loopIndexes, b.loopIndexes)
}
