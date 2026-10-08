/**
 * @fileoverview Company → My objectives & KPIs.
 *
 * Every user keeps their own objectives (each with KPIs: name, target, unit).
 * They feed that user's personal memory and the assistant, and never touch the
 * company objectives (`PUT /settings/my-context` is self-scoped server-side).
 *
 * @module pages/Company/MyContextSection
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Target, Trash2, X } from 'lucide-react'
import { companyContextApi, myContextKey } from '../../api/companyContextApi'
import type { Kpi, MyContext, PersonalObjective } from '../../api/companyContextApi'
import { newClientId } from '../../api/schemaList'
import { SectionHeader } from './ContextParts'
import { DraftSaveRow, LoadedSection } from './SectionParts'
import { useDraft, useDraftGuard } from './useDraft'

const EMPTY: MyContext = { objectives: [] }
const MAX_PERSONAL_OBJECTIVES = 20
const MAX_KPIS = 10

export default function MyContextSection() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: myContextKey(), queryFn: companyContextApi.getMyContext })
  const draft = useDraft<MyContext>(query.data ?? EMPTY)
  const save = useMutation({
    mutationFn: companyContextApi.saveMyContext,
    onSuccess: (saved) => {
      queryClient.setQueryData(myContextKey(), saved)
      draft.reset()
    },
  })

  const objectives = draft.value.objectives
  const guard = useDraftGuard({ dirty: draft.dirty, reset: draft.reset, save: () => save.mutateAsync(draft.value) })
  const setObjective = (id: string, change: (o: PersonalObjective) => PersonalObjective) =>
    draft.update((c) => ({ objectives: c.objectives.map((o) => (o.id === id ? change(o) : o)) }))
  const addObjective = () => draft.update((c) => ({
    objectives: [...c.objectives, { id: newClientId('pobj'), title: '', description: '', due: undefined, kpis: [] }],
  }))
  const removeObjective = (id: string) => draft.update((c) => ({ objectives: c.objectives.filter((o) => o.id !== id) }))

  return (
    <div className="card">
      <SectionHeader icon={Target} title={t('myContext.title')} description={t('myContext.description')} />
      <LoadedSection query={query}>
        {() => (
          <>
            {objectives.length === 0 ? <p className="text-sm text-muted italic mb-3">{t('myContext.empty')}</p> : null}
            <div className="space-y-3">
              {objectives.map((objective, index) => (
                <PersonalObjectiveRow
                  key={objective.id}
                  index={index}
                  objective={objective}
                  onChange={(change) => setObjective(objective.id, change)}
                  onRemove={() => removeObjective(objective.id)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addObjective}
              disabled={objectives.length >= MAX_PERSONAL_OBJECTIVES}
              className="btn btn-secondary btn-sm flex items-center gap-1.5 mt-3"
            >
              <Plus size={14} /> {t('myContext.addObjective')}
            </button>
            <DraftSaveRow save={save} dirty={draft.dirty} onSave={() => save.mutate(draft.value)} />
          </>
        )}
      </LoadedSection>
      {guard.dialog}
    </div>
  )
}

function PersonalObjectiveRow({ index, objective, onChange, onRemove }: Readonly<{
  index: number
  objective: PersonalObjective
  onChange: (change: (o: PersonalObjective) => PersonalObjective) => void
  onRemove: () => void
}>) {
  const { t } = useTranslation('settings')
  const patch = (fields: Partial<PersonalObjective>) => onChange((o) => ({ ...o, ...fields }))
  const setKpi = (i: number, fields: Partial<Kpi>) =>
    onChange((o) => ({ ...o, kpis: o.kpis.map((k, j) => (j === i ? { ...k, ...fields } : k)) }))
  const addKpi = () => onChange((o) => ({ ...o, kpis: [...o.kpis, { name: '', target: '', unit: undefined }] }))
  const removeKpi = (i: number) => onChange((o) => ({ ...o, kpis: o.kpis.filter((_, j) => j !== i) }))

  return (
    <fieldset className="border border-border rounded-md p-3 space-y-2">
      <legend className="sr-only">{t('myContext.objectiveLegend', { n: index + 1 })}</legend>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          aria-label={t('myContext.objectiveTitle')}
          placeholder={t('myContext.objectiveTitle')}
          value={objective.title}
          onChange={(e) => patch({ title: e.target.value })}
          className="input flex-1"
        />
        <input
          type="date"
          aria-label={t('myContext.due')}
          value={objective.due ?? ''}
          onChange={(e) => patch({ due: e.target.value === '' ? undefined : e.target.value })}
          className="input sm:w-44"
        />
        <button type="button" onClick={onRemove} className="icon-btn self-end sm:self-center" aria-label={t('myContext.removeObjective')} title={t('myContext.removeObjective')}>
          <Trash2 size={16} />
        </button>
      </div>
      <textarea
        aria-label={t('myContext.objectiveDescription')}
        placeholder={t('myContext.objectiveDescription')}
        value={objective.description}
        rows={2}
        onChange={(e) => patch({ description: e.target.value })}
        className="input"
      />
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted">{t('myContext.kpis')}</p>
        {objective.kpis.map((kpi, i) => (
          <KpiRow key={i} kpi={kpi} onChange={(fields) => setKpi(i, fields)} onRemove={() => removeKpi(i)} />
        ))}
        <button type="button" onClick={addKpi} disabled={objective.kpis.length >= MAX_KPIS} className="btn btn-ghost btn-sm flex items-center gap-1.5">
          <Plus size={14} /> {t('myContext.addKpi')}
        </button>
      </div>
    </fieldset>
  )
}

function KpiRow({ kpi, onChange, onRemove }: Readonly<{
  kpi: Kpi
  onChange: (fields: Partial<Kpi>) => void
  onRemove: () => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
      <input aria-label={t('myContext.kpiName')} placeholder={t('myContext.kpiName')} value={kpi.name} onChange={(e) => onChange({ name: e.target.value })} className="input flex-1" />
      <input aria-label={t('myContext.kpiTarget')} placeholder={t('myContext.kpiTarget')} value={kpi.target} onChange={(e) => onChange({ target: e.target.value })} className="input sm:w-32" />
      <input
        aria-label={t('myContext.kpiUnit')}
        placeholder={t('myContext.kpiUnit')}
        value={kpi.unit ?? ''}
        onChange={(e) => onChange({ unit: e.target.value === '' ? undefined : e.target.value })}
        className="input sm:w-28"
      />
      <button type="button" onClick={onRemove} className="icon-btn self-end sm:self-center" aria-label={t('myContext.removeKpi')} title={t('myContext.removeKpi')}>
        <X size={16} />
      </button>
    </div>
  )
}
