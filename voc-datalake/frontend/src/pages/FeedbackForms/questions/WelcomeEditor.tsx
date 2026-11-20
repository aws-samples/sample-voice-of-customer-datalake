/**
 * @fileoverview The welcome card (UX §4.5): Show a welcome screen, then its title, description and button label
 * (empty: the widget's own "Start" in the respondent's language). The title and description may recall a hidden
 * field (RecallField: no question comes before them).
 *
 * @module pages/FeedbackForms/questions/WelcomeEditor
 */
import { useTranslation } from 'react-i18next'
import { DoorOpen } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import { textIn, withText } from '../model/i18nText'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'
import { useRequestedFocus } from './focusRequest'
import RecallField from './RecallField'

export default function WelcomeEditor() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { welcome, language: lng } = draft.form
  const title = useRequestedFocus<HTMLInputElement & HTMLTextAreaElement>('welcome')
  const problems = problemsAt(draft.problems, 'welcome')
  const set = (patch: Partial<typeof welcome>) => draft.update((form) => ({ ...form, welcome: { ...form.welcome, ...patch } }))
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-text-strong">
        <DoorOpen size={16} className="text-muted" aria-hidden="true" />{t('questionList.welcomeName')}
      </h2>
      <SwitchField checked={welcome.enabled} label={t('welcome.show')} hint={t('welcome.hint')} onChange={(enabled) => set({ enabled })} />
      {welcome.enabled && (
        <>
          <RecallField before={0} label={t('welcome.title')} required inputRef={title} value={textIn(welcome.title, lng)}
            problems={fieldProblems(problems, 'title')}
            onChange={(value) => set({ title: withText(welcome.title, lng, value) })} />
          <RecallField before={0} label={t('welcome.description')} multiline value={textIn(welcome.description, lng)}
            problems={fieldProblems(problems, 'description')}
            onChange={(value) => set({ description: withText(welcome.description, lng, value) })} />
          <TextField label={t('welcome.buttonLabel')} value={textIn(welcome.button_label, lng)} placeholder={t('welcome.buttonDefault')}
            problems={fieldProblems(problems, 'button_label')}
            onChange={(value) => set({ button_label: withText(welcome.button_label, lng, value) })} />
        </>
      )}
    </div>
  )
}
