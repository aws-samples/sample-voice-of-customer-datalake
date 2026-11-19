/**
 * @fileoverview Reading and writing an `I18nText` (one text per form language). The editor writes the primary
 * language; the Languages tab writes the others. A text missing in a language falls back to the primary, as the
 * widget does.
 *
 * @module pages/FeedbackForms/model/i18nText
 */
import type { FormLanguage, I18nText } from './formsV2'

/** The text in `language`, '' when it has none (no fallback: the editor's own view of one language). */
export function textIn(text: I18nText | undefined, language: FormLanguage): string {
  return text?.[language] ?? ''
}

/** `text` with `language` set to `value`; an empty value removes that language's entry. */
export function withText(text: I18nText | undefined, language: FormLanguage, value: string): I18nText {
  const rest = Object.fromEntries(Object.entries(text ?? {}).filter(([key]) => key !== language))
  return value === '' ? rest : { ...rest, [language]: value }
}

/** One language's text as a fresh `I18nText`. */
export const textOf = (language: FormLanguage, value: string): I18nText => (value === '' ? {} : { [language]: value })

/** Has the text anything in `language` (spaces don't count)? */
export const hasText = (text: I18nText | undefined, language: FormLanguage): boolean => textIn(text, language).trim() !== ''

/** `text` without the entries of the languages not in `keep`. */
export function keepLanguages(text: I18nText | undefined, keep: readonly FormLanguage[]): I18nText | undefined {
  if (text === undefined) return undefined
  return Object.fromEntries(Object.entries(text).filter(([key]) => keep.some((language) => language === key)))
}
