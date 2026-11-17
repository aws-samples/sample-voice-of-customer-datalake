/**
 * @fileoverview The canvas under its earlier props (before 7.52.00), on the one flow canvas (FlowCanvas.tsx): editable,
 * or read only (`readOnly`), which is the run graph with `runStates` and its `lanes`, and the view mode without;
 * `onStepClick` hears the step (or a run's lane) a selection opens. New callers use FlowCanvas and its modes.
 *
 * @module components/WorkflowEditor/WorkflowCanvas
 */
import { useCallback, useMemo } from 'react'
import { FlowCanvas } from './FlowCanvas'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { FlowRunState, FlowSelection } from './FlowCanvas'
import type { FlowMode, LaneFlowNode } from './nodes/nodeData'
import type { CanvasSelection } from './selection'
import type { StepState } from './runState'

interface WorkflowCanvasProps {
  definition: WorkflowDefinition
  readOnly?: boolean
  /** Inline validation messages per step id. */
  issuesByNode?: ReadonlyMap<string, readonly string[]>
  /** Run-graph state per step id (read-only mode). */
  runStates?: ReadonlyMap<string, StepState>
  /** An engineering run's lanes (read-only mode), placed by the caller: inert, drawn after the steps. */
  lanes?: readonly LaneFlowNode[]
  /** A selection made outside the canvas (side panel, palette), applied whenever this object changes. */
  selection?: CanvasSelection
  onChange?: (definition: WorkflowDefinition) => void
  onSelectionChange?: (selection: CanvasSelection) => void
  /** Selecting a step, or a run's lane, in read-only mode (event-log filter, the run workspace's session). */
  onStepClick?: (nodeId: string) => void
}

/** Editable; read only with a run's state (the run graph) or without (a view). */
function modeOf(readOnly: boolean, runStates: ReadonlyMap<string, StepState> | undefined): FlowMode {
  if (!readOnly) return 'build'
  return runStates === undefined ? 'view' : 'run'
}

export function WorkflowCanvas({ readOnly = false, runStates, lanes, onStepClick, ...rest }: Readonly<WorkflowCanvasProps>) {
  const runState = useMemo((): FlowRunState | undefined => (
    runStates === undefined ? undefined : { steps: runStates, ...(lanes === undefined ? {} : { lanes }) }
  ), [runStates, lanes])
  const onSelect = useCallback((selection: FlowSelection) => {
    if (selection?.kind === 'step' || selection?.kind === 'lane') onStepClick?.(selection.id)
  }, [onStepClick])
  return <FlowCanvas {...rest} mode={modeOf(readOnly, runStates)} runState={runState} onSelect={onSelect} />
}
