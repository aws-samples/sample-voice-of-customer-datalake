/**
 * @fileoverview Builders for `voc-workflow/1` fixtures shared by the workflow
 * editor, agent and approval specs: a graph node, an edge, and the
 * `GET /workflows/{id}` view that wraps a definition.
 */

/** A workflow node at `(0, y)`; `params` is set only when given. */
export function wfNode(id: string, type: string, title: string, y = 0, params?: Record<string, unknown>) {
  const data = params === undefined ? { title } : { title, params }
  return { id, type, position: { x: 0, y }, data }
}

/** A workflow edge `source → target`. */
export function wfEdge(id: string, source: string, target: string) {
  return { id, source, target }
}

/** The `GET /workflows/wf_1` answer (`slug: 'flow'`, no revisions) wrapping `definition`. */
export function workflowView<D extends { name: string }>(revision: number, definition: D, extra: Record<string, unknown> = {}) {
  return {
    workflow: {
      workflow_id: 'wf_1', slug: 'flow', name: definition.name, description: '', revision,
      derived_from: null, builtin: false, updated_at: null, updated_by_username: null, definition, ...extra,
    },
    revisions: [],
  }
}
