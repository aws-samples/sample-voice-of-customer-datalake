/**
 * @fileoverview A choice question's own settings (UX §4.1): "Other" with a text box (its label and placeholder),
 * "None of these" (multiple choice only; exclusive), the order (as listed, shuffled, shuffled but the last option
 * kept), Show as (Auto | List | Dropdown | Chips, with what Auto shows here), and At least / At most.
 *
 * @module pages/FeedbackForms/questions/ChoiceSettings
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import SwitchField from '../../../components/SwitchField/SwitchField'
import type { ChoiceDisplay, ChoiceQuestion, Shuffle } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { choiceRows, problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import { FieldProblems, SelectField, TextField } from './fields'
import { fieldProblems, numberOrUndefined } from './fieldHelpers'
import { useQuestionFields } from './useEditorDraft'

const AUTO_LIST_ROWS = 6

function OtherAndNone({ question, onChange }: Readonly<{ question: ChoiceQuestion; onChange: (q: ChoiceQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { lng, problems } = useQuestionFields(question.id)
  return (
    <div className="space-y-2">
      <SwitchField checked={question.other.enabled} label={t('choice.other')} onChange={(enabled) => onChange({ ...question, other: { ...question.other, enabled } })} />
      {question.other.enabled && (
        <div className="grid gap-2 sm:grid-cols-2">
          <TextField label={t('choice.otherLabel')} value={textIn(question.other.label, lng)} placeholder={t('choice.otherDefault')}
            problems={fieldProblems(problems, 'other_label')} onChange={(value) => onChange({ ...question, other: { ...question.other, label: withText(question.other.label, lng, value) } })} />
          <TextField label={t('choice.otherPlaceholder')} value={textIn(question.other.placeholder, lng)} placeholder={t('choice.otherPlaceholderDefault')}
            problems={fieldProblems(problems, 'other_placeholder')} onChange={(value) => onChange({ ...question, other: { ...question.other, placeholder: withText(question.other.placeholder, lng, value) } })} />
        </div>
      )}
      {question.type === 'multi_select' && (
        <>
          <SwitchField checked={question.none.enabled} label={t('choice.none')} hint={t('choice.noneHint')}
            onChange={(enabled) => onChange({ ...question, none: { ...question.none, enabled } })} />
          {question.none.enabled && (
            <TextField label={t('choice.noneLabel')} value={textIn(question.none.label, lng)} placeholder={t('logic.values.none')}
              problems={fieldProblems(problems, 'none_label')} onChange={(value) => onChange({ ...question, none: { ...question.none, label: withText(question.none.label, lng, value) } })} />
          )}
        </>
      )}
    </div>
  )
}

function DisplayField({ question, onChange }: Readonly<{ question: ChoiceQuestion; onChange: (q: ChoiceQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const rows = choiceRows(question)
  const problems = problemsAt(draft.problems, 'question', question.id).filter((p) => p.at.field === 'display')
  const warnings = [...new Map(problems.map((p) => [p.code, p])).values()]
  const autoHint = rows <= AUTO_LIST_ROWS ? t('choice.autoList', { count: rows }) : t('choice.autoDropdown', { count: rows })
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-text">{t('choice.showAs')}</p>
      <Segmented label={t('choice.showAs')} value={question.display} onChange={(display: ChoiceDisplay) => onChange({ ...question, display })}
        choices={(['auto', 'list', 'dropdown', 'chips'] as const).map((value) => ({ value, label: t(`choice.display.${value}`) }))} />
      {question.display === 'auto' && <p className="text-[12px] text-muted">{autoHint}</p>}
      <FieldProblems id={`${question.id}-display-problems`} problems={warnings} />
    </div>
  )
}

function MinMax({ question, onChange }: Readonly<{ question: ChoiceQuestion; onChange: (q: ChoiceQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const id = useId()
  const problems = problemsAt(draft.problems, 'question', question.id)
  const minProblems = fieldProblems(problems, 'min')
  const maxProblems = fieldProblems(problems, 'max')
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-text">{t('choice.answers')}</legend>
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={`${id}-min`} className="text-[13px] text-text">{t('choice.atLeast')}
          <input id={`${id}-min`} type="number" min={0} className="input ml-2 w-20" value={question.min ?? ''}
            aria-invalid={minProblems.length > 0 ? true : undefined} aria-describedby={`${id}-problems`}
            onChange={(event) => onChange({ ...question, min: numberOrUndefined(event.target.value) })} />
        </label>
        <label htmlFor={`${id}-max`} className="text-[13px] text-text">{t('choice.atMost')}
          <input id={`${id}-max`} type="number" min={1} className="input ml-2 w-20" value={question.max ?? ''}
            aria-invalid={maxProblems.length > 0 ? true : undefined} aria-describedby={`${id}-problems`}
            onChange={(event) => onChange({ ...question, max: numberOrUndefined(event.target.value) })} />
        </label>
      </div>
      <p className="text-[12px] text-muted">{question.max === undefined ? t('choice.minMaxHint') : t('choice.respondentsSee', { count: question.max })}</p>
      <FieldProblems id={`${id}-problems`} problems={[...minProblems, ...maxProblems]} />
    </fieldset>
  )
}

export default function ChoiceSettings({ question, onChange }: Readonly<{ question: ChoiceQuestion; onChange: (q: ChoiceQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <OtherAndNone question={question} onChange={onChange} />
      <SelectField label={t('choice.order')} value={question.shuffle} hint={t('choice.orderHint')}
        onChange={(shuffle: Shuffle) => onChange({ ...question, shuffle })}
        options={[
          { value: 'none', label: t('choice.shuffle.none') },
          { value: 'all', label: t('choice.shuffle.all') },
          { value: 'except_last', label: t('choice.shuffle.except_last') },
        ]} />
      <DisplayField question={question} onChange={onChange} />
      {question.type === 'multi_select' && <MinMax question={question} onChange={onChange} />}
    </div>
  )
}
