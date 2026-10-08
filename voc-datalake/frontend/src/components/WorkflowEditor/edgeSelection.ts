/**
 * @fileoverview Which arrows are selected on the canvas. The canvas derives its
 * React Flow edges from the workflow definition (controlled), so React Flow's
 * own `select` changes must be applied here — otherwise a clicked or
 * keyboard-selected arrow never becomes selected, can't be deleted and never
 * opens its settings (condition, "Delete arrow").
 *
 * @module components/WorkflowEditor/edgeSelection
 */
import type { EdgeChange } from '@xyflow/react'

export const NO_EDGES: ReadonlySet<string> = new Set()

/**
 * The selection after `changes`: `select` adds or drops an id, `remove` drops it.
 * Returns `previous` itself when nothing changed, so React state stays referentially stable.
 */
export function applyEdgeSelection(previous: ReadonlySet<string>, changes: readonly EdgeChange[]): ReadonlySet<string> {
  const next = new Set(previous)
  for (const change of changes) {
    if (change.type === 'select' && change.selected) next.add(change.id)
    else if (change.type === 'select' || change.type === 'remove') next.delete(change.id)
  }
  const unchanged = next.size === previous.size && [...next].every((id) => previous.has(id))
  return unchanged ? previous : next
}
