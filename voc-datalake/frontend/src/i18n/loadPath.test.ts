/**
 * Regression tests for issue #191: pre-#188 browser caches hold locale
 * JSONs with heuristic freshness and serve them for days without a network
 * request, so new bundles rendered raw i18n keys for translations added
 * since. The loadPath must be version-stamped so each build requests URLs
 * no stale cache entry can match.
 */
import { describe, it, expect } from 'vitest'
import { LOCALE_LOAD_PATH } from './loadPath'

describe('LOCALE_LOAD_PATH (issue #191)', () => {
  it('keeps the i18next language/namespace placeholders', () => {
    expect(LOCALE_LOAD_PATH).toContain('/locales/{{lng}}/{{ns}}.json')
  })

  it('is version-stamped so stale cache entries can never match', () => {
    // Shape assertion survives a change of the injected test literal;
    // vitest.config.ts currently defines APP_VERSION as 'test'.
    expect(LOCALE_LOAD_PATH).toMatch(/\?v=.+$/)
  })
})
