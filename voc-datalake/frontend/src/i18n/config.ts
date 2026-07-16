/**
 * @fileoverview i18next configuration with lazy-loaded translation files.
 *
 * Translation files are served from public/locales/{lang}/{namespace}.json
 * and loaded at runtime via i18next-http-backend — no rebuild needed to add languages.
 *
 * @module i18n/config
 */

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import HttpBackend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'
import { LOCALE_LOAD_PATH } from './loadPath'

export const supportedLanguages = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko'] as const
export type SupportedLanguage = (typeof supportedLanguages)[number]

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

const defaultNS = 'common'
const namespaces = ['common', 'dashboard', 'dataExplorer', 'feedback', 'feedbackDetail', 'chat', 'login', 'settings', 'components', 'scrapers', 'feedbackForms', 'projects', 'categories', 'prioritization', 'problemAnalysis', 'projectDetail'] as const

function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return new Set<string>(supportedLanguages).has(lang)
}

void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Pin the UI to English until a real language switcher ships. This wins
    // over any value the detector would resolve (including a stale
    // 'voc-language' that earlier builds cached from the browser language),
    // and — combined with caches:['localStorage'] below — rewrites that cache
    // to 'en', so returning browsers self-heal. Remove this `lng` line in the
    // PR that adds the switcher so localStorage('voc-language') drives it.
    lng: 'en',
    fallbackLng: 'en',
    defaultNS,
    ns: [...namespaces],

    // Version-stamped path — see i18n/loadPath.ts for the cache-busting
    // rationale (issue #191).
    backend: { loadPath: LOCALE_LOAD_PATH },

    detection: {
      // 'navigator' is intentionally omitted so a non-English browser doesn't
      // render the partially-migrated UI in a mix of languages. Kept for the
      // future switcher, which will set localStorage('voc-language').
      order: ['localStorage'],
      lookupLocalStorage: 'voc-language',
      caches: ['localStorage'],
    },

    // React already escapes
    interpolation: { escapeValue: false },

    react: { useSuspense: true },
  })

/**
 * Change the active language and persist to localStorage.
 */
export function changeLanguage(lang: string): Promise<void> {
  if (!isSupportedLanguage(lang)) {
    return Promise.resolve()
  }
  return i18n.changeLanguage(lang).then(() => {
    return
  })
}

export default i18n
