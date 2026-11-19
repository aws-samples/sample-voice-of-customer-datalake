/**
 * @fileoverview The Results filters (UX §10.1): the range, the language, the ending, "+ Filter" for a hidden field's
 * value (each active one a removable chip), and "Include test responses" (never remembered: the page's own state).
 *
 * @module pages/FeedbackForms/results/ResultsFilterBar
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import { languageNames } from '../../../i18n/languages'
import type { FormV2 } from '../model/formsV2'
import { endingTitle } from './answers'
import { RANGES } from './resultFilters'
import type { Range, ViewFilters } from './resultFilters'

function HiddenFilterAdder({ form, filters, onChange }: Readonly<{ form: FormV2; filters: ViewFilters; onChange: (filters: ViewFilters) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const free = form.hidden_fields.filter((field) => filters.hidden[field.id] === undefined)
  const [open, setOpen] = useState(false)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  if (free.length === 0) return null
  const chosen = free.some((entry) => entry.id === field) ? field : free[0]?.id ?? ''
  const add = () => {
    if (value.trim() === '') return
    onChange({ ...filters, hidden: { ...filters.hidden, [chosen]: value.trim() } })
    setOpen(false)
    setValue('')
  }
  if (!open) {
    return <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}><Plus size={14} aria-hidden="true" />{t('results.filters.add')}</button>
  }
  return (
    <span className="flex flex-wrap items-center gap-2" role="group" aria-label={t('results.filters.addLabel')}>
      <label htmlFor={`${id}-field`} className="sr-only">{t('results.filters.field')}</label>
      <select id={`${id}-field`} className="select select-sm w-auto" value={chosen} onChange={(event) => setField(event.target.value)}>
        {free.map((entry) => <option key={entry.id} value={entry.id}>{entry.label === undefined || entry.label === '' ? entry.id : `${entry.label} (${entry.id})`}</option>)}
      </select>
      <label htmlFor={`${id}-value`} className="sr-only">{t('results.filters.value')}</label>
      <input id={`${id}-value`} className="input w-40 py-1" value={value} placeholder={t('results.filters.value')}
        onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
      <button type="button" className="btn btn-primary btn-sm" disabled={value.trim() === ''} onClick={add}>{t('results.filters.apply')}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>{t('results.filters.cancel')}</button>
    </span>
  )
}

export default function ResultsFilterBar({ form, filters, onChange, includeTest, onIncludeTest }: Readonly<{
  form: FormV2
  filters: ViewFilters
  onChange: (filters: ViewFilters) => void
  includeTest: boolean
  onIncludeTest: (on: boolean) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const rangeNames: Readonly<Record<Range, string>> = {
    '7': t('results.filters.days7'), '30': t('results.filters.days30'), '90': t('results.filters.days90'), all: t('results.filters.all'),
  }
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-range`} className="sr-only">{t('results.filters.range')}</label>
        <select id={`${id}-range`} className="select select-sm w-auto" value={filters.range}
          onChange={(event) => onChange({ ...filters, range: RANGES.find((range) => range === event.target.value) ?? filters.range })}>
          {RANGES.map((range) => <option key={range} value={range}>{rangeNames[range]}</option>)}
        </select>
        <label htmlFor={`${id}-language`} className="sr-only">{t('results.filters.language')}</label>
        <select id={`${id}-language`} className="select select-sm w-auto" value={filters.language} onChange={(event) => onChange({ ...filters, language: event.target.value })}>
          <option value="">{t('results.filters.allLanguages')}</option>
          {form.languages.map((language) => <option key={language} value={language} lang={language}>{languageNames[language]}</option>)}
        </select>
        <label htmlFor={`${id}-ending`} className="sr-only">{t('results.filters.ending')}</label>
        <select id={`${id}-ending`} className="select select-sm w-auto" value={filters.ending} onChange={(event) => onChange({ ...filters, ending: event.target.value })}>
          <option value="">{t('results.filters.allEndings')}</option>
          {form.endings.map((ending) => <option key={ending.id} value={ending.id}>{endingTitle(form, ending.id)}</option>)}
        </select>
        {Object.entries(filters.hidden).map(([field, value]) => (
          <button key={field} type="button" className="btn btn-secondary btn-sm" aria-label={t('results.filters.remove', { field, value })}
            onClick={() => onChange({ ...filters, hidden: Object.fromEntries(Object.entries(filters.hidden).filter(([other]) => other !== field)) })}>
            <span className="font-mono">{field}</span> = {value}<X size={14} aria-hidden="true" />
          </button>
        ))}
        <HiddenFilterAdder form={form} filters={filters} onChange={onChange} />
      </div>
      <SwitchField label={t('results.includeTest')} checked={includeTest} onChange={onIncludeTest} />
    </div>
  )
}
