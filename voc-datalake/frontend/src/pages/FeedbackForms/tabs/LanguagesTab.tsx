/**
 * @fileoverview The Languages tab (UX §8): the primary language, the translations and how complete each one is, and
 * the side-by-side editor of one (`/languages/<lng>`, TranslationTable). Adding a language to a form made from a
 * template fills every text still equal to the template's from that language's catalogue ("From template").
 * Missing translations never block a save: they fall back to the primary.
 *
 * @module pages/FeedbackForms/tabs/LanguagesTab
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { ChevronDown, Info, Languages, Plus } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { RowActionsMenu } from '../../../components/RowActionsMenu/RowActionsMenu'
import { languageNames } from '../../../i18n/languages'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { FORM_LANGUAGES, isFormLanguage } from '../model/formsV2'
import { addLanguage, removeLanguage, setPrimaryLanguage } from '../model/mutations'
import { fillFromTemplate, templateById } from '../formTemplates'
import TranslationTable from './TranslationTable'
import LanguageConfirmNotice from './LanguageConfirmNotice'
import LanguageRows from './languages/LanguageRows'
import { catalogueLookup, completeness } from './languages/languageEdits'
import InfoNote from './hidden/InfoNote'

/** "+ Add language…": a menu button of the languages the form does not have yet (a button, not a select dressed as one). */
function AddLanguage({ form, onAdd }: Readonly<{ form: FormV2; onAdd: (language: FormLanguage) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const left = FORM_LANGUAGES.filter((language) => !form.languages.includes(language))
  if (left.length === 0) return null
  return (
    <RowActionsMenu label={t('languages.add')} className="btn btn-secondary btn-sm"
      face={<><Plus size={14} aria-hidden="true" />{t('languages.add')}<ChevronDown size={14} aria-hidden="true" /></>}
      entries={left.map((language) => ({ kind: 'action', id: language, label: languageNames[language], onSelect: () => onAdd(language) }))} />
  )
}

/** Add a language; for a form made from a template, fill it from that template's catalogue (UX §8). */
function useAddLanguage(onFilled: (language: FormLanguage, count: number) => void) {
  const draft = useDraft()
  const latest = useRef(draft.form)
  useEffect(() => { latest.current = draft.form })
  const flow = draft.templateId === null ? undefined : templateById(draft.templateId)
  return async (language: FormLanguage) => {
    if (flow === undefined) {
      draft.update((form) => addLanguage(form, language))
      return
    }
    await i18n.loadLanguages([language, latest.current.language])
    const primary = latest.current.language
    const result = fillFromTemplate(addLanguage(latest.current, language), flow, language, catalogueLookup(primary), catalogueLookup(language))
    draft.update(() => result.form)
    draft.setFromTemplate((keys) => new Set([...keys, ...result.filled.map((key) => `${language}:${key}`)]))
    onFilled(language, result.filled.length)
  }
}

function RemoveLanguage({ form, language, onDone }: Readonly<{ form: FormV2; language: FormLanguage | null; onDone: (remove: boolean) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const name = language === null ? '' : languageNames[language]
  return (
    <ConfirmModal isOpen={language !== null} variant="danger" confirmLabel={t('languages.removeConfirm')}
      title={t('languages.removeTitle', { language: name })}
      message={t('languages.removeMessage', {
        language: name, primary: languageNames[form.language], count: language === null ? 0 : completeness(form, language).done,
      })}
      onCancel={() => onDone(false)} onConfirm={() => onDone(true)} />
  )
}

/** The translation `rest` opens (`/languages/<lng>`), when it names one of the form's translations. */
function openedLanguage(form: FormV2, rest: readonly string[]): FormLanguage | null {
  const [open] = rest
  return open !== undefined && isFormLanguage(open) && open !== form.language && form.languages.includes(open) ? open : null
}

export default function LanguagesTab() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { rest, go } = useBuilderUi()
  const { form } = draft
  const [removing, setRemoving] = useState<FormLanguage | null>(null)
  const [filled, setFilled] = useState<{ language: FormLanguage; count: number } | null>(null)
  const add = useAddLanguage((language, count) => setFilled({ language, count }))
  const open = openedLanguage(form, rest)
  const primaryName = languageNames[form.language]
  const onAdd = (language: FormLanguage) => {
    void add(language).then(() => go('languages', [language]))
  }
  const filledNote = filled === null || filled.count === 0 ? null : <InfoNote icon={Info}>{t('languages.filled', { count: filled.count })}</InfoNote>
  if (open !== null) {
    return <div className="space-y-3">{filled?.language === open && filledNote}<TranslationTable language={open} /></div>
  }
  return (
    <section aria-labelledby="languages-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="languages-heading" className="text-sm font-semibold tracking-tight text-text-strong">{t('languages.title')}</h2>
        <AddLanguage form={form} onAdd={onAdd} />
      </div>
      <LanguageConfirmNotice />
      {filledNote}
      {form.languages.length === 1 ? (
        <Notice variant="empty" icon={Languages} title={t('languages.emptyTitle')} text={t('languages.empty', { language: primaryName })} />
      ) : (
        <LanguageRows form={form} onTranslate={(language) => go('languages', [language])} onRemove={setRemoving}
          onPrimary={(language) => draft.update((current) => setPrimaryLanguage(current, language))} />
      )}
      <p className="text-[13px] text-muted">{t('languages.respondents', { primary: primaryName })}</p>
      <p className="text-[13px] text-muted">{t('languages.fallback', { primary: primaryName })}</p>
      <RemoveLanguage form={form} language={removing} onDone={(remove) => {
        if (remove && removing !== null) draft.update((current) => removeLanguage(current, removing))
        setRemoving(null)
      }} />
    </section>
  )
}
