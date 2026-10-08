/**
 * @fileoverview The editor's side panel: configures whatever is selected —
 * one step (title, role, instructions, type-specific params, its outgoing
 * arrows and their conditions, its loop), one arrow (its condition), one loop
 * (exit condition, max rounds, members), several steps (group them into a
 * loop) — or, with nothing selected, the workflow itself (name, description,
 * an outline of its steps and loops).
 *
 * @module components/WorkflowEditor/NodeConfigPanel
 */
import { ArrowLeft, Repeat, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { API_WORKFLOW_LIMITS, WORKFLOW_NODE_ROLES } from '../../api/workflowsApi'
import { createLoop, removeNodes, updateNode } from './model'
import { EdgeForm, StepArrows } from './ArrowSettings'
import { LoopForm, StepLoop } from './LoopSettings'
import { NodeTypeIcon } from './NodeTypeIcon'
import { ParamsFields } from './ParamsFields'
import { EMPTY_SELECTION, selectLoop, viewOf } from './selection'
import { WorkflowDetails } from './WorkflowDetails'
import { LabeledField } from '../LabeledField/LabeledField'
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeRole } from '../../api/workflowsApi'
import type { CanvasSelection, PanelView } from './selection'

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

function StepForm({ node, definition, issues, readOnly, onChange }: Readonly<{
  node: WorkflowNode; definition: WorkflowDefinition; issues: readonly string[]; readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
}>) {
  const { t } = useTranslation('agents')
  const patch = (fn: (n: WorkflowNode) => WorkflowNode) => onChange(updateNode(definition, node.id, fn))
  const setRole = (value: string) => {
    const role: WorkflowNodeRole | undefined = WORKFLOW_NODE_ROLES.find((r) => r === value)
    patch((n) => {
      const { title, instructions, params } = n.data
      return { ...n, data: { title, ...(instructions === undefined ? {} : { instructions }), ...(role === undefined ? {} : { role }), ...(params === undefined ? {} : { params }) } }
    })
  }
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
        <NodeTypeIcon type={node.type} /> {t(`nodeTypes.${node.type}.label`)}
        <span className="ml-auto font-mono text-[11px] text-muted-strong" data-testid="step-id">{node.id}</span>
      </p>
      <p className="text-[12px] text-muted">{t(`nodeTypes.${node.type}.description`)}</p>
      {issues.length > 0 && (
        <ul className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger space-y-0.5" aria-live="polite">
          {issues.map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <LabeledField label={t('editor.fields.title')}>
        {(id) => (
          <input id={id} className="input w-full" disabled={readOnly} maxLength={API_WORKFLOW_LIMITS.maxTitleChars} value={node.data.title}
            required aria-invalid={node.data.title.trim() === ''}
            onChange={(e) => patch((n) => ({ ...n, data: { ...n.data, title: e.target.value } }))} />
        )}
      </LabeledField>
      <LabeledField label={t('editor.fields.role')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={node.data.role ?? ''} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t('editor.fields.roleNone')}</option>
            {WORKFLOW_NODE_ROLES.map((role) => <option key={role} value={role}>{t(`roles.${role}`)}</option>)}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t(node.type === 'custom_llm' ? 'editor.fields.instructionsRequired' : 'editor.fields.instructions')}>
        {(id) => (
          <textarea id={id} rows={5} className="input w-full resize-y" disabled={readOnly}
            maxLength={API_WORKFLOW_LIMITS.maxInstructionsChars} value={node.data.instructions ?? ''}
            onChange={(e) => patch((n) => ({ ...n, data: { ...n.data, instructions: e.target.value } }))} />
        )}
      </LabeledField>
      <ParamsFields node={node} readOnly={readOnly} onParams={(params) => patch((n) => ({ ...n, data: { ...n.data, params } }))} />
      {!readOnly && (
        <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(removeNodes(definition, new Set([node.id])))}>
          <Trash2 size={14} aria-hidden="true" /> {t('editor.deleteStep')}
        </button>
      )}
    </div>
  )
}

function MultiSelection({ definition, nodeIds, readOnly, onChange }: Readonly<{
  definition: WorkflowDefinition; nodeIds: readonly string[]; readOnly: boolean; onChange: (definition: WorkflowDefinition) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-3">
      <p className="text-sm text-text">{t('editor.multiSelected', { n: nodeIds.length })}</p>
      {!readOnly && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(createLoop(definition, nodeIds))}>
          <Repeat size={14} aria-hidden="true" /> {t('editor.groupLoop')}
        </button>
      )}
    </div>
  )
}

function SelectedView({ view, definition, issuesByNode, generalIssues = NO_GENERAL, readOnly, onChange, onSelect }: Readonly<
  Omit<PanelProps, 'selection'> & { view: Exclude<PanelView, { kind: 'workflow' }> }
>) {
  switch (view.kind) {
    case 'steps':
      return <MultiSelection definition={definition} nodeIds={view.nodeIds} readOnly={readOnly} onChange={onChange} />
    case 'step':
      return (
        <div className="space-y-3">
          <StepForm node={view.node} definition={definition} issues={issuesByNode.get(view.node.id) ?? []} readOnly={readOnly} onChange={onChange} />
          <StepArrows definition={definition} node={view.node} readOnly={readOnly} onChange={onChange} />
          <StepLoop definition={definition} node={view.node} readOnly={readOnly} onChange={onChange} issues={generalIssues} />
        </div>
      )
    case 'arrow':
      return <EdgeForm definition={definition} edgeId={view.edgeId} readOnly={readOnly} onChange={onChange} />
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
  const { definition, readOnly, onChange, onSelect } = props
  const view = viewOf(definition, selection)
  if (view.kind === 'workflow') {
    if (onSelect === undefined) return <NothingSelected />
    return <WorkflowDetails definition={definition} readOnly={readOnly} onChange={onChange} onSelect={onSelect} />
  }
  return (
    <div className="space-y-3">
      <BackToWorkflow onSelect={onSelect} />
      <SelectedView view={view} {...props} />
    </div>
  )
}
