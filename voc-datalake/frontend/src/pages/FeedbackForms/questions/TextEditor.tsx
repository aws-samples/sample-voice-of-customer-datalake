/**
 * @fileoverview Open text (UX §4.3): Short | Long, the answer type (short only: text, email, number, phone, web
 * address, which set the widget's input and its checks), the placeholder (a hint, never a label), and the limit
 * (1–5,000 characters; blank is 5,000).
 *
 * @module pages/FeedbackForms/questions/TextEditor
 */
import { useTranslation } from 'react-i18next'
import type { InputType, OpenTextQuestion } from '../model/formsV2'
import { INPUT_TYPES, LIMITS } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import { SelectField, TextField } from './fields'
import { fieldProblems, numberOrUndefined } from './fieldHelpers'

export default function TextEditor({ question, onChange }: Readonly<{ question: OpenTextQuestion; onChange: (q: OpenTextQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const lng = draft.form.language
  const problems = problemsAt(draft.problems, 'question', question.id)
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('text.length')}</p>
        <Segmented label={t('text.length')} value={question.long ? 'long' : 'short'}
          onChange={(value) => onChange({ ...question, long: value === 'long' })}
          choices={[{ value: 'short', label: t('text.short') }, { value: 'long', label: t('text.long') }]} />
      </div>
      {!question.long && (
        <SelectField label={t('text.answerType')} value={question.input_type} onChange={(inputType: InputType) => onChange({ ...question, input_type: inputType })}
          options={INPUT_TYPES.map((value) => ({ value, label: t(`text.inputTypes.${value}`) }))} />
      )}
      <TextField label={t('text.placeholder')} value={textIn(question.placeholder, lng)} hint={t('text.placeholderHint')}
        onChange={(value) => onChange({ ...question, placeholder: withText(question.placeholder, lng, value) })} />
      <TextField label={t('text.limit')} type="number" value={question.max_chars === undefined ? '' : String(question.max_chars)}
        placeholder={String(LIMITS.maxChars)} hint={t('text.limitHint')} problems={fieldProblems(problems, 'max_chars')}
        onChange={(value) => onChange({ ...question, max_chars: numberOrUndefined(value) })} />
    </div>
  )
}
