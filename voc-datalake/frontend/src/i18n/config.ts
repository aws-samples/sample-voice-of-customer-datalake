/**
 * @fileoverview i18next configuration with lazy-loaded translation files.
 *
 * Translation files are served from public/locales/{lang}/{namespace}.json
 * and loaded at runtime via i18next-http-backend — no rebuild needed to add languages.
 *
 * @module i18n/config
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import HttpBackend from 'i18next-http-backend'
import LanguageDetector from 'i18next-browser-languagedetector'

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

export const defaultNS = 'common'
export const namespaces = ['common', 'dashboard', 'feedback', 'chat', 'login'] as const

function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return supportedLanguages.some((supported) => supported === lang)
}

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    defaultNS,
    ns: [...namespaces],

    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },

    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'voc-language',
      caches: ['localStorage'],
    },

    interpolation: {
      escapeValue: false, // React already escapes
    },

    react: {
      useSuspense: true,
    },
  })

/**
 * Change the active language and persist to localStorage.
 */
export function changeLanguage(lang: string): Promise<void> {
  if (!isSupportedLanguage(lang)) {
    return Promise.resolve()
  }
  return i18n.changeLanguage(lang).then(() => undefined)
}

export default i18n
