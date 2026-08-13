/**
 * @fileoverview The options object passed to `i18n.init()`, split out so it can be
 * READ without running init.
 *
 * Same reason `./languages` is a separate module: importing `./config` executes
 * `i18n.use(HttpBackend).use(LanguageDetector).init(...)` at module scope, which a
 * test cannot do without a network backend and a browser language detector. The
 * options themselves are plain data, so they can live here and be asserted on.
 *
 * What that buys, concretely: `nsSeparator` is not set, so it is i18next's default
 * `':'`, and namespace-qualified keys like `prioritization:docType.prd` resolve
 * from a `t` bound to any namespace. `SCORABLE_TYPE_META` depends on that — set
 * `nsSeparator: false` here (a common workaround for keys that contain colons) and
 * the Prioritization badge and the Feedback Forms document picker would both
 * render the raw key path. `prioritizationUtils.test.ts` asserts against THIS
 * object, so that change fails a test instead of shipping.
 *
 * @module i18n/options
 */
import type { InitOptions } from 'i18next'
import { LOCALE_LOAD_PATH } from './loadPath'
import { supportedLanguages } from './languages'

// Module-private, as they were in config.ts: I18N_INIT_OPTIONS is the only thing
// worth importing, and exporting these would add public surface nothing reads.
// Note this is NOT the only copy of the namespace list — src/test/setup.ts,
// scripts/i18n-check.mjs and scripts/fix-i18n.mjs each keep their own, as they did
// before this move. Consolidating them is a separate change.
const DEFAULT_NS = 'common'

const NAMESPACES = ['common', 'dashboard', 'dataExplorer', 'feedbackDetail', 'chat', 'login', 'settings', 'components', 'scrapers', 'feedbackForms', 'projects', 'categories', 'prioritization', 'problemAnalysis', 'projectDetail'] as const

export const I18N_INIT_OPTIONS: InitOptions = {
  // No `lng` pin: the language switcher (UserProfileModal) now drives the
  // active language via localStorage('voc-language'), read by the detector
  // below. First visit (no cached choice) falls back to English.
  fallbackLng: 'en',
  // Reject unsupported cached values (e.g. a stale regional variant) so a
  // bad localStorage entry can't select a locale we don't ship.
  supportedLngs: [...supportedLanguages],
  nonExplicitSupportedLngs: false,
  defaultNS: DEFAULT_NS,
  ns: [...NAMESPACES],
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
}
