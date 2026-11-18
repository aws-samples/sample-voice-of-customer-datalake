/** Spec support for the workflow editor: the smallest valid definition (start → end), and the editor specs' flow. */
import { WORKFLOW_SCHEMA_VERSION } from '@stream/assistant/tools/agent-limits'
import { withPrdStep } from '@test/workflowFixtures'
import { addBlock } from './model'
import type { AddedStep } from './model'
import type { WorkflowDefinition, WorkflowNodeType } from '../../api/workflowsApi'

export function emptyDefinition(name: string): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA_VERSION,
    name,
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start', params: {} } },
      { id: 'end', type: 'end', position: { x: 0, y: 280 }, data: { title: 'Done', params: { status: 'completed' } } },
    ],
    edges: [{ id: 'e_start__end', source: 'start', target: 'end' }],
    loops: [],
  }
}

/** The editor specs' stored flow ("Research flow", start → end). */
export const STORED_FLOW: WorkflowDefinition = emptyDefinition('Research flow')

/** A valid definition that differs from {@link STORED_FLOW} (one step in between). */
export const EDITED_FLOW: WorkflowDefinition = withPrdStep(emptyDefinition('Research flow'))

/** `definition` with a step of `type` titled `title` at `position` (its type's defaults): a block dropped there. */
export function addNode(
  definition: WorkflowDefinition, type: WorkflowNodeType, position: { x: number; y: number }, title: string,
): AddedStep {
  return addBlock(definition, { type, title }, position)
}
