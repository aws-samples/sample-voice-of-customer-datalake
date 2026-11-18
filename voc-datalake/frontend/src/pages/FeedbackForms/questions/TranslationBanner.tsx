/**
 * @fileoverview The editor always shows the primary language (UX §3.4); when another of the form's languages misses
 * texts of this card, a line says so with Translate, which opens that language's translation view.
 *
 * @module pages/FeedbackForms/questions/TranslationBanner
 */
import { useTranslation } from 'react-i18next'
import { Languages } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import { missingTexts } from '../model/translatable'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'

export default function TranslationBanner({ ownerId }: Readonly<{ ownerId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { go } = useBuilderUi()
  const missing = form.languages.filter((lng) => lng !== form.language)
    .map((lng) => ({ lng, count: missingTexts(form, lng).filter((entry) => entry.owner.id === ownerId).length }))
    .filter((entry) => entry.count > 0)
  if (missing.length === 0) return null
  return (
    <div className="space-y-1 rounded-lg border border-warn/30 bg-warn-subtle p-2.5 text-[13px] text-text">
      {missing.map(({ lng, count }) => (
        <p key={lng} className="flex flex-wrap items-center gap-2">
          <Languages size={14} className="shrink-0 text-warn" aria-hidden="true" />
          <span>{t('question.translationMissing', { primary: languageNames[form.language], language: languageNames[lng], count })}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => go('languages', [lng])}>{t('question.translate')}</button>
        </p>
      ))}
    </div>
  )
}
