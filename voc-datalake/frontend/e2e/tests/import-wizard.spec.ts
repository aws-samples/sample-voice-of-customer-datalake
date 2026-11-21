/**
 * The import wizard on the dev mock (7.67.00, docs/import-wizard.md): Data sources → Import a file.
 *
 * 1. A review export (`;` separators, a byte-order mark, a personal email column): Upload previews it, Map suggests
 *    "Reviews or tickets" and flags the email column, Confirm says what goes where, Import sends the CSV upload with
 *    the wizard's `mapping` and an import tag, and First insights shows the rows imported.
 * 2. A survey export: Map suggests "A survey export", Confirm shows the inferred questions, Import creates an
 *    imported form (Off, `imported`) and imports its rows with the original file; the forms list marks it Imported.
 *
 * MOCK ONLY: on a deployment it would write feedback, which has no delete route.
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/import-wizard.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'

const STAMP = Date.now()
const REVIEWS = `\uFEFFComment;Stars;Email\nBoarding was quick ${STAMP};5;ana@example.com\nThe app crashes on start ${STAMP};1;bo@example.com\n`
const SURVEY = `Response ID,How likely are you to recommend us?,Which plan?\nr1,9,Pro\nr2,6,Free\nr3,10,Pro\n`

async function pick(page: Page, name: string, content: string): Promise<void> {
  await page.goto(site('/scrapers/import'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) })
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

async function sent(page: Page, path: RegExp, click: () => Promise<void>): Promise<Record<string, unknown>> {
  const request = page.waitForRequest((r) => isApi(r, 'POST', path))
  await click()
  const body: unknown = (await request).postDataJSON()
  return isRecord(body) ? body : {}
}

test.describe('import wizard', () => {
  test.skip(!MOCK, 'writes feedback and a form, which have no delete route for imported rows: dev mock only')

  test('a review export and a survey export, from the file to the first insights', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)

    await assertStep(page, role, 'import-wizard-reviews', async () => {
      await pick(page, 'reviews.csv', REVIEWS)
      await expect(page.getByRole('table')).toContainText(`The app crashes on start ${STAMP}`)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('radio', { name: /Reviews or tickets/u })).toBeChecked()
      await expect(page.getByText('Personal data: left out unless you choose another kind.')).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByText('What goes where')).toBeVisible()
      const upload = await sent(page, /\/scrapers\/manual\/csv-upload$/u, () => page.getByRole('button', { name: 'Import' }).click())
      expect(upload).toMatchObject({ delimiter: ';', mapping: { Comment: 'open_text', Email: 'email' } })
      expect(String(upload['import_tag'])).toMatch(/^import-\d{4}-\d{2}-\d{2}-[a-z2-9]{4}$/u)
      await expect(page.getByText('2 rows imported.')).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open the dashboard' })).toBeVisible()
    })

    await assertStep(page, role, 'import-wizard-survey', async () => {
      await pick(page, `Workshop ${STAMP}.csv`, SURVEY)
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('radio', { name: /A survey export/u })).toBeChecked()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByText('The questions it becomes')).toBeVisible()
      await expect(page.getByText('How likely are you to recommend us?')).toBeVisible()
      const created = await sent(page, /\/feedback-forms$/u, () => page.getByRole('button', { name: 'Import' }).click())
      expect(created).toMatchObject({ enabled: false, imported: { from: 'file', filename: `Workshop ${STAMP}.csv` } })
      await expect(page.getByText('3 rows imported.')).toBeVisible()
      await page.goto(site('/feedback-forms'), { waitUntil: 'domcontentloaded' })
      const card = page.getByRole('article').filter({ hasText: `Workshop ${STAMP}` })
      await expect(card.getByText('Imported', { exact: true })).toBeVisible()
    })
  })
})
