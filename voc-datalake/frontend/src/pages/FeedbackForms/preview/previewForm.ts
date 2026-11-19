/**
 * @fileoverview What the previews (the pane, the picker's, the window) read off a draft: the languages as the
 * Language select words them, whether a question shuffles, the card a selection points at, and whether only the
 * theme changed since the last update (a dragged colour or slider then shows on the next frame, not 150 ms later).
 *
 * @module pages/FeedbackForms/preview/previewForm
 */
import type { TFunction } from 'i18next'
import { languageNames } from '../../../i18n/languages'
import type { FormV2 } from '../model/formsV2'
import { missingTexts } from '../model/translatable'
import type { LanguageChoice } from './previewChannel'

/** "English", or "English (4 missing, shown in Polski)" for a language with texts still to translate. */
export function languageChoices(t: TFunction<'feedbackForms'>, form: FormV2): LanguageChoice[] {
  return form.languages.map((lng) => {
    const missing = missingTexts(form, lng).length
    const label = missing === 0
      ? languageNames[lng]
      : t('preview.languageMissing', { language: languageNames[lng], count: missing, primary: languageNames[form.language] })
    return { value: lng, label }
  })
}

/** Some choice question reorders its options for each respondent (Shuffle). */
export function hasShuffle(form: FormV2): boolean {
  return form.questions.some((question) => 'shuffle' in question && question.shuffle !== 'none')
}

/** The widget's `goTo` target of a selected card: the question's id, `'welcome'` or `'end:<ending id>'`. */
export function cardTarget(card: { readonly kind: 'question' | 'ending' | 'welcome'; readonly id: string } | null): string | null {
  if (card === null) return null
  if (card.kind === 'welcome') return 'welcome'
  return card.kind === 'ending' ? `end:${card.id}` : card.id
}

/** Every top-level part of the draft is the same object except its theme (the editor replaces what it edits). */
export function onlyThemeChanged(before: FormV2, after: FormV2): boolean {
  if (before === after || before.theme === after.theme) return false
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].every((key) => key === 'theme' || Reflect.get(before, key) === Reflect.get(after, key))
}
