/**
 * @fileoverview The agent configuration tabs: Settings (name, description,
 * scope, workflow, hand-off visibility), Instructions, Models and Budget. Each
 * edits the shared draft; the detail page saves the changed fields.
 *
 * @module pages/Agents/AgentSections
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { AGENT_MODEL_ROLES, AGENT_VISIBILITIES, API_AGENT_LIMITS } from '../../api/agentsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { useVisibleCategories } from '../../hooks/useCategories'
import { clampInt } from './agentDraft'
import type { AgentDraft } from './agentDraft'

export interface SectionProps {
  draft: AgentDraft
  readOnly: boolean
  onChange: (draft: AgentDraft) => void
}

function ScopePicker({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const { categories } = useVisibleCategories()
  const { scope } = draft
  const setScope = (next: AgentDraft['scope']) => onChange({ ...draft, scope: next })
  const toggleCategory = (name: string, on: boolean) => setScope({
    ...scope, all: false,
    categories: on ? [...scope.categories, name] : scope.categories.filter((c) => c !== name),
  })
  const toggleSub = (category: string, name: string, on: boolean) => setScope({
    ...scope, all: false,
    subcategories: on
      ? [...scope.subcategories, { category, name }]
      : scope.subcategories.filter((s) => !(s.category === category && s.name === name)),
  })
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted">{t('fields.scope')}</legend>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={readOnly} checked={scope.all}
          onChange={(e) => setScope({ all: e.target.checked, categories: [], subcategories: [] })} />
        {t('scope.all')}
      </label>
      {!scope.all && (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {categories.map((category) => (
            <li key={category.id} className="rounded-md border border-border px-2.5 py-1.5">
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" className="accent-accent" disabled={readOnly} checked={scope.categories.includes(category.name)}
                  onChange={(e) => toggleCategory(category.name, e.target.checked)} />
                {category.name}
              </label>
              {!scope.categories.includes(category.name) && category.subcategories.length > 0 && (
                <ul className="mt-1 ml-5 space-y-0.5">
                  {category.subcategories.map((sub) => (
                    <li key={sub.id}>
                      <label className="flex items-center gap-2 text-[12px] text-muted">
                        <input type="checkbox" className="accent-accent" disabled={readOnly}
                          checked={scope.subcategories.some((s) => s.category === category.name && s.name === sub.name)}
                          onChange={(e) => toggleSub(category.name, sub.name, e.target.checked)} />
                        {sub.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

export function SettingsSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const { data: workflows } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list })
  return (
    <div className="space-y-4">
      <LabeledField label={t('fields.name')}>
        {(id) => <input id={id} className="input w-full" disabled={readOnly} value={draft.name}
          maxLength={API_AGENT_LIMITS.maxNameChars} onChange={(e) => onChange({ ...draft, name: e.target.value })} />}
      </LabeledField>
      <LabeledField label={t('fields.description')}>
        {(id) => <textarea id={id} rows={3} className="input w-full" disabled={readOnly} value={draft.description}
          maxLength={API_AGENT_LIMITS.maxDescriptionChars} onChange={(e) => onChange({ ...draft, description: e.target.value })} />}
      </LabeledField>
      <ScopePicker draft={draft} readOnly={readOnly} onChange={onChange} />
      <LabeledField label={t('fields.workflow')} hint={t('fields.workflowHint')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={draft.workflow_id ?? ''}
            onChange={(e) => onChange({ ...draft, workflow_id: e.target.value === '' ? null : e.target.value })}>
            {draft.workflow_id === null && <option value="">{t('fields.workflowDefault')}</option>}
            {(workflows ?? []).map((w) => (
              <option key={w.workflow_id} value={w.workflow_id}>{w.name} · r{w.revision}</option>
            ))}
          </select>
        )}
      </LabeledField>
      <LabeledField label={t('fields.visibility')} hint={t('fields.visibilityHint')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={draft.output.visibility}
            onChange={(e) => {
              const visibility = AGENT_VISIBILITIES.find((v) => v === e.target.value)
              if (visibility !== undefined) onChange({ ...draft, output: { visibility } })
            }}>
            {AGENT_VISIBILITIES.map((v) => <option key={v} value={v}>{t(`visibility.${v}`)}</option>)}
          </select>
        )}
      </LabeledField>
    </div>
  )
}

export function InstructionsSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  return (
    <LabeledField label={t('fields.instructions')} hint={t('fields.instructionsHint', { n: API_AGENT_LIMITS.maxInstructionsChars })}>
      {(id) => <textarea id={id} rows={14} className="input w-full font-mono text-[13px]" disabled={readOnly}
        value={draft.instructions} maxLength={API_AGENT_LIMITS.maxInstructionsChars}
        onChange={(e) => onChange({ ...draft, instructions: e.target.value })} />}
    </LabeledField>
  )
}

export function ModelsSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const { data } = useQuery({ queryKey: ['model-settings'], queryFn: () => api.getModelSettings(), retry: false })
  const models = data?.available_models ?? []
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted">{t('models.hint')}</p>
      {AGENT_MODEL_ROLES.map((role) => (
        <LabeledField key={role} label={t(`roles.${role}`)} hint={t(`models.roleHint.${role}`)}>
          {(id) => (
            <select id={id} className="select w-full" disabled={readOnly} value={draft.models[role] ?? ''}
              onChange={(e) => onChange({ ...draft, models: { ...draft.models, [role]: e.target.value === '' ? null : e.target.value } })}>
              <option value="">{t('models.default')}</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
        </LabeledField>
      ))}
    </div>
  )
}

export function BudgetSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const L = API_AGENT_LIMITS
  const budget = draft.budget
  const cap = budget.monthly_call_cap
  return (
    <div className="space-y-4">
      <LabeledField label={t('budget.runsPerDay')} hint={t('budget.runsPerDayHint')}>
        {(id) => <input id={id} type="number" className="input w-full" disabled={readOnly} min={0} max={L.maxScheduledRunsPerDay}
          value={budget.max_scheduled_runs_per_day ?? L.maxScheduledRunsPerDay}
          onChange={(e) => onChange({ ...draft, budget: { ...budget, max_scheduled_runs_per_day: clampInt(e.target.value, 0, L.maxScheduledRunsPerDay, 0) } })} />}
      </LabeledField>
      <LabeledField label={t('budget.callsPerRun')}>
        {(id) => <input id={id} type="number" className="input w-full" disabled={readOnly}
          min={L.minModelCallsPerRun} max={L.maxModelCallsPerRun} value={budget.max_model_calls_per_run ?? 150}
          onChange={(e) => onChange({ ...draft, budget: { ...budget, max_model_calls_per_run: clampInt(e.target.value, L.minModelCallsPerRun, L.maxModelCallsPerRun, L.minModelCallsPerRun) } })} />}
      </LabeledField>
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={readOnly} checked={cap === null}
          onChange={(e) => onChange({ ...draft, budget: { ...budget, monthly_call_cap: e.target.checked ? null : 5000 } })} />
        {t('budget.uncapped')}
      </label>
      {cap !== null && (
        <LabeledField label={t('budget.monthlyCap')} hint={t('budget.monthlyCapHint')}>
          {(id) => <input id={id} type="number" className="input w-full" disabled={readOnly} min={0} max={L.maxMonthlyCallCap}
            value={cap ?? 0}
            onChange={(e) => onChange({ ...draft, budget: { ...budget, monthly_call_cap: clampInt(e.target.value, 0, L.maxMonthlyCallCap, 0) } })} />}
        </LabeledField>
      )}
    </div>
  )
}
