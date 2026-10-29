/**
 * CSV dataset uploads (issue #411, docs/csv-import.md): a corrected re-upload updates the stored
 * rows instead of adding them again, and only after the person has seen the change.
 *
 * 1. First upload under a dataset name: "Preview changes" (a `dry_run` POST, nothing stored)
 *    counts 2 new rows and 1 row without an id that cannot be updated later; Import stores them.
 * 2. The corrected file under the same name (one typo fixed): the preview lists 1 stored row to
 *    update with its before / after text and 1 unchanged row; "Import and update" sends
 *    `apply_updates` and the result says 1 stored row was updated.
 * 3. The API refuses a real upload that changes stored rows without `apply_updates` (409), and
 *    `GET /feedback` holds the corrected text once and the typo nowhere.
 *
 * MOCK ONLY: on a deployment it would write feedback, which has no delete route.
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/csv-dataset-update.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'
import { openSourceMenu, sourceTile } from '../lib/sources'

/** scrapers.json csvUpload.* strings (English). */
const TEXT = {
  tile: 'Spreadsheet (CSV)',
  dialog: 'CSV upload',
  dataset: 'Dataset name (optional)',
  check: 'Preview changes',
  confirm: 'Import',
  confirmUpdates: 'Import and update',
  done: 'Done',
} as const

// Unique per run, so a rerun against the same mock process starts a fresh dataset.
const STAMP = Date.now()
const DATASET = `Example Air reviews ${STAMP}`
const TYPO = `The app crashs on start ${STAMP}`
const FIXED = `The app crashes on start ${STAMP}`
const FIRST = `id,text,date\n1,Boarding was quick ${STAMP},2026-01-10\n2,${TYPO},2026-01-11\n,No id here ${STAMP},2026-01-12\n`
const CORRECTED = FIRST.replace(TYPO, FIXED)

const CSV_UPLOAD = /\/scrapers\/manual\/csv-upload$/

/** Opens /scrapers → New source → Spreadsheet (CSV) with `csv` chosen and the dataset name typed. */
async function openUpload(page: Page, csv: string): Promise<Locator> {
  await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  const selector = await openSourceMenu(page)
  await sourceTile(selector, TEXT.tile).click()
  const dialog = dialogNamed(page, TEXT.dialog)
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(TEXT.dataset, { exact: true }).fill(DATASET)
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'reviews.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  return dialog
}

/** Clicks `button` and returns the csv-upload request body it sent. */
async function sendFrom(page: Page, dialog: Locator, button: string): Promise<Record<string, unknown>> {
  const request = page.waitForRequest((r) => isApi(r, 'POST', CSV_UPLOAD))
  await dialog.getByRole('button', { name: button, exact: true }).click()
  const body: unknown = (await request).postDataJSON()
  return isRecord(body) ? body : {}
}

test.describe('csv dataset update', () => {
  test.skip(!MOCK, 'writes feedback, which has no delete route: dev mock only')

  test('a corrected re-upload updates the stored row after a preview', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)

    await assertStep(page, role, 'csv-dataset-first-upload', async () => {
      const dialog = await openUpload(page, FIRST)
      const preview = await sendFrom(page, dialog, TEXT.check)
      expect(preview).toMatchObject({ dataset_name: DATASET, dry_run: true })
      await expect(dialog.getByText('2 new rows will be added')).toBeVisible()
      await expect(dialog.getByText('1 row cannot be updated later (no id)')).toBeVisible()
      const upload = await sendFrom(page, dialog, TEXT.confirm)
      expect(upload['dry_run']).toBeUndefined()
      await expect(dialog.getByText('3 rows queued for processing')).toBeVisible()
      await dialog.getByRole('button', { name: TEXT.done, exact: true }).click()
    })

    await assertStep(page, role, 'csv-dataset-corrected-upload', async () => {
      const dialog = await openUpload(page, CORRECTED)
      await sendFrom(page, dialog, TEXT.check)
      await expect(dialog.getByText('1 stored row will be updated')).toBeVisible()
      await expect(dialog.getByText('1 unchanged row will be skipped')).toBeVisible()
      await expect(dialog.getByText('Row 2 (id 2)')).toBeVisible()
      await expect(dialog.getByText(TYPO)).toBeVisible()
      await expect(dialog.getByText(FIXED)).toBeVisible()
      const upload = await sendFrom(page, dialog, TEXT.confirmUpdates)
      expect(upload['apply_updates']).toBe(true)
      await expect(dialog.getByText('1 stored row updated.')).toBeVisible()
      await dialog.getByRole('button', { name: TEXT.done, exact: true }).click()
    })

    await assertStep(page, role, 'csv-dataset-api-guards', async () => {
      const unconfirmed = await apiCall(role, 'POST', '/scrapers/manual/csv-upload', {
        csv_text: CORRECTED.replace(FIXED, `${FIXED}!`), dataset_name: DATASET,
      })
      expect(unconfirmed.status, 'a change without apply_updates').toBe(409)
      const listed = await apiCall(role, 'GET', '/feedback?days=0&limit=500')
      const text = JSON.stringify(listed.body)
      expect(text.split(FIXED).length - 1, 'the corrected row, once').toBe(1)
      expect(text.includes(TYPO), 'the typo is gone').toBe(false)
    })
  })
})
