/** Spec support for the workflow editor: the smallest valid definition (start → end). */
import { WORKFLOW_SCHEMA } from '../../api/workflowsApi'
import type { WorkflowDefinition } from '../../api/workflowsApi'

export function emptyDefinition(name: string): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    name,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start', params: {} } },
      { id: 'end', type: 'end', position: { x: 0, y: 280 }, data: { title: 'Done', params: { status: 'completed' } } },
    ],
    edges: [{ id: 'e_start__end', source: 'start', target: 'end' }],
    loops: [],
  }
}
