/**
 * @fileoverview The agent configuration tabs: Settings (name, description,
 * scope, workflow, hand-off visibility), Instructions, Models and Budget. Each
 * edits the shared draft; the detail page saves the changed fields. An
 * engineering agent (7.47.00) picks an engineering flow, keeps shorter
 * instructions (the trusted start of its run's goal) and has only its runs per
 * day as a budget here: what a run spends is its flow's monthly budget.
 *
 * @module pages/Agents/AgentSections
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { AGENT_MODEL_ROLES, AGENT_VISIBILITIES } from '@stream/assistant/tools/agent-limits'
import { API_AGENT_LIMITS, API_ENGINEERING_LIMITS } from '../../api/agentsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { EnumSelectField } from '../../components/LabeledField/EnumSelectField'
import PromptField from '../../components/Document/text/PromptField'
import { ClampedNumberField } from './ClampedNumberField'
import { useVisibleCategories } from '../../hooks/useCategories'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { useSourceProfiles } from '../../hooks/useDimensions'
import { BUILT_IN_SOURCES } from '../../utils/displayLabels'
import type { AgentDraft } from './agentDraft'
import { modelSettingsKey } from '../../api/queryKeys'

export interface SectionProps {
  draft: AgentDraft
  readOnly: boolean
  onChange: (draft: AgentDraft) => void
  /** An engineering agent's (its `engineering` settings): its own workflows, instructions and budget. */
  engineering?: boolean
}

/** A scope picker's props: the draft alone (the same for either kind of agent). */
type PickerProps = Omit<SectionProps, 'engineering'>

/**
 * "Only these sources" (`scope.sources`): the deployment's sources (an agent reads the deployment's feedback),
 * none ticked for every source. A threshold trigger counts every source, so the Triggers tab offers none with it.
 */
function SourcesPicker({ draft, readOnly, onChange }: Readonly<PickerProps>) {
  const { t } = useTranslation('agents')
  const labels = useDisplayLabels()
  const { data: profiles } = useSourceProfiles('deployment')
  const picked = draft.scope.sources ?? []
  const ids = [...new Set([...Object.keys(BUILT_IN_SOURCES), ...(profiles ?? []).map((p) => p.id), ...picked])]
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...picked, id] : picked.filter((s) => s !== id)
    const { all, categories, subcategories } = draft.scope
    onChange({ ...draft, scope: next.length > 0 ? { all, categories, subcategories, sources: next } : { all, categories, subcategories } })
  }
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] font-medium text-muted">{t('scope.sources')}</legend>
      <p className="text-[12px] text-muted">{t('scope.sourcesHint')}</p>
      <ul className="grid gap-1 sm:grid-cols-3">
        {ids.map((id) => (
          <li key={id}>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" className="accent-accent" disabled={readOnly || (!picked.includes(id)
                && picked.length >= API_ENGINEERING_LIMITS.maxScopeSources)}
                checked={picked.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
              {labels.source(id)}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}

function ScopePicker({ draft, readOnly, onChange }: Readonly<PickerProps>) {
  const { t } = useTranslation('agents')
  const { categories } = useVisibleCategories()
  const labels = useDisplayLabels()
  const { scope } = draft
  // (the sources are their own picker's: a change of categories keeps them)
  const setScope = (next: AgentDraft['scope']) => onChange({
    ...draft, scope: scope.sources === undefined ? next : { ...next, sources: scope.sources },
  })
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
                {labels.category(category.name)}
              </label>
              {!scope.categories.includes(category.name) && category.subcategories.length > 0 && (
                <ul className="mt-1 ml-5 space-y-0.5">
                  {category.subcategories.map((sub) => (
                    <li key={sub.id}>
                      <label className="flex items-center gap-2 text-[12px] text-muted">
                        <input type="checkbox" className="accent-accent" disabled={readOnly}
                          checked={scope.subcategories.some((s) => s.category === category.name && s.name === sub.name)}
                          onChange={(e) => toggleSub(category.name, sub.name, e.target.checked)} />
                        {labels.subcategory(sub.name, category.name)}
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

export function SettingsSection({ draft, readOnly, onChange, engineering = false }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const { data: workflows } = useQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list })
  // An engineering agent runs an engineering flow; any other agent an agents workflow (the server holds both).
  const kind = engineering ? 'engineering' : 'agents'
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
      <SourcesPicker draft={draft} readOnly={readOnly} onChange={onChange} />
      {engineering && <p className="text-[12px] text-muted">{t('engineeringAgent.deploymentFeedback')}</p>}
      <LabeledField label={t('fields.workflow')} hint={t('fields.workflowHint')}>
        {(id) => (
          <select id={id} className="select w-full" disabled={readOnly} value={draft.workflow_id ?? ''}
            onChange={(e) => onChange({ ...draft, workflow_id: e.target.value === '' ? null : e.target.value })}>
            {draft.workflow_id === null && !engineering && <option value="">{t('fields.workflowDefault')}</option>}
            {(workflows ?? []).filter((w) => w.kind === kind).map((w) => (
              <option key={w.workflow_id} value={w.workflow_id}>{w.name} · r{w.revision}</option>
            ))}
          </select>
        )}
      </LabeledField>
      <EnumSelectField label={t('fields.visibility')} hint={t('fields.visibilityHint')} choices={AGENT_VISIBILITIES}
        value={draft.output.visibility} display={(v) => t(`visibility.${v}`)} disabled={readOnly}
        onChange={(visibility) => onChange({ ...draft, output: { visibility } })} />
    </div>
  )
}

export function InstructionsSection({ draft, readOnly, onChange, engineering = false }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const max = engineering ? API_ENGINEERING_LIMITS.maxInstructionsChars : API_AGENT_LIMITS.maxInstructionsChars
  const hint = engineering ? t('fields.engineeringInstructionsHint', { n: max }) : t('fields.instructionsHint', { n: max })
  // A prompt the automation's Save writes (§6.4 step 7): edited as written with its count, read only as text.
  return (
    <PromptField label={t('fields.instructions')} hint={hint} value={draft.instructions} readOnly={readOnly} maxChars={max}
      onChange={(instructions) => onChange({ ...draft, instructions })} />
  )
}

export function ModelsSection({ draft, readOnly, onChange }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const { data } = useQuery({ queryKey: modelSettingsKey(), queryFn: () => api.getModelSettings(), retry: false })
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

export function BudgetSection({ draft, readOnly, onChange, engineering = false }: Readonly<SectionProps>) {
  const { t } = useTranslation('agents')
  const L = API_AGENT_LIMITS
  const budget = draft.budget
  const cap = budget.monthly_call_cap
  if (engineering) {
    const E = API_ENGINEERING_LIMITS
    return (
      <div className="space-y-4">
        <ClampedNumberField label={t('budget.runsPerDay')} hint={t('budget.engineeringRunsPerDayHint', { n: E.maxRunsPerDay })}
          readOnly={readOnly} min={0} max={E.maxRunsPerDay} value={budget.max_scheduled_runs_per_day ?? E.defaultRunsPerDay}
          onChange={(n) => onChange({ ...draft, budget: { ...budget, max_scheduled_runs_per_day: n } })} />
        <p className="text-[12px] text-muted">{t('budget.engineeringSpend')}</p>
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <ClampedNumberField label={t('budget.runsPerDay')} hint={t('budget.runsPerDayHint')} readOnly={readOnly}
        min={0} max={L.maxScheduledRunsPerDay} value={budget.max_scheduled_runs_per_day ?? L.maxScheduledRunsPerDay}
        onChange={(n) => onChange({ ...draft, budget: { ...budget, max_scheduled_runs_per_day: n } })} />
      <ClampedNumberField label={t('budget.callsPerRun')} readOnly={readOnly}
        min={L.minModelCallsPerRun} max={L.maxModelCallsPerRun} value={budget.max_model_calls_per_run ?? 150}
        onChange={(n) => onChange({ ...draft, budget: { ...budget, max_model_calls_per_run: n } })} />
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={readOnly} checked={cap === null}
          onChange={(e) => onChange({ ...draft, budget: { ...budget, monthly_call_cap: e.target.checked ? null : 5000 } })} />
        {t('budget.uncapped')}
      </label>
      {cap !== null && (
        <ClampedNumberField label={t('budget.monthlyCap')} hint={t('budget.monthlyCapHint')} readOnly={readOnly}
          min={0} max={L.maxMonthlyCallCap} value={cap ?? 0}
          onChange={(n) => onChange({ ...draft, budget: { ...budget, monthly_call_cap: n } })} />
      )}
    </div>
  )
}
