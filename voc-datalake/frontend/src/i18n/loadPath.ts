/**
 * @fileoverview Version-stamped locale load path (issue #191).
 *
 * Browsers that cached the locale JSONs before #188 set Cache-Control hold
 * copies with heuristic freshness (~10% of object age — days, for files
 * last deployed weeks earlier) and serve them without any network request,
 * so the hash-busted JS bundle renders raw i18n keys for translations
 * added since. Stamping the URL with the build id means each new bundle
 * requests URLs no stale cache entry can match. config.json doesn't need
 * this: runtimeConfig fetches it with cache: 'no-store'.
 *
 * Kept in its own side-effect-free module so tests can pin the URL shape
 * without importing config.ts (which initializes the i18next singleton).
 *
 * @module i18n/loadPath
 */

/** Build id injected by Vite `define` (vite.config.ts / vitest.config.ts).
 * Declared here rather than in a .d.ts because the root .gitignore
 * excludes all *.d.ts files (build-emitted declarations). */
declare global {
  const APP_VERSION: string
}

/** i18next-http-backend loadPath, cache-busted per build. */
export const LOCALE_LOAD_PATH = `/locales/{{lng}}/{{ns}}.json?v=${APP_VERSION}`
