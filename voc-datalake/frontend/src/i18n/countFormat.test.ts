/**
 * Counts inside sentences follow the app language's digit grouping.
 *
 * The locale strings spell a count as `{{count, number}}` (i18next's built-in
 * `Intl.NumberFormat` formatter, run with the active language), so a workspace
 * of 16799 reviews reads "16,799" in English and "16.799" in German — the same
 * spelling `utils/numberFormat.formatCount` gives the figures outside sentences.
 * Rendered through a real i18next instance built from the app's own init options
 * and the real catalogues, so a change to either is what this judges.
 */
import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'
import { I18N_INIT_OPTIONS } from './options'
import { formatCount } from '../utils/numberFormat'
import enDashboard from '../../public/locales/en/dashboard.json'
import deDashboard from '../../public/locales/de/dashboard.json'
import enCategories from '../../public/locales/en/categories.json'
import deCategories from '../../public/locales/de/categories.json'

/** Large enough to need a group separator in every locale. */
const WORKSPACE_TOTAL = 16799

async function translatorFor(lng: 'en' | 'de') {
  const instance = createInstance()
  await instance.init({
    ...I18N_INIT_OPTIONS,
    lng,
    ns: ['dashboard', 'categories'],
    resources: {
      en: { dashboard: enDashboard, categories: enCategories },
      de: { dashboard: deDashboard, categories: deCategories },
    },
  })
  return instance.t
}

describe('a count inside a sentence', () => {
  it.each([
    ['en', '16,799'],
    ['de', '16.799'],
  ] as const)('is grouped the %s way in the Dashboard workspace total', async (lng, grouped) => {
    const t = await translatorFor(lng)
    const text = t('dashboard:windowEmpty.body', { count: WORKSPACE_TOTAL, date: 'D' })
    expect(text).toContain(grouped)
    expect(text).not.toContain(String(WORKSPACE_TOTAL))
  })

  it.each([
    ['en', '1,200 shown of 16,799'],
    ['de', '1.200 von 16.799 angezeigt'],
  ] as const)('groups both numbers of a "shown of total" line in %s', async (lng, expected) => {
    const t = await translatorFor(lng)
    expect(t('categories:results.shownOf', { count: 1200, total: WORKSPACE_TOTAL })).toBe(expected)
  })

  it.each(['en', 'de'] as const)('spells the same digits as formatCount in %s', async (lng) => {
    const t = await translatorFor(lng)
    expect(t('categories:results.shownOf', { count: 1200, total: WORKSPACE_TOTAL })).toContain(formatCount(WORKSPACE_TOTAL, lng))
  })
})

describe('a plural count', () => {
  it.each([
    ['en', 1, '1 issue or comment in this period (2,500 without a version)'],
    ['en', 16799, '16,799 issues and comments in this period (2,500 without a version)'],
    ['de', 1, '1 Issue oder Kommentar in diesem Zeitraum (2.500 ohne Version)'],
    ['de', 16799, '16.799 Issues und Kommentare in diesem Zeitraum (2.500 ohne Version)'],
  ] as const)('picks the plural form from the raw number and groups it (%s, %i)', async (lng, count, expected) => {
    const t = await translatorFor(lng)
    expect(t('dashboard:github.subtitle', { count, unversioned: 2500 })).toBe(expected)
  })
})
