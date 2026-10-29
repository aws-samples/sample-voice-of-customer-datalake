/**
 * @fileoverview The type-specific settings of one step (`data.params`): review
 * / revise target, end status, web search, number of generated personas and
 * their portraits, a writing step's word budget (`max_words`). The
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
/** Web searches one agent run may execute across its steps (`MAX_WEB_QUERIES_PER_RUN`, lambda/agents/store.py). */
const MAX_WEB_QUERIES_PER_RUN = 10
/** Step types that search the public web, ON unless `params.use_web_search` is false (lambda/agents/nodes/web.py). */
const WEB_SEARCH_STEPS: ReadonlySet<string> = new Set(['deep_research', 'custom_llm'])
/** Steps that write a PR/FAQ or PRD and read `params.max_words` (lambda/agents/nodes/documents.py). */
const WRITING_STEPS: ReadonlySet<string> = new Set(['write_prfaq', 'write_prd', 'revise_document'])
/** The word budget's bounds (MIN_LENGTH_WORDS / MAX_LENGTH_WORDS, lambda/agents/nodes/documents.py). */
const MIN_WORDS = 200
const MAX_WORDS = 8000

/** A typed budget as stored: a positive whole number capped at MAX_WORDS, 0 = none. The
 * minimum is not forced while typing (it would turn the "1" of "1200" into 200); the agent
 * runtime raises a smaller budget to MIN_WORDS. */
function wordBudget(raw: string): number {
  const words = Math.trunc(Number(raw))
  return Number.isFinite(words) && words > 0 ? Math.min(MAX_WORDS, words) : 0
}

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
  const maxWords = WRITING_STEPS.has(node.type) ? (
    <LabeledField label={t('editor.params.maxWords')}>
      {(id) => (
        <>
          <input id={id} type="number" min={MIN_WORDS} max={MAX_WORDS} step={100} className="input w-full" disabled={readOnly}
            placeholder={t('editor.params.maxWordsNone')}
            value={typeof params.max_words === 'number' ? params.max_words : ''}
            onChange={(e) => set('max_words', wordBudget(e.target.value) || '')} />
          <p className="text-[12px] text-muted">{t('editor.params.maxWordsHint')}</p>
        </>
      )}
    </LabeledField>
  ) : null
  if (node.type === 'persona_review' || node.type === 'revise_document') {
    return (
      <div className="space-y-3">
        <LabeledField label={t('editor.params.target')}>
          {(id) => (
            <select id={id} className="select w-full" disabled={readOnly} value={typeof params.target === 'string' ? params.target : ''}
              onChange={(e) => set('target', e.target.value)}>
              {node.type === 'revise_document' && <option value="">{t('editor.params.targetAny')}</option>}
              {REVIEW_TARGETS.map((target) => <option key={target} value={target}>{t(`reviewTargets.${target}`)}</option>)}
            </select>
          )}
        </LabeledField>
        {maxWords}
      </div>
    )
  }
  if (maxWords) return maxWords
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
  if (WEB_SEARCH_STEPS.has(node.type)) {
    return (
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="accent-accent" disabled={readOnly} checked={params.use_web_search !== false}
            onChange={(e) => set('use_web_search', e.target.checked)} />
          {t('editor.params.useWebSearch')}
        </label>
        <p className="text-[12px] text-muted">{t('editor.params.useWebSearchHint', { limit: MAX_WEB_QUERIES_PER_RUN })}</p>
      </div>
    )
  }
  if (node.type === 'generate_personas') {
    return (
      <div className="space-y-3">
        <LabeledField label={t('editor.params.maxNew')}>
          {(id) => (
            <input id={id} type="number" min={0} max={MAX_GENERATED_PERSONAS} className="input w-full" disabled={readOnly}
              value={typeof params.max_new === 'number' ? params.max_new : DEFAULT_GENERATED_PERSONAS}
              onChange={(e) => set('max_new', Math.max(0, Math.min(MAX_GENERATED_PERSONAS, Math.trunc(Number(e.target.value) || 0))))} />
          )}
        </LabeledField>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="accent-accent" disabled={readOnly} checked={params.generate_avatars !== false}
            onChange={(e) => set('generate_avatars', e.target.checked)} />
          {t('editor.params.generateAvatars')}
        </label>
      </div>
    )
  }
  return null
}
