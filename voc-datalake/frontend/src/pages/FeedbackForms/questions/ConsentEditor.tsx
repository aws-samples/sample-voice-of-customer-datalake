/**
 * @fileoverview Consent (UX §4.4): the checkbox text (required). Required reads "Must be ticked to continue"; an
 * optional consent left unticked answers No.
 *
 * @module pages/FeedbackForms/questions/ConsentEditor
 */
import { useTranslation } from 'react-i18next'
import type { ConsentQuestion } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'

export default function ConsentEditor({ question, onChange }: Readonly<{ question: ConsentQuestion; onChange: (q: ConsentQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const lng = draft.form.language
  return (
    <TextField label={t('consent.checkboxText')} required multiline value={textIn(question.label, lng)} placeholder={t('consent.placeholder')}
      hint={t('consent.hint')} problems={fieldProblems(problemsAt(draft.problems, 'question', question.id), 'label')}
      onChange={(value) => onChange({ ...question, label: withText(question.label, lng, value) })} />
  )
}
