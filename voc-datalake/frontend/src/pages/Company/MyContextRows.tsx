/**
 * @fileoverview The rows of "My objectives & KPIs": one objective (title, due
 * date, description, KPIs) and one KPI (name, target, unit). A field Save would
 * be refused for — by the form's own check or by the server — is marked
 * `aria-invalid` and says why right under it (`aria-describedby`).
 *
 * @module pages/Company/MyContextRows
 */
import { useId } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Plus, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import type { Kpi, PersonalObjective } from '../../api/companyContextApi'
import { kpiFieldKey, objectiveFieldKey } from './myContextValidation'
import type { FieldErrors, FieldProblem, KpiField } from './myContextValidation'

const MAX_KPIS = 10

function problemText(problem: FieldProblem, t: TFunction<'settings'>): string {
  switch (problem.code) {
    case 'required': return t('myContext.fieldRequired')
    case 'tooLong': return t('myContext.fieldTooLong', { max: problem.max })
    case 'server': return problem.text
  }
}

function FieldMessage({ id, problem }: Readonly<{ id: string; problem: FieldProblem }>) {
  const { t } = useTranslation('settings')
  return <p id={id} className="text-xs text-danger mt-1">{problemText(problem, t)}</p>
}

/** One text input with its label (visually its placeholder) and, when invalid, the reason under it. */
function Field({ label, value, onChange, problem, className, multiline = false }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  problem: FieldProblem | undefined
  className?: string
  multiline?: boolean
}>) {
  const messageId = useId()
  const common = {
    'aria-label': label,
    placeholder: label,
    value,
    'aria-invalid': problem !== undefined,
    'aria-describedby': problem === undefined ? undefined : messageId,
    className: clsx('input w-full', problem && 'border-danger'),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  }
  return (
    <div className={className}>
      {multiline ? <textarea rows={2} {...common} /> : <input {...common} />}
      {problem === undefined ? null : <FieldMessage id={messageId} problem={problem} />}
    </div>
  )
}

export function PersonalObjectiveRow({ index, objective, errors, onChange, onRemove }: Readonly<{
  index: number
  objective: PersonalObjective
  errors: FieldErrors
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
      <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
        <Field label={t('myContext.objectiveTitle')} value={objective.title} className="flex-1"
          problem={errors.get(objectiveFieldKey(objective.id, 'title'))} onChange={(title) => patch({ title })} />
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
      <Field label={t('myContext.objectiveDescription')} value={objective.description} multiline
        problem={errors.get(objectiveFieldKey(objective.id, 'description'))} onChange={(description) => patch({ description })} />
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted">{t('myContext.kpis')}</p>
        {objective.kpis.map((kpi, i) => (
          <KpiRow key={i} kpi={kpi} problemOf={(field) => errors.get(kpiFieldKey(objective.id, i, field))}
            onChange={(fields) => setKpi(i, fields)} onRemove={() => removeKpi(i)} />
        ))}
        <button type="button" onClick={addKpi} disabled={objective.kpis.length >= MAX_KPIS} className="btn btn-ghost btn-sm flex items-center gap-1.5">
          <Plus size={14} /> {t('myContext.addKpi')}
        </button>
      </div>
    </fieldset>
  )
}

function KpiRow({ kpi, problemOf, onChange, onRemove }: Readonly<{
  kpi: Kpi
  problemOf: (field: KpiField) => FieldProblem | undefined
  onChange: (fields: Partial<Kpi>) => void
  onRemove: () => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
      <Field label={t('myContext.kpiName')} value={kpi.name} className="flex-1" problem={problemOf('name')}
        onChange={(name) => onChange({ name })} />
      <Field label={t('myContext.kpiTarget')} value={kpi.target} className="sm:w-40" problem={problemOf('target')}
        onChange={(target) => onChange({ target })} />
      <Field label={t('myContext.kpiUnit')} value={kpi.unit ?? ''} className="sm:w-28" problem={problemOf('unit')}
        onChange={(unit) => onChange({ unit: unit === '' ? undefined : unit })} />
      <button type="button" onClick={onRemove} className="icon-btn self-end sm:self-center" aria-label={t('myContext.removeKpi')} title={t('myContext.removeKpi')}>
        <X size={16} />
      </button>
    </div>
  )
}
