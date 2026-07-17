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
import { supportedLanguages } from './languages'

// Language constants and the change helper live in ./languages (side-effect
// free) so UI components can import them without triggering this module's
// i18n.init(). Re-exported here for backward compatibility.
export { supportedLanguages, languageNames, changeLanguage } from './languages'
export type { SupportedLanguage } from './languages'

const defaultNS = 'common'
const namespaces = ['common', 'dashboard', 'dataExplorer', 'feedback', 'feedbackDetail', 'chat', 'login', 'settings', 'components', 'scrapers', 'feedbackForms', 'projects', 'categories', 'prioritization', 'problemAnalysis', 'projectDetail'] as const

void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // No `lng` pin: the language switcher (UserProfileModal) now drives the
    // active language via localStorage('voc-language'), read by the detector
    // below. First visit (no cached choice) falls back to English.
    fallbackLng: 'en',
    // Reject unsupported cached values (e.g. a stale regional variant) so a
    // bad localStorage entry can't select a locale we don't ship.
    supportedLngs: [...supportedLanguages],
    nonExplicitSupportedLngs: false,
    defaultNS,
    ns: [...namespaces],

    // Version-stamped path — see i18n/loadPath.ts for the cache-busting
    // rationale (issue #191).
    backend: { loadPath: LOCALE_LOAD_PATH },

    detection: {
      // 'navigator' is intentionally omitted: the user's explicit choice
      // (persisted to localStorage by the switcher via caches below) is the
      // only signal, so a non-English browser still gets English until the
      // user opts in to another language.
      order: ['localStorage'],
      lookupLocalStorage: 'voc-language',
      caches: ['localStorage'],
    },

    // React already escapes
    interpolation: { escapeValue: false },

    react: { useSuspense: true },
  })
  .then(() => {
    // Initial sync once detection has resolved (index.html defaults to "en").
    document.documentElement.lang = i18n.resolvedLanguage ?? 'en'
  })

// Keep <html lang> in sync for screen readers and hyphenation. Prefer
// resolvedLanguage so both sync paths agree if a regional variant slips in.
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = i18n.resolvedLanguage ?? lng
})

export default i18n
