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
import { I18N_INIT_OPTIONS } from './options'

// Language constants and the change helper live in ./languages (side-effect
// free) so UI components can import them without triggering this module's
// i18n.init(). Re-exported here for backward compatibility.
export { supportedLanguages, languageNames, changeLanguage } from './languages'
export type { SupportedLanguage } from './languages'

// The init options live in ./options for that same reason: a test can then assert
// on the REAL config — that `nsSeparator` is still ':', which every
// namespace-qualified key depends on — without executing this module's init.
//
// Spread, not the object itself: the test's assertions are only about the declared
// config, so init() must not be able to write back into it. Shallow, which covers
// every top-level option (`nsSeparator` among them); the nested `backend`,
// `detection`, `interpolation` and `react` objects are still shared.
void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({ ...I18N_INIT_OPTIONS })
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
