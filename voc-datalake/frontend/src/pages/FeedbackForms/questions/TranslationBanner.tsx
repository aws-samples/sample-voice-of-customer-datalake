/**
 * @fileoverview The editor always shows the primary language (UX §3.4); when another of the form's languages misses
 * texts of this card, one line under the Question field says so, "English: 2 texts missing · Translate", Translate
 * opening that language's translation view. A line, not a block: it repeats on every card that misses texts, and the
 * card's "en missing" badge already flags it in the list.
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
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text">
      <Languages size={13} className="shrink-0 text-warn" aria-hidden="true" />
      {missing.map(({ lng, count }) => {
        const language = languageNames[lng]
        return (
          <span key={lng} className="inline-flex flex-wrap items-center gap-1">
            {t('question.translationLine', { language, count })}
            <span aria-hidden="true">·</span>
            <button type="button" className="link" aria-label={t('question.translateInto', { language })} onClick={() => go('languages', [lng])}>
              {t('question.translate')}
            </button>
          </span>
        )
      })}
    </p>
  )
}
