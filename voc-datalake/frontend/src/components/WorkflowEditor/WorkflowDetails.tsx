/**
 * @fileoverview The side panel when nothing is selected: the workflow's name
 * and description, and an outline of its steps and loops. Each outline entry
 * selects that step / loop (on the canvas too), so every setting is reachable
 * from the keyboard without pointing at the canvas.
 *
 * @module components/WorkflowEditor/WorkflowDetails
 */
import { Repeat } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { API_WORKFLOW_LIMITS } from '../../api/workflowsApi'
import { NodeTypeIcon } from './NodeTypeIcon'
import { selectLoop, selectStep } from './selection'
import { LabeledField } from '../LabeledField/LabeledField'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { CanvasSelection } from './selection'

interface WorkflowDetailsProps {
  definition: WorkflowDefinition
  readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
  onSelect: (selection: CanvasSelection) => void
}

const OUTLINE_BUTTON = 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-text hover:bg-bg-hover focus-ring'

/** `description` set, or dropped when blank (a stored workflow without one stays unchanged). */
function withDescription(definition: WorkflowDefinition, description: string): WorkflowDefinition {
  if (description !== '') return { ...definition, description }
  const { schema, name, nodes, edges, loops } = definition
  return { schema, name, nodes, edges, loops }
}

function Outline({ definition, onSelect }: Readonly<Pick<WorkflowDetailsProps, 'definition' | 'onSelect'>>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <section className="space-y-1" aria-label={t('editor.outlineSteps')}>
        <p className="text-[12px] font-semibold text-muted">{t('editor.outlineStepsCount', { n: definition.nodes.length })}</p>
        {definition.nodes.length === 0 ? (
          <p className="text-[12px] text-muted">{t('editor.emptyCanvas')}</p>
        ) : (
          <ul className="space-y-0.5">
            {definition.nodes.map((node) => (
              <li key={node.id}>
                <button type="button" className={OUTLINE_BUTTON} onClick={() => onSelect(selectStep(node.id))}
                  aria-label={t('editor.selectStep', { title: node.data.title })}>
                  <NodeTypeIcon type={node.type} className="text-muted" />
                  <span className="truncate">{node.data.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {definition.loops.length > 0 && (
        <section className="space-y-1" aria-label={t('editor.outlineLoops')}>
          <p className="text-[12px] font-semibold text-muted">{t('editor.outlineLoops')}</p>
          <ul className="space-y-0.5">
            {definition.loops.map((loop, index) => (
              <li key={loop.node_ids.join('|')}>
                <button type="button" className={OUTLINE_BUTTON} onClick={() => onSelect(selectLoop(index))}>
                  <Repeat size={14} className="text-aim" aria-hidden="true" />
                  <span className="truncate">
                    {t('editor.loopFrameLabel', { n: index + 1, until: t(`loopUntil.${loop.until}`), rounds: loop.max_rounds })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function WorkflowDetails({ definition, readOnly, onChange, onSelect }: Readonly<WorkflowDetailsProps>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted">{t('editor.nothingSelected')}</p>
      <LabeledField label={t('editor.fields.workflowName')}>
        {(id) => (
          <input id={id} className="input w-full" disabled={readOnly} maxLength={API_WORKFLOW_LIMITS.maxNameChars} value={definition.name}
            onChange={(e) => onChange({ ...definition, name: e.target.value })} />
        )}
      </LabeledField>
      <LabeledField label={t('editor.fields.description')}>
        {(id) => (
          <textarea id={id} rows={4} className="input w-full resize-y" disabled={readOnly}
            maxLength={API_WORKFLOW_LIMITS.maxDescriptionChars} value={definition.description ?? ''}
            onChange={(e) => onChange(withDescription(definition, e.target.value))} />
        )}
      </LabeledField>
      <Outline definition={definition} onSelect={onSelect} />
    </div>
  )
}
