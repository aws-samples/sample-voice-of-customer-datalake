/**
 * P3 — locale smoke (E2E-COVERAGE-GAPS I-9, regression s2 F2 "raw i18n key label").
 *
 * For each of the 8 shipped locales × 5 screens, with the language pinned the
 * way the Account switcher persists it (localStorage `voc-language`, a plain
 * code): `<html lang>` is that locale, no raw i18n key is visible (a missing key
 * renders as its key path, `panel.stillGenerating`; the check matches the exact
 * key paths of the English catalogues plus `namespace:key` references, so a
 * hostname or a version never trips it), and the page does not overflow
 * horizontally (longer German / French strings are where that shows first).
 * Admin only (the screens are the same for the user role); read only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { keyPaths, overflowsHorizontally, rawKeysIn, widthMetrics } from '../lib/mode'
import { roleOf, runStep, settle, site } from '../lib/fixtures'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = path.resolve(HERE, '../../public/locales')

/** The shipped locales: one folder each under public/locales (languages.ts `supportedLanguages`, 8). */
const LOCALES = fs.readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const SHIPPED_LOCALE_COUNT = 8
/** A floor well under the real size (thousands): a broken read would yield a handful. */
const MIN_ENGLISH_KEYS = 500

const SCREENS: ReadonlyArray<{ step: string; path: string }> = [
  { step: 'home', path: '/' },
  { step: 'dashboard', path: '/dashboard' },
  { step: 'projects', path: '/projects' },
  { step: 'feedback-forms', path: '/feedback-forms' },
  { step: 'account', path: '/account' },
]

/** Every namespace file of the English catalogue and all their key paths. */
function englishCatalogue(): { namespaces: string[]; keys: Set<string> } {
  const files = fs.readdirSync(path.join(LOCALES_DIR, 'en')).filter((f) => f.endsWith('.json'))
  const namespaces = files.map((f) => f.replace(/\.json$/, ''))
  const keys = new Set(files.flatMap((f) => keyPaths(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en', f), 'utf8')))))
  return { namespaces, keys }
}

const CATALOGUE = englishCatalogue()

/** Visible text plus the accessible names an icon button carries instead of text. */
async function visibleStrings(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('[aria-label], [title], [placeholder]'))
      .flatMap((el) => ['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) ?? ''))
    return [document.body.innerText, ...labels].join('\n')
  })
}

test.describe('i18n smoke', () => {
  test('the English catalogue and the 8 locales were read', () => {
    expect(LOCALES).toHaveLength(SHIPPED_LOCALE_COUNT)
    expect(CATALOGUE.namespaces).toContain('common')
    expect(CATALOGUE.keys.size).toBeGreaterThan(MIN_ENGLISH_KEYS)
  })

  for (const locale of LOCALES) {
    for (const screen of SCREENS) {
      test(`${locale} ${screen.step}`, async ({ page }, testInfo) => {
        const role = roleOf(testInfo)
        test.skip(role !== 'admin', 'admin only: the strings do not differ per role')
        await page.addInitScript((lng: string) => window.localStorage.setItem('voc-language', lng), locale)
        const { record, problems } = await runStep({
          page, role, theme: 'dark', step: `p3-i18n-${locale}-${screen.step}`, audit: false,
          action: async (recorder) => {
            await page.goto(site(screen.path), { waitUntil: 'domcontentloaded' })
            await settle(page, 800)
            await expect(page.locator('html')).toHaveAttribute('lang', locale)
            const raw = rawKeysIn(await visibleStrings(page), CATALOGUE.keys, CATALOGUE.namespaces)
            const widths = await widthMetrics(page)
            recorder.note(`raw keys: ${raw.join(', ') || 'none'}; scrollWidth ${widths.scrollWidth} / ${widths.clientWidth}`)
            expect(raw, 'raw i18n keys on screen').toEqual([])
            expect(overflowsHorizontally(widths), `horizontal overflow ${JSON.stringify(widths)}`).toBe(false)
          },
        })
        expect(problems, record.screenshot ?? '').toEqual([])
      })
    }
  }
})
