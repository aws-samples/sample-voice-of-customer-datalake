/**
 * @fileoverview Builders for `voc-workflow/1` fixtures shared by the workflow
 * editor, agent and approval specs: a graph node, an edge, and the
 * `GET /workflows/{id}` view that wraps a definition.
 */
import type { WorkflowDefinition } from '../api/workflowsApi'

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

/** A minimal valid `voc-workflow/1` definition (shape only — graph rules are the Lambda's). */
export const MINI_WORKFLOW = {
  schema: 'voc-workflow/1',
  name: 'Mini',
  nodes: [
    { id: 's', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
    { id: 'e', type: 'end', position: { x: 0, y: 100 }, data: { title: 'End', params: { status: 'completed' } } },
  ],
  edges: [{ id: 'e1', source: 's', target: 'e' }],
  loops: [],
}

/** A JSON file for the editor's Import input; jsdom's File has no `text()`, so the instance gets one. */
export function jsonFile(content: string): File {
  const file = new File([content], 'flow.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  return file
}

/** The editor's (hidden) Import file input inside `container`. */
export function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input')
  return input
}

/** `base` (a start → end definition) with one step in between: start → write the PRD → end. */
export function withPrdStep(base: WorkflowDefinition): WorkflowDefinition {
  const prd: WorkflowDefinition['nodes'][number] = {
    id: 'prd', type: 'write_prd', position: { x: 0, y: 140 }, data: { title: 'Write the PRD', role: 'worker' },
  }
  return { ...base, nodes: [...base.nodes, prd], edges: [wfEdge('e1', 'start', 'prd'), wfEdge('e2', 'prd', 'end')] }
}
