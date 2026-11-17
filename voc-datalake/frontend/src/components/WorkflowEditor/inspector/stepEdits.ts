/**
 * @fileoverview One step's settings written back (7.52.00 C2): the definition with a step's `params` replaced by a patch
 * of them, a key set to undefined left out.
 *
 * @module components/WorkflowEditor/inspector/stepEdits
 */
import { updateNode } from '../model'
import type { WorkflowDefinition } from '../../../api/workflowsApi'

/** The definition with one step's settings replaced by `patch` of them (a key set to undefined is left out). */
export function setParams(definition: WorkflowDefinition, nodeId: string,
  patch: (params: Readonly<Record<string, unknown>>) => Record<string, unknown>): WorkflowDefinition {
  return updateNode(definition, nodeId, (node) => {
    const next = Object.fromEntries(Object.entries(patch(node.data.params ?? {})).filter(([, value]) => value !== undefined))
    return { ...node, data: { ...node.data, params: next } }
  })
}


/** The definition with one step's assertions replaced (none: the setting left out). */
export function withAssertions(definition: WorkflowDefinition, nodeId: string, next: readonly unknown[]): WorkflowDefinition {
  return setParams(definition, nodeId, (current) => ({ ...current, assert: next.length === 0 ? undefined : next }))
}
