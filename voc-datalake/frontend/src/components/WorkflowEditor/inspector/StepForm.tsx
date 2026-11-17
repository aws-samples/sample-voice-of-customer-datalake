/**
 * @fileoverview A step's own fields while building, "In this flow" (moved here from NodeConfigPanel in 7.52.00 C2):
 * its title, its role (an agents workflow's; an engineering step's only to clear one imported), its instructions and
 * its type's settings (ParamsFields: an agent's role, skill version, model and share; a gate's rounds and packs…),
 * with its issues in words; and Delete step, the panel's last control. An agents workflow's step edits read only
 * through the same fields (its view mode is these, disabled); an engineering flow's view and run read as text.
 *
 * @module components/WorkflowEditor/inspector/StepForm
 */
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { WORKFLOW_NODE_ROLES } from '@stream/assistant/tools/agent-limits'
import { API_WORKFLOW_LIMITS, isEngineeringFlow } from '../../../api/workflowsApi'
import { LabeledField } from '../../LabeledField/LabeledField'
import PromptField from '../../Document/text/PromptField'
import { removeNodes, updateNode } from '../model'
import { NodeTypeIcon } from '../NodeTypeIcon'
import { ParamsFields } from '../ParamsFields'
import { workflowIssueText } from '../workflowIssueText'
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeRole } from '../../../api/workflowsApi'

export function StepForm({ node, definition, issues, readOnly, onChange, showType = true }: Readonly<{
  node: WorkflowNode; definition: WorkflowDefinition; issues: readonly string[]; readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
  /** The type line and its description (the inspector's header says the kind already). */
  showType?: boolean
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
      {showType && (
        <>
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <NodeTypeIcon type={node.type} /> {t(`nodeTypes.${node.type}.label`)}
            <span className="ml-auto font-mono text-[11px] text-muted-strong" data-testid="step-id">{node.id}</span>
          </p>
          <p className="text-[12px] text-muted">{t(`nodeTypes.${node.type}.description`)}</p>
        </>
      )}
      {issues.length > 0 && (
        <ul className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger space-y-0.5" aria-live="polite">
          {issues.map((message) => <li key={message}>{workflowIssueText(t, message)}</li>)}
        </ul>
      )}
      <LabeledField label={t('editor.fields.title')}>
        {(id) => (
          <input id={id} className="input w-full" disabled={readOnly} maxLength={API_WORKFLOW_LIMITS.maxTitleChars} value={node.data.title}
            required aria-invalid={node.data.title.trim() === ''}
            onChange={(e) => patch((n) => ({ ...n, data: { ...n.data, title: e.target.value } }))} />
        )}
      </LabeledField>
      {/* An engineering step takes no `data.role` (an agent's role is its setting): shown only to clear one imported. */}
      {(!isEngineeringFlow(definition) || node.data.role !== undefined) && (
        <LabeledField label={t('editor.fields.role')}>
          {(id) => (
            <select id={id} className="select w-full" disabled={readOnly} value={node.data.role ?? ''} onChange={(e) => setRole(e.target.value)}>
              <option value="">{t('editor.fields.roleNone')}</option>
              {WORKFLOW_NODE_ROLES.map((role) => <option key={role} value={role}>{t(`roles.${role}`)}</option>)}
            </select>
          )}
        </LabeledField>
      )}
      {/* A prompt the flow's Save writes (§6.4 step 7, 7.52.00 C3): edited as written with its count, read only as text. */}
      <PromptField label={t(node.type === 'custom_llm' ? 'editor.fields.instructionsRequired' : 'editor.fields.instructions')}
        hint={null} value={node.data.instructions ?? ''} readOnly={readOnly} maxChars={API_WORKFLOW_LIMITS.maxInstructionsChars}
        onChange={(instructions) => patch((n) => ({ ...n, data: { ...n.data, instructions } }))} />
      <ParamsFields node={node} readOnly={readOnly} onParams={(params) => patch((n) => ({ ...n, data: { ...n.data, params } }))} />
    </div>
  )
}

/**
 * Last in the step's settings, after its arrows and loop: as the form's final
 * control it read as the end of the panel, and "Add arrow" below it went unseen.
 */
export function DeleteStep({ node, definition, onChange }: Readonly<{
  node: WorkflowNode; definition: WorkflowDefinition; onChange: (definition: WorkflowDefinition) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <div className="border-t border-border pt-3">
      <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(removeNodes(definition, new Set([node.id])))}>
        <Trash2 size={14} aria-hidden="true" /> {t('editor.deleteStep')}
      </button>
    </div>
  )
}
