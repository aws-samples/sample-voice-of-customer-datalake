/**
 * @fileoverview Contact info (UX §4.4): which fields show (name, email, phone, company) and which of them are
 * required (a hidden field can't be); at least one shows. The field labels and checks are the widget's own.
 *
 * @module pages/FeedbackForms/questions/ContactEditor
 */
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import type { ContactField, ContactQuestion } from '../model/formsV2'
import { CONTACT_FIELDS } from '../model/formsV2'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { FieldProblems } from './fields'
import { fieldProblems } from './fieldHelpers'

export default function ContactEditor({ question, onChange }: Readonly<{ question: ContactQuestion; onChange: (q: ContactQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const problems = fieldProblems(problemsAt(draft.problems, 'question', question.id), 'fields')
  const set = (field: ContactField, patch: Partial<ContactQuestion['fields'][ContactField]>) => {
    const next = { ...question.fields[field], ...patch }
    onChange({ ...question, fields: { ...question.fields, [field]: next.show ? next : { show: false, required: false } } })
  }
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">
            <th scope="col" className="py-1">{t('contact.field')}</th>
            <th scope="col" className="py-1">{t('contact.show')}</th>
            <th scope="col" className="py-1">{t('contact.required')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {CONTACT_FIELDS.map((field) => {
            const setting = question.fields[field]
            const name = t(`contact.fields.${field}`)
            return (
              <tr key={field}>
                <th scope="row" className="py-1.5 font-normal text-text">{name}</th>
                <td className="py-1.5">
                  <input type="checkbox" role="switch" aria-label={t('contact.showField', { field: name })} checked={setting.show}
                    onChange={(event) => set(field, { show: event.target.checked })} />
                </td>
                <td className="py-1.5">
                  <input type="checkbox" aria-label={t('contact.requireField', { field: name })} checked={setting.required}
                    disabled={!setting.show} onChange={(event) => set(field, { required: event.target.checked })} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <FieldProblems id={`${question.id}-fields-problems`} problems={problems} />
      <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-[13px] text-text">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-info" aria-hidden="true" />{t('contact.personalData')}
      </p>
    </div>
  )
}
