/**
 * @fileoverview Compare (7.63.00): this form beside up to 10 others of the workspace (the forms made from the same
 * template first: their question ids are the template's), each split by a hidden field if asked (the event date, the
 * customer; one form split on its own is the Report's segments). Each question is matched by id and what its figures
 * mean; a point under 5 responses keeps its figures to itself (and the smallest named point beside it, so the totals
 * cannot give it away), and a form that asks a question differently, or not at all, says so.
 *
 * @module pages/FeedbackForms/report/ComparePanel
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../api/client'
import { feedbackFormsKey } from '../../../api/feedbackFormQueryKeys'
import type { FormComparison } from '../../../api/feedbackFormsReport'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import type { FeedbackForm } from '../../../api/types'
import { formatCount } from '../../../utils/numberFormat'
import type { FormV2 } from '../model/formsV2'
import { figureText, rowAveragesText } from './reportLabels'
import { useFormComparison } from './useFormReport'

const MAX_COMPARED = 10

/** The forms that may be compared with this one: the template's siblings first, then by name (no prototype pin). */
function candidates(forms: readonly FeedbackForm[], formId: string, templateId: string | undefined): FeedbackForm[] {
  const rank = (form: FeedbackForm) => (templateId !== undefined && form.template?.id === templateId ? 0 : 1)
  return forms.filter((form) => form.form_id !== formId && form.form_type !== 'prototype_pin')
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** The comparison once asked for: its table, a failure, or that it is loading. */
function ComparisonState({ form, comparison, failed }: Readonly<{ form: FormV2; comparison: FormComparison | undefined; failed: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  if (comparison !== undefined) return <ComparisonTable form={form} comparison={comparison} />
  return failed ? <p role="alert" className="text-sm text-danger">{t('report.compare.failed')}</p>
    : <p role="status" className="text-sm text-muted">{t('report.loading')}</p>
}

function ComparisonTable({ form, comparison }: Readonly<{ form: FormV2; comparison: FormComparison }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const names = new Map(comparison.forms.map((entry) => [entry.form_id, entry]))
  const pointName = (formId: string, value: string | null, merged: boolean | undefined) => {
    const name = names.get(formId)?.name ?? formId
    if (merged === true) return `${name} · ${t('report.compare.merged', { minimum: comparison.min_size })}`
    if (value === null) return name
    return `${name} · ${value === '' ? t('report.segments.noValue') : value}`
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('report.compare.caption')}</caption>
        <thead className="text-[12px] text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t('report.compare.point')}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t('report.segments.responses')}</th>
            {comparison.questions.map((question) => <th key={question.id} scope="col" className="px-3 py-2 font-medium">{question.headline || question.id}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {comparison.points.map((point) => {
            const unmatched = names.get(point.form_id)?.unmatched ?? {}
            return (
              <tr key={`${point.form_id}#${point.value ?? ''}#${String(point.merged ?? false)}`}>
                <th scope="row" className="px-3 py-2 font-medium text-text-strong">{pointName(point.form_id, point.value, point.merged)}</th>
                <td className="px-3 py-2 tabular-nums">{formatCount(point.responses, i18n.language)}</td>
                {comparison.questions.map((question) => {
                  const why = unmatched[question.id]
                  if (why !== undefined) return <td key={question.id} className="px-3 py-2 text-[12px] text-muted">{t(`report.compare.${why}`)}</td>
                  if (point.scores === null) {
                    const hidden = point.withheld === 'complement' ? t('report.segments.complement') : t('report.compare.few', { minimum: comparison.min_size })
                    return <td key={question.id} className="px-3 py-2 text-[12px] text-muted">{hidden}</td>
                  }
                  const figure = point.scores[question.id]
                  return (
                    <td key={question.id} className="px-3 py-2 tabular-nums">
                      {question.type === 'matrix' ? rowAveragesText(form, question.id, figure, i18n.language) : figureText(figure, i18n.language)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The forms to put beside this one: up to 10, the template's siblings marked. */
function FormChooser({ form, forms, chosen, onToggle }: Readonly<{
  form: FormV2
  forms: readonly FeedbackForm[]
  chosen: readonly string[]
  onToggle: (formId: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const sameTemplate = (other: FeedbackForm) => other.template !== undefined && other.template.id === form.template?.id
  return (
    <fieldset className="space-y-1">
      <legend className="text-[12px] font-medium text-muted">{t('report.compare.forms')}</legend>
      {forms.length === 0 && <p className="text-[12px] text-muted">{t('report.compare.noForms')}</p>}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {forms.map((other) => (
          <li key={other.form_id}>
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={chosen.includes(other.form_id)} onChange={() => onToggle(other.form_id)}
                disabled={!chosen.includes(other.form_id) && chosen.length >= MAX_COMPARED} />
              <span className="min-w-0 truncate">{other.name}</span>
              {sameTemplate(other) && <span className="badge badge-muted">{t('report.compare.sameTemplate')}</span>}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}

export default function ComparePanel({ form, formId, filters }: Readonly<{ form: FormV2; formId: string; filters: ResultsFilters }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [by, setBy] = useState('')
  const list = useQuery({ queryKey: feedbackFormsKey(), queryFn: () => api.getFeedbackForms() })
  const forms = candidates(list.data?.forms ?? [], formId, form.template?.id)
  // (a split needs another form: one form split on its own is the Report's segments)
  const asked = chosen.length > 0
  const comparison = useFormComparison(formId, filters, chosen, by === '' ? null : by, asked)
  const toggle = (other: string) => setChosen((current) => (current.includes(other) ? current.filter((entry) => entry !== other)
    : [...current, other].slice(0, MAX_COMPARED)))
  return (
    <section className="card space-y-3" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-sm font-semibold tracking-tight text-text-strong">{t('report.compare.title')}</h3>
      <p className="text-[12px] text-muted">{t('report.compare.intro', { max: MAX_COMPARED })}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <FormChooser form={form} forms={forms} chosen={chosen} onToggle={toggle} />
        <div className="space-y-1">
          <label htmlFor={`${id}-by`} className="text-[12px] font-medium text-muted">{t('report.compare.by')}</label>
          <select id={`${id}-by`} className="select select-sm w-full" value={by} onChange={(event) => setBy(event.target.value)} disabled={!asked}>
            <option value="">{t('report.compare.byNone')}</option>
            {form.hidden_fields.map((field) => <option key={field.id} value={`hidden.${field.id}`}>{field.label === undefined || field.label === '' ? field.id : field.label}</option>)}
          </select>
        </div>
      </div>
      {asked && <ComparisonState form={form} comparison={comparison.data} failed={comparison.isError} />}
    </section>
  )
}
