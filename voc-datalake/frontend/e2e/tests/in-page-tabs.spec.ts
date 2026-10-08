/**
 * P3 — the 7 in-page tabs the URL tabs don't reach (E2E-COVERAGE-GAPS §1b).
 *
 * - FormEditor (feedback forms): Form Settings / Category Routing / Validates /
 *   Theme. The editor is opened from "Create Form" → a template → Continue, each
 *   tab is clicked and its own content checked, then Cancel: NOTHING is saved
 *   (no POST/PUT /feedback-forms is sent), so it is safe in production.
 * - Admin → Logs: Validation Failures / Processing Errors / Scraper Runs (admin
 *   only). Each sub-tab is pressed, its panel's GET answers, and the panel shows
 *   its own content (rows or its empty state). Read only. Also the 2.12 "logs
 *   show no customer data" check: no rendered text block over 200 characters.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { dialogNamed } from '../lib/dialogs'
import { isApi, jsonOf, roleOf, runStep, settle, site } from '../lib/fixtures'
import { listOf, stringField } from '../lib/api'

interface FormTab {
  name: string
  /** Something only this tab's panel renders. */
  shows: (editor: Locator) => Locator
}

const FORM_TABS: readonly FormTab[] = [
  { name: 'Form Settings', shows: (d) => d.getByText('Form Name (Internal)') },
  { name: 'Category Routing', shows: (d) => d.getByRole('heading', { name: 'Category Routing' }) },
  { name: 'Validates', shows: (d) => d.getByRole('heading', { name: 'What This Form Validates' }) },
  { name: 'Theme', shows: (d) => d.getByText('Primary Color') },
]

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
    shows: (m, names) => rowButtons(m, names) ?? m.getByText(/No scrapers configured/),
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
  test('FormEditor: each of its 4 tabs opens its panel (no save)', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const writes: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/feedback-forms/.test(new URL(r.url()).pathname)) writes.push(`${r.method()} ${new URL(r.url()).pathname}`)
    })
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-form-editor-tabs',
      action: async (recorder) => {
        await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
        await settle(page, 600)
        await page.getByRole('button', { name: 'Create Form' }).first().click()
        const wizard = dialogNamed(page, 'Create New Form')
        await wizard.getByRole('button', { name: /General Feedback/ }).click()
        await wizard.getByRole('button', { name: 'Continue' }).click()
        const editor = dialogNamed(page, 'Create New Feedback Form')
        await expect(editor).toBeVisible()
        for (const tab of FORM_TABS) {
          const control = editor.getByRole('tab', { name: tab.name })
          await control.click()
          await expect(control).toHaveAttribute('aria-selected', 'true')
          await expect(tab.shows(editor).first(), `${tab.name} panel`).toBeVisible()
          await expect(editor.getByRole('tab', { selected: true })).toHaveCount(1)
          recorder.note(`${tab.name}: open`)
        }
        await editor.getByRole('button', { name: 'Cancel' }).click()
        await expect(editor).toHaveCount(0)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
    expect(writes, 'the editor was cancelled: nothing written').toEqual([])
  })

  test('Admin logs: each of its 3 sub-tabs loads its panel', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is covered by screens.spec.ts)')
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-admin-logs-tabs',
      action: async (recorder) => {
        await page.goto(site('/admin?tab=logs'), { waitUntil: 'domcontentloaded' })
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
