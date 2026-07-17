/**
 * @fileoverview Supported-language constants and the language-change helper.
 *
 * Deliberately side-effect free: importing this module does NOT initialize
 * i18next. UI components (e.g. the language picker in UserProfileModal) must
 * import from here rather than from ./config, whose import runs the real
 * i18n.init() with the HTTP backend — something component tests (which init
 * the same i18next singleton with inline resources in src/test/setup.ts)
 * must never trigger.
 *
 * @module i18n/languages
 */

import i18n from 'i18next'

export const supportedLanguages = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko'] as const
export type SupportedLanguage = (typeof supportedLanguages)[number]

/** Native-name (endonym) labels — intentionally not translated. */
export const languageNames: Record<SupportedLanguage, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
}

const supportedLanguageSet: ReadonlySet<string> = new Set(supportedLanguages)

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return supportedLanguageSet.has(lang)
}

/**
 * Change the active language. Persistence to localStorage('voc-language')
 * happens via the detector's caches config in ./config — no extra write here.
 * Unsupported codes are ignored.
 */
export function changeLanguage(lang: string): Promise<void> {
  if (!isSupportedLanguage(lang)) {
    return Promise.resolve()
  }
  return i18n.changeLanguage(lang).then(() => {
    return
  })
}
