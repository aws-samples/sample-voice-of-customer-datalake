/**
 * @fileoverview The one flow canvas (7.52.00, ux-agents-redesign part 5 §5.6: one shared canvas for build, view and
 * run), as the pages that only show a flow use it: an automation's Flow tab (read only, nothing is edited in place)
 * and a run's lit graph. C1's thin wrapper over today's `WorkflowCanvas` in its read-only mode, until 7.52.00 C2's
 * canvas (its node language, the inspector on click) takes this file's place with the same name and props.
 *
 * - `mode: 'view'`: the flow as saved, nothing can be moved, connected or deleted;
 * - `mode: 'run'`: the same, lit by `runState` (each step's state, components/WorkflowEditor/runState.ts).
 *
 * It fills its container: the caller gives it a height.
 *
 * @module components/WorkflowEditor/FlowCanvas
 */
import { WorkflowCanvas } from './WorkflowCanvas'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { StepState } from './runState'

interface FlowCanvasProps {
  readonly definition: WorkflowDefinition
  readonly mode: 'view' | 'run'
  /** Each step's state in a run (`mode: 'run'`). */
  readonly runState?: ReadonlyMap<string, StepState>
}

export function FlowCanvas({ definition, mode, runState }: FlowCanvasProps) {
  return <WorkflowCanvas definition={definition} readOnly runStates={mode === 'run' ? runState : undefined} />
}
