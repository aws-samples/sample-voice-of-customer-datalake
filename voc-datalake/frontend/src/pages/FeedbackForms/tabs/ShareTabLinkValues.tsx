/**
 * @fileoverview The Share tab's link builder (docs/feedback-forms.md "Recall"): a value for each hidden field,
 * put in the link, the iframe and the script embed (`hf_<id>=<value>`), and a warning for every hidden field the form
 * recalls into its texts that the copied link leaves empty ("This link leaves `event` empty: respondents see the text
 * without it"). A missing value is never an error: the text shows its fallback, or reads without it.
 *
 * @module pages/FeedbackForms/tabs/ShareTabLinkValues
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import type { FormV2 } from '../model/formsV2'
import { recalledHiddenIds } from '../model/recall'

/** The hidden fields the form recalls that `values` leaves empty, in the form's order. */
function emptyRecalled(form: FormV2, values: Readonly<Record<string, string>>): string[] {
  return recalledHiddenIds(form).filter((id) => (values[id] ?? '').trim() === '')
}

function ValueField({ id, label, value, onChange }: Readonly<{ id: string; label: string; value: string; onChange: (next: string) => void }>) {
  const inputId = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-[13px] text-text">
        {label} <span className="font-mono text-[12px] text-muted">hf_{id}</span>
      </label>
      <input id={inputId} className="input w-full text-sm" value={value} maxLength={200} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

export default function ShareTabLinkValues({ form, values, onChange }: Readonly<{
  form: FormV2
  values: Readonly<Record<string, string>>
  onChange: (next: Readonly<Record<string, string>>) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const headingId = useId()
  if (form.hidden_fields.length === 0) return null
  const empty = emptyRecalled(form, values)
  return (
    <fieldset className="space-y-2" aria-labelledby={headingId}>
      <legend id={headingId} className="text-sm font-medium text-text">{t('share.values.title')}</legend>
      <p className="text-[12px] text-muted">{t('share.values.hint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {form.hidden_fields.map((field) => (
          <ValueField key={field.id} id={field.id} label={field.label ?? field.id} value={values[field.id] ?? ''}
            onChange={(next) => onChange({ ...values, [field.id]: next })} />
        ))}
      </div>
      {empty.length > 0 && (
        <ul className="space-y-1" aria-label={t('share.values.warnings')}>
          {empty.map((id) => (
            <li key={id} className="flex items-start gap-2 text-[13px] text-text">
              <TriangleAlert size={14} className="mt-0.5 flex-shrink-0 text-warn" aria-hidden="true" />
              <span>{t('share.values.leavesEmpty', { id })}</span>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}
