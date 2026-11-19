/**
 * P3 — in-page tabs the screens sweep (lib/inventory.ts) does not reach (E2E-COVERAGE-GAPS §1b).
 *
 * - The forms builder (7.55.00, feedback forms): Questions / Flow / Languages / Hidden fields / Test / Share /
 *   Results / Settings. Its tabs are path segments (`/feedback-forms/new/<tab>`), but an unsaved form lives only in
 *   the page's history state (a bare address goes back to the picker), so it is opened the way a person does:
 *   `/feedback-forms/new` → the Blank form template → "Use this template". Each tab is clicked and its own content
 *   checked, then the form is left through the builder's back link with Discard: NOTHING is saved (no POST/PUT/DELETE
 *   under /feedback-forms is sent), so it is safe in production.
 * - Administration → Logs (`/admin/logs`): Validation Failures / Processing Errors / Scraper Runs (admin
 *   only). Each sub-tab is pressed, its panel's GET answers, and the panel shows
 *   its own content (rows or its empty state). Read only. Also the 2.12 "logs
 *   show no customer data" check: no rendered text block over 200 characters.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { dialogNamed } from '../lib/dialogs'
import { escapeRegExp, isApi, jsonOf, roleOf, runStep, settle, site } from '../lib/fixtures'
import { listOf, stringField } from '../lib/api'

interface FormTab {
  name: string
  /** Its path segment (builder/builderPaths.ts BUILDER_TABS). */
  segment: string
  /** Something only this tab's panel renders, on an unsaved Blank form. */
  shows: (main: Locator) => Locator
}

/** The builder's tabs in order (feedbackForms.json builder.tabs); each panel's mark is gone once the next tab opens. */
const FORM_TABS: readonly FormTab[] = [
  { name: 'Questions', segment: 'questions', shows: (m) => m.getByRole('button', { name: 'Improve with AI', exact: true }) },
  { name: 'Flow', segment: 'flow', shows: (m) => m.getByRole('list', { name: 'Questions and their rules' }) },
  { name: 'Languages', segment: 'languages', shows: (m) => m.getByRole('combobox', { name: 'Add language' }) },
  { name: 'Hidden fields', segment: 'hidden-fields', shows: (m) => m.getByRole('heading', { name: 'Hidden fields', level: 2 }) },
  { name: 'Test', segment: 'test', shows: (m) => m.getByRole('switch', { name: 'Test link' }) },
  { name: 'Share', segment: 'share', shows: (m) => m.getByRole('group', { name: 'Show the live or the test link' }) },
  // An unsaved form has no results: the panel is only the "save first" notice (Share shows it under its own controls).
  { name: 'Results', segment: 'results', shows: (m) => m.getByRole('heading', { name: 'No links yet' }) },
  { name: 'Settings', segment: 'settings', shows: (m) => m.getByRole('region', { name: 'Appearance' }) },
]

/** A builder tab by its label; a tab with problems adds them to its name ("Languages, 4 missing translations"). */
const builderTab = (tabs: Locator, name: string): Locator => tabs.getByRole('tab', { name: new RegExp(`^${escapeRegExp(name)}\\b`) })

interface LogsTab {
  name: string
  /** The GET its panel makes. */
  path: RegExp
  /** Its rows, or its empty state; `names` are the row names its GET listed (scrapers). */
  shows: (main: Locator, names: readonly string[]) => Locator
}

/** One button per name (an expandable row), or nothing when there are no names. */
function rowButtons(main: Locator, names: readonly string[]): Locator | null {
  const [first] = names
  return first === undefined ? null : main.getByRole('button', { name: first, exact: true })
}

const LOGS_TABS: readonly LogsTab[] = [
  { name: 'Validation Failures', path: /\/logs\/validation$/, shows: (m) => m.getByText(/\d+ failures?|No validation failures in this period/) },
  { name: 'Processing Errors', path: /\/logs\/processing$/, shows: (m) => m.getByText(/\d+ errors?|No processing errors in this period/) },
  {
    name: 'Scraper Runs', path: /\/scrapers$/,
    // No scraper: the review-page and app connectors' region (ScraperRunsPanel.tsx), or the empty
    // state when no connector is deployed either.
    shows: (m, names) => rowButtons(m, names)
      ?? m.getByRole('region', { name: 'Review pages and apps' }).or(m.getByText(/No data sources that run yet/)),
  },
]

/** Longest text a log panel may render: a review's text is longer (2.12 "logs show no customer data"). */
const MAX_LOG_TEXT_CHARS = 200

/** The longest text block of the logs panels (2.12: logs carry no review text). */
async function longestTextBlock(page: Page): Promise<number> {
  return page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('main p, main span, main pre, main td, main li'))
    return blocks.reduce((max, el) => Math.max(max, (el.textContent ?? '').trim().length), 0)
  })
}

test.describe('in-page tabs', () => {
  test('Form builder: each of its 8 tabs opens its panel (no save)', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const writes: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/feedback-forms/.test(new URL(r.url()).pathname)) writes.push(`${r.method()} ${new URL(r.url()).pathname}`)
    })
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-form-builder-tabs',
      action: async (recorder) => {
        await page.goto(site('/feedback-forms/new'), { waitUntil: 'domcontentloaded' })
        await settle(page, 600)
        await page.getByRole('button', { name: /^Blank form\b/ }).click()
        await expect(page).toHaveURL(/\/feedback-forms\/new\?template=blank$/)
        await page.getByRole('button', { name: 'Use this template', exact: true }).click()
        const main = page.locator('main')
        await expect(main.getByRole('heading', { level: 1, name: 'Blank form' })).toBeVisible()
        await expect(main.getByText('Not saved yet', { exact: true })).toBeVisible()
        const tabs = main.getByRole('tablist', { name: 'Form builder sections' })
        let previous: FormTab | null = null
        for (const tab of FORM_TABS) {
          const control = builderTab(tabs, tab.name)
          await control.click()
          await expect(control).toHaveAttribute('aria-selected', 'true')
          await expect(page).toHaveURL(new RegExp(`/feedback-forms/new/${tab.segment}(?:/|$)`))
          await expect(tab.shows(main).first(), `${tab.name} panel`).toBeVisible()
          if (previous !== null) await expect(previous.shows(main), `${previous.name} panel gone`).toHaveCount(0)
          await expect(tabs.getByRole('tab', { selected: true })).toHaveCount(1)
          recorder.note(`${tab.name}: open`)
          previous = tab
        }
        // Leave unsaved: the back link asks first (the unsaved-changes guard), and Discard drops the form.
        await main.getByRole('link', { name: 'Feedback Forms', exact: true }).click()
        const guard = dialogNamed(page, 'Unsaved changes')
        await guard.getByRole('button', { name: 'Discard', exact: true }).click()
        await expect(guard).toHaveCount(0)
        await expect(page).toHaveURL(/\/feedback-forms$/)
        await expect(main.getByRole('heading', { level: 1, name: 'Feedback Forms' })).toBeVisible()
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
    expect(writes, 'the new form was discarded: nothing written').toEqual([])
  })

  test('Admin logs: each of its 3 sub-tabs loads its panel', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is covered by screens.spec.ts)')
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-admin-logs-tabs',
      action: async (recorder) => {
        await page.goto(site('/admin/logs'), { waitUntil: 'domcontentloaded' })
        await expect(page.getByRole('heading', { name: 'System Logs' })).toBeVisible()
        for (const [index, tab] of LOGS_TABS.entries()) {
          const button = page.getByRole('button', { name: tab.name, exact: true })
          // The first panel is the default and has already loaded; the others load on press.
          const loaded = index === 0 ? null : page.waitForResponse((r) => isApi(r, 'GET', tab.path))
          await button.click()
          await expect(button).toHaveAttribute('aria-pressed', 'true')
          const response = loaded === null ? null : await loaded
          if (response !== null) expect(response.status(), `${tab.name} GET`).toBeLessThan(400)
          const names = response === null ? [] : listOf(await jsonOf(response), 'scrapers').flatMap((s) => stringField(s, 'name') ?? [])
          await expect(tab.shows(page.locator('main'), names).first(), `${tab.name} content`).toBeVisible({ timeout: 20_000 })
          const longest = await longestTextBlock(page)
          recorder.note(`${tab.name}: longest text block ${longest} chars`)
          expect(longest, `${tab.name}: no feedback text in the logs (2.12)`).toBeLessThanOrEqual(MAX_LOG_TEXT_CHARS)
        }
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
  })
})
