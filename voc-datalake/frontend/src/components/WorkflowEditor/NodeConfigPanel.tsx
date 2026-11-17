/**
 * @fileoverview The editor's side panel, the router to the inspectors (7.52.00 C2): one step or one arrow opens the
 * flow inspector (FlowInspector.tsx: its setup per kind, "In this flow" apart from what is read only), one loop its
 * settings (exit condition, max rounds, members), several steps "group them into a loop" (an agents workflow's),
 * and nothing selected the workflow itself (name, description, an outline of its steps and loops, and "Select a
 * step to see its setup").
 *
 * @module components/WorkflowEditor/NodeConfigPanel
 */
import { ArrowLeft, Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isEngineeringFlow } from '../../api/workflowsApi'
import { createLoop } from './model'
import { LoopForm } from './LoopSettings'
import { FlowInspector } from './FlowInspector'
import { EMPTY_SELECTION, selectLoop, viewOf } from './selection'
import { WorkflowDetails } from './WorkflowDetails'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { CanvasSelection, PanelView } from './selection'
import type { FlowMode } from './nodes/nodeData'

interface PanelProps {
  definition: WorkflowDefinition
  selection: CanvasSelection
  issuesByNode: ReadonlyMap<string, readonly string[]>
  /** Validation messages not pinned to a step (loop messages among them). */
  generalIssues?: readonly string[]
  readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
  /** Select from the panel (outline, "Back to the workflow"); the canvas follows. */
  onSelect?: (selection: CanvasSelection) => void
  /** (7.52.00) The flow's id when stored (its users, its expansion); null for an unsaved copy. */
  workflowId?: string | null
  /** The selection was made from the keyboard: the inspector's heading takes focus. */
  focusHeading?: boolean
}

const NO_GENERAL: readonly string[] = []

function BackToWorkflow({ onSelect }: Readonly<{ onSelect?: (selection: CanvasSelection) => void }>) {
  const { t } = useTranslation('agents')
  if (onSelect === undefined) return null
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(EMPTY_SELECTION)}>
      <ArrowLeft size={14} aria-hidden="true" /> {t('editor.backToWorkflow')}
    </button>
  )
}

function MultiSelection({ definition, nodeIds, readOnly, onChange }: Readonly<{
  definition: WorkflowDefinition; nodeIds: readonly string[]; readOnly: boolean; onChange: (definition: WorkflowDefinition) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-3">
      <p className="text-sm text-text">{t('editor.multiSelected', { n: nodeIds.length })}</p>
      {!readOnly && !isEngineeringFlow(definition) && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(createLoop(definition, nodeIds))}>
          <Repeat size={14} aria-hidden="true" /> {t('editor.groupLoop')}
        </button>
      )}
    </div>
  )
}

function SelectedView({ view, definition, issuesByNode, generalIssues = NO_GENERAL, readOnly, onChange, onSelect, workflowId,
  focusHeading }: Readonly<Omit<PanelProps, 'selection'> & { view: Exclude<PanelView, { kind: 'workflow' }> }>) {
  const close = onSelect === undefined ? undefined : () => onSelect(EMPTY_SELECTION)
  const mode: FlowMode = readOnly ? 'view' : 'build'
  const inspector = { definition, mode, issuesByNode, generalIssues, onChange, onClose: close, workflowId: workflowId ?? null, focusHeading }
  switch (view.kind) {
    case 'steps':
      return <MultiSelection definition={definition} nodeIds={view.nodeIds} readOnly={readOnly} onChange={onChange} />
    case 'step':
      return <FlowInspector {...inspector} selection={{ kind: 'step', id: view.node.id }} />
    case 'arrow':
      return <FlowInspector {...inspector} selection={{ kind: 'edge', id: view.edgeId }} />
    case 'loop':
      return (
        <LoopForm definition={definition} index={view.index} readOnly={readOnly} onChange={onChange} issues={generalIssues}
          onIndexChange={onSelect === undefined ? undefined : (index) => onSelect(selectLoop(index))} />
      )
  }
}

function NothingSelected() {
  const { t } = useTranslation('agents')
  return <p className="text-[12px] text-muted">{t('editor.nothingSelected')}</p>
}

export function NodeConfigPanel({ selection, ...props }: Readonly<PanelProps>) {
  const { t } = useTranslation('agents')
  const { definition, readOnly, onChange, onSelect } = props
  const view = viewOf(definition, selection)
  if (view.kind === 'workflow') {
    if (onSelect === undefined) return <NothingSelected />
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-muted">{t('inspector.empty.selectStep')}</p>
        <WorkflowDetails definition={definition} readOnly={readOnly} onChange={onChange} onSelect={onSelect} />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <BackToWorkflow onSelect={onSelect} />
      <SelectedView view={view} {...props} />
    </div>
  )
}
