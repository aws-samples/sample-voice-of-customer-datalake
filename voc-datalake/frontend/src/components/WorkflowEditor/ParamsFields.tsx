/**
 * @fileoverview The type-specific settings of one step (`data.params`): review
 * / revise target, end status, web search, number of generated personas. The
 * values offered are the ones `lambda/shared/workflow_schema.py` accepts.
 *
 * @module components/WorkflowEditor/ParamsFields
 */
import { useTranslation } from 'react-i18next'
import { END_STATUSES, REVIEW_TARGETS } from '../../api/workflowsApi'
import { LabeledField } from '../LabeledField/LabeledField'
import type { WorkflowNode } from '../../api/workflowsApi'

/** Upper bound of `generate_personas` params.max_new (the agent form caps personas the same way). */
const MAX_GENERATED_PERSONAS = 5
/** What a `generate_personas` step without `max_new` generates (the palette default). */
const DEFAULT_GENERATED_PERSONAS = 3

interface ParamsFieldsProps {
  node: WorkflowNode
  readOnly: boolean
  onParams: (params: Record<string, unknown>) => void
}

export function ParamsFields({ node, readOnly, onParams }: Readonly<ParamsFieldsProps>) {
  const { t } = useTranslation('agents')
  const params = node.data.params ?? {}
  const set = (key: string, value: unknown) => {
    const next = Object.fromEntries(Object.entries(params).filter(([k]) => k !== key))
    onParams(value === '' ? next : { ...next, [key]: value })
  }
  if (node.type === 'persona_review' || node.type === 'revise_document') {
    return (
      <LabeledField label={t('editor.params.target')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={typeof params.target === 'string' ? params.target : ''}
            onChange={(e) => set('target', e.target.value)}>
            {node.type === 'revise_document' && <option value="">{t('editor.params.targetAny')}</option>}
            {REVIEW_TARGETS.map((target) => <option key={target} value={target}>{t(`reviewTargets.${target}`)}</option>)}
          </select>
        )}
      </LabeledField>
    )
  }
  if (node.type === 'end') {
    return (
      <LabeledField label={t('editor.params.endStatus')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={typeof params.status === 'string' ? params.status : 'completed'}
            onChange={(e) => set('status', e.target.value)}>
            {END_STATUSES.map((status) => <option key={status} value={status}>{t(`endStatuses.${status}`)}</option>)}
          </select>
        )}
      </LabeledField>
    )
  }
  if (node.type === 'deep_research') {
    return (
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={readOnly} checked={params.use_web_search === true}
          onChange={(e) => set('use_web_search', e.target.checked)} />
        {t('editor.params.useWebSearch')}
      </label>
    )
  }
  if (node.type === 'generate_personas') {
    return (
      <LabeledField label={t('editor.params.maxNew')}>
        {(id) => (
          <input id={id} type="number" min={0} max={MAX_GENERATED_PERSONAS} className="input w-full" disabled={readOnly}
            value={typeof params.max_new === 'number' ? params.max_new : DEFAULT_GENERATED_PERSONAS}
            onChange={(e) => set('max_new', Math.max(0, Math.min(MAX_GENERATED_PERSONAS, Math.trunc(Number(e.target.value) || 0))))} />
        )}
      </LabeledField>
    )
  }
  return null
}
