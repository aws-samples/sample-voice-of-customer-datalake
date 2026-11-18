/**
 * @fileoverview D15's prompt (UX §3.6): a migrated v1 form whose language was "the visitor's browser" was read with
 * the deployment's default as its primary. Its author confirms the language it is written in ("Written in
 * [Polski ▾]"); choosing another moves the texts to it, and the next save stores it (the notice then goes).
 *
 * @module pages/FeedbackForms/tabs/LanguageConfirmNotice
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import { useDraft } from '../builder/formDraftContext'
import { FORM_LANGUAGES, isFormLanguage } from '../model/formsV2'
import InfoNote from './hidden/InfoNote'
import { rekeyPrimary } from './languages/languageEdits'

export default function LanguageConfirmNotice() {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const draft = useDraft()
  if (draft.meta?.language_unconfirmed !== true) return null
  return (
    <InfoNote icon={Languages}>
      <span className="flex flex-wrap items-center gap-2">
        <span>{t('languages.confirm.text')}</span>
        <label htmlFor={id} className="font-medium">{t('languages.confirm.writtenIn')}</label>
        <select id={id} className="select select-sm w-auto" value={draft.form.language}
          onChange={(event) => {
            const chosen = event.target.value
            if (isFormLanguage(chosen)) draft.update((form) => rekeyPrimary(form, chosen))
          }}>
          {FORM_LANGUAGES.map((language) => <option key={language} value={language} lang={language}>{languageNames[language]}</option>)}
        </select>
        <span>{t('languages.confirm.saving')}</span>
      </span>
    </InfoNote>
  )
}
