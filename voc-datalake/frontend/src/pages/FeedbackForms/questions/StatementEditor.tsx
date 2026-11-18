/**
 * @fileoverview A statement (UX §4.4): text to read, with an optional link button (its label and an https address).
 * Next still moves on; the link opens in a new tab. A statement has no answer, so no Required.
 *
 * @module pages/FeedbackForms/questions/StatementEditor
 */
import { useTranslation } from 'react-i18next'
import SwitchField from '../../../components/SwitchField/SwitchField'
import type { StatementQuestion } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'

export default function StatementEditor({ question, onChange }: Readonly<{ question: StatementQuestion; onChange: (q: StatementQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const lng = draft.form.language
  const { cta } = question
  const problems = problemsAt(draft.problems, 'question', question.id)
  return (
    <div className="space-y-3">
      <SwitchField checked={cta !== undefined} label={t('statement.addButton')} hint={t('statement.hint')}
        onChange={(on) => onChange({ ...question, cta: on ? { label: {}, url: '' } : undefined })} />
      {cta !== undefined && (
        <div className="grid gap-2 sm:grid-cols-2">
          <TextField label={t('statement.buttonLabel')} value={textIn(cta.label, lng)} placeholder={t('statement.buttonLabelPlaceholder')}
            onChange={(value) => onChange({ ...question, cta: { ...cta, label: withText(cta.label, lng, value) } })} />
          <TextField label={t('statement.address')} type="url" value={cta.url ?? ''} placeholder="https://" mono
            hint={t('statement.addressHint')} problems={fieldProblems(problems, 'cta_url')}
            onChange={(value) => onChange({ ...question, cta: { ...cta, url: value } })} />
        </div>
      )}
    </div>
  )
}
