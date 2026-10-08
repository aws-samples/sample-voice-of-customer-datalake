/**
 * @fileoverview Arrow settings in the editor's side panel:
 * - {@link EdgeForm}: one selected arrow — its condition (pass / fail,
 *   agreed / not agreed, or none = the default path) and Delete;
 * - {@link StepArrows}: a step's outgoing arrows, each with its condition, and
 *   "Add arrow" (target + condition). This is the keyboard path for building a
 *   branch: no handle-to-handle drag is needed to wire a pass/fail split.
 *
 * Which conditions an arrow may carry depends on what its source step reports
 * ({@link edgeLabelsFor}): a persona review says agreed / not agreed, a final
 * review pass / fail; any other step (a custom step included) reports no
 * verdict, so its arrows always run.
 *
 * @module components/WorkflowEditor/ArrowSettings
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { connect, edgeLabelsFor, removeEdges, setEdgeLabel } from './model'
import { LabeledField } from '../LabeledField/LabeledField'
import type { WorkflowDefinition, WorkflowEdge, WorkflowEdgeLabel, WorkflowNode } from '../../api/workflowsApi'

interface ArrowProps {
  definition: WorkflowDefinition
  readOnly: boolean
  onChange: (definition: WorkflowDefinition) => void
}

const NO_CONDITION = ''

/** The conditions offered for an arrow: the source's verdicts, plus a stored label it no longer allows. */
function conditionsFor(definition: WorkflowDefinition, edge: WorkflowEdge | null, sourceId: string): readonly WorkflowEdgeLabel[] {
  const allowed = edgeLabelsFor(definition.nodes.find((n) => n.id === sourceId)?.type)
  const current = edge?.label
  return current === undefined || allowed.includes(current) ? allowed : [...allowed, current]
}

const titleOf = (definition: WorkflowDefinition, id: string): string => definition.nodes.find((n) => n.id === id)?.data.title ?? id

function ConditionSelect({ id, labels, value, disabled, onPick }: Readonly<{
  id: string; labels: readonly WorkflowEdgeLabel[]; value: WorkflowEdgeLabel | undefined; disabled: boolean
  onPick: (label: WorkflowEdgeLabel | undefined) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <select id={id} className="select w-full" disabled={disabled} value={value ?? NO_CONDITION}
      onChange={(e) => onPick(labels.find((l) => l === e.target.value))}>
      <option value={NO_CONDITION}>{t('editor.fields.labelNone')}</option>
      {labels.map((label) => <option key={label} value={label}>{t(`edgeLabels.${label}`)}</option>)}
    </select>
  )
}

/** A labelled condition picker for a stored arrow: picking writes the arrow's label. */
function EdgeConditionField({ definition, edge, labels, label, hint, readOnly, onChange }: Readonly<ArrowProps & {
  edge: WorkflowEdge; labels: readonly WorkflowEdgeLabel[]; label: string; hint?: string
}>) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => (
        <ConditionSelect id={id} labels={labels} value={edge.label} disabled={readOnly}
          onPick={(picked) => onChange(setEdgeLabel(definition, edge.id, picked))} />
      )}
    </LabeledField>
  )
}

export function EdgeForm({ definition, edgeId, readOnly, onChange }: Readonly<ArrowProps & { edgeId: string }>) {
  const { t } = useTranslation('agents')
  const edge = definition.edges.find((e) => e.id === edgeId)
  if (edge === undefined) return null
  const labels = conditionsFor(definition, edge, edge.source)
  return (
    <div className="space-y-3">
      <p className="text-[12px] font-medium text-muted">{t('editor.arrow')}</p>
      <p className="text-sm text-text">{titleOf(definition, edge.source)} → {titleOf(definition, edge.target)}</p>
      {labels.length > 0 ? (
        <EdgeConditionField definition={definition} edge={edge} labels={labels} label={t('editor.fields.label')}
          hint={t('editor.conditionHint')} readOnly={readOnly} onChange={onChange} />
      ) : (
        <p className="text-[12px] text-muted">{t('editor.noConditions')}</p>
      )}
      {!readOnly && (
        <button type="button" className="btn btn-danger btn-sm" onClick={() => onChange(removeEdges(definition, new Set([edge.id])))}>
          <Trash2 size={14} aria-hidden="true" /> {t('editor.deleteArrow')}
        </button>
      )}
    </div>
  )
}

function OutgoingArrow({ definition, edge, labels, readOnly, onChange }: Readonly<ArrowProps & {
  edge: WorkflowEdge; labels: readonly WorkflowEdgeLabel[]
}>) {
  const { t } = useTranslation('agents')
  const target = titleOf(definition, edge.target)
  return (
    <li className="space-y-1 rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-text" title={target}>→ {target}</span>
        {!readOnly && (
          <button type="button" className="icon-btn focus-ring" aria-label={t('editor.deleteArrowTo', { target })}
            onClick={() => onChange(removeEdges(definition, new Set([edge.id])))}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {labels.length > 0 && (
        <EdgeConditionField definition={definition} edge={edge} labels={labels} label={t('editor.conditionTo', { target })}
          readOnly={readOnly} onChange={onChange} />
      )}
    </li>
  )
}

/** Steps a new arrow from `source` may point at: not itself, not the start, not an existing target. */
function arrowTargets(definition: WorkflowDefinition, source: WorkflowNode): WorkflowNode[] {
  const taken = new Set(definition.edges.filter((e) => e.source === source.id).map((e) => e.target))
  return definition.nodes.filter((n) => n.id !== source.id && n.type !== 'start' && !taken.has(n.id))
}

function AddArrow({ definition, node, labels, onChange }: Readonly<Omit<ArrowProps, 'readOnly'> & {
  node: WorkflowNode; labels: readonly WorkflowEdgeLabel[]
}>) {
  const { t } = useTranslation('agents')
  const targets = arrowTargets(definition, node)
  const [target, setTarget] = useState('')
  const [condition, setCondition] = useState<WorkflowEdgeLabel | undefined>(undefined)
  const chosen = targets.find((n) => n.id === target)
  if (targets.length === 0) return <p className="text-[12px] text-muted">{t('editor.noArrowTargets')}</p>
  const add = () => {
    if (chosen === undefined) return
    onChange(connect(definition, node.id, chosen.id, condition ?? null))
    setTarget('')
    setCondition(undefined)
  }
  return (
    <fieldset className="space-y-2 rounded-md border border-dashed border-border px-2 py-2">
      <legend className="px-1 text-[12px] font-medium text-muted">{t('editor.addArrow')}</legend>
      <LabeledField label={t('editor.fields.arrowTarget')}>
        {(id) => (
          <select id={id} className="select w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t('editor.fields.arrowTargetNone')}</option>
            {targets.map((n) => <option key={n.id} value={n.id}>{n.data.title}</option>)}
          </select>
        )}
      </LabeledField>
      {labels.length > 0 && (
        <LabeledField label={t('editor.fields.label')}>
          {(id) => <ConditionSelect id={id} labels={labels} value={condition} disabled={false} onPick={setCondition} />}
        </LabeledField>
      )}
      <button type="button" className="btn btn-secondary btn-sm" disabled={chosen === undefined} onClick={add}>
        <Plus size={14} aria-hidden="true" /> {t('editor.addArrowButton')}
      </button>
    </fieldset>
  )
}

/** The arrows leaving `node`, each editable, and "Add arrow". */
export function StepArrows({ definition, node, readOnly, onChange }: Readonly<ArrowProps & { node: WorkflowNode }>) {
  const { t } = useTranslation('agents')
  if (node.type === 'end') return null
  const outgoing = definition.edges.filter((e) => e.source === node.id)
  const labels = edgeLabelsFor(node.type)
  return (
    <section className="space-y-2 border-t border-border pt-3" aria-label={t('editor.arrowsOut')}>
      <p className="text-[12px] font-semibold text-muted">{t('editor.arrowsOut')}</p>
      {labels.length === 0 && <p className="text-[12px] text-muted">{t('editor.noConditions')}</p>}
      {outgoing.length === 0 ? (
        <p className="text-[12px] text-muted">{t('editor.noArrowsOut')}</p>
      ) : (
        <ul className="space-y-1.5">
          {outgoing.map((edge) => (
            <OutgoingArrow key={edge.id} definition={definition} edge={edge}
              labels={conditionsFor(definition, edge, node.id)} readOnly={readOnly} onChange={onChange} />
          ))}
        </ul>
      )}
      {!readOnly && <AddArrow key={node.id} definition={definition} node={node} labels={labels} onChange={onChange} />}
    </section>
  )
}
