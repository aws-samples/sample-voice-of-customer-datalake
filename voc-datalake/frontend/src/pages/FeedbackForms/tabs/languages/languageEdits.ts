/**
 * @fileoverview The Languages tab's arithmetic and the edits it needs beyond `model/mutations.ts`: how complete a
 * translation is, the catalogue lookup a template fill reads (no fallback to another language), and D15's re-keying
 * of a migrated form's texts to the language its author says it is written in.
 *
 * @module pages/FeedbackForms/tabs/languages/languageEdits
 */
import i18n from 'i18next'
import type { FormLanguage, FormV2 } from '../../model/formsV2'
import { textIn } from '../../model/i18nText'
import { missingTexts, textsToTranslate, translatableTexts } from '../../model/translatable'
import type { CopyLookup } from '../../formTemplates'

export interface Completeness {
  readonly total: number
  readonly missing: number
  readonly done: number
}

/** How much of the form `language` covers (the primary covers everything). */
export function completeness(form: FormV2, language: FormLanguage): Completeness {
  const total = textsToTranslate(form).length
  const missing = missingTexts(form, language).length
  return { total, missing, done: total - missing }
}

/** A lookup into one language's forms catalogue as loaded: undefined when that language has no such text. */
export function catalogueLookup(language: FormLanguage): CopyLookup {
  return (key) => {
    const value: unknown = i18n.getResource(language, 'feedbackForms', key)
    return typeof value === 'string' ? value : undefined
  }
}

/**
 * The form as written in `to` (D15): every text of the old primary moves to `to` (the texts were never in the old
 * one, which was only the deployment's default), and `to` becomes the primary. Codes and ids never change.
 */
export function rekeyPrimary(form: FormV2, to: FormLanguage): FormV2 {
  const from = form.language
  if (to === from) return form
  const moved = translatableTexts(form).reduce((current, entry) => {
    const value = textIn(entry.text, from)
    return value === '' ? current : entry.write(entry.write(current, to, value), from, '')
  }, form)
  return { ...moved, language: to, languages: [to, ...form.languages.filter((language) => language !== from && language !== to)] }
}
