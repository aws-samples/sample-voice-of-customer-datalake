/**
 * @fileoverview Run a suite under a non-English locale.
 *
 * Every other spec runs under `en`, where a hardcoded literal and its
 * translation are the same string — so they pass whether or not a component is
 * wired to i18next. A suite that renders under another catalogue is the only
 * one that fails when someone puts a literal back. This helper holds the
 * switch so those suites cannot drift on how they do it.
 */
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import i18n from 'i18next'

/**
 * Switch i18next to `lang` for the calling suite, with `bundles` (namespace →
 * catalogue) registered first, and back to `en` afterwards.
 *
 * Call at `describe` body level. The i18next singleton is shared; Vitest
 * isolates per file today, so the `beforeAll` switch holds — but it is asserted
 * before every test rather than assumed, since a switch to a shared pool would
 * otherwise make the suite silently vacuous: under `en` the translated
 * assertions would fail, but any "no English literal" ones would pass for the
 * wrong reason.
 */
export function useLocale(lang: string, bundles: Record<string, object>): void {
  beforeAll(async () => {
    for (const [ns, resources] of Object.entries(bundles)) {
      i18n.addResourceBundle(lang, ns, resources)
    }
    await i18n.changeLanguage(lang)
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })

  beforeEach(() => {
    expect(i18n.language).toBe(lang)
  })
}
