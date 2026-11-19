/**
 * @fileoverview What the public widget (lambda/api/static/feedback-widget.js) does with a version 1 form's
 * `language` (7.04.00): `feedbackWidget.test.ts` runs the real widget and pins both of these to it. (The builder's
 * preview runs the real widget since 7.04.00, so nothing else needs them.)
 * @module pages/FeedbackForms/test/widgetLanguage
 */
import { isSupportedLanguage } from '../../../i18n/languages'
import type { SupportedLanguage } from '../../../i18n/languages'

/** `code` ('pl', 'pl-PL', 'de_AT') as one of the app's locales, or null (the widget's `knownLocale`). */
function knownLanguage(code: string | undefined): SupportedLanguage | null {
  const primary = (code ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return isSupportedLanguage(primary) ? primary : null
}

/** The language of the widget's own words (its `uiLocale`): the form's, else the browser's, else English. */
export function widgetLanguage(formLanguage: string | undefined, browserLanguage: string | undefined): SupportedLanguage {
  return knownLanguage(formLanguage) ?? knownLanguage(browserLanguage) ?? 'en'
}

/** The widget's start button in each language: its STRINGS[language].start and an arrow. */
export const WIDGET_START_LABEL: Readonly<Record<SupportedLanguage, string>> = {
  en: 'Start →',
  es: 'Comenzar →',
  fr: 'Commencer →',
  de: 'Starten →',
  pt: 'Começar →',
  ja: '開始 →',
  zh: '开始 →',
  ko: '시작 →',
  pl: 'Rozpocznij →',
}
