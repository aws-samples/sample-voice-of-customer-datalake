/**
 * The prototype Feedback view (docs/prototype-builder.md Part 3): Projects › a project › Documents › a prototype ›
 * Feedback opens every pin of the prototype's series, grouped by screen and folded ("2 testers said this").
 *
 * Two versions of one prototype are built through the mock's build job on proj_1 (one series: the same title); the
 * mock seeds each version with the same tester pins, so every item of v2's feedback folds a pin of each version. At
 * 1440 and 360 wide, with reduced motion: the dialog opens from the prototype's toolbar, a folded item reads "2 testers
 * said this", ticking it says "1 selected, 2 pins", "Select all in this group" ticks the group, Escape closes the
 * dialog with focus back on Feedback; each state passes axe (no serious or critical finding) and scrolls nothing
 * sideways (lib/a11y.ts).
 *
 * MOCK ONLY: it builds prototypes (an LLM job on a deployment), and production pins are testers' own words. From
 * voc-datalake/frontend:
 *   PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
 *   cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/prototype-feedback.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { expectNoSeriousAxe, expectNoSidewaysScrolling } from '../lib/a11y'
import { apiCall, stringField } from '../lib/api'
import { revealDocumentRow } from '../lib/canvas'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'
import { site } from '../lib/fixtures'

const PROJECT = 'proj_1'
const WIDTHS = [1440, 360] as const
const TITLE = `${RUN_PREFIX}feedback prototype ${Date.now()}`
/** The mock job completes on its second read; a few more reads is the margin. */
const MAX_JOB_POLLS = 5

/** Builds one version of the TITLE series through the mock's job; returns its document id. */
async function buildVersion(): Promise<string> {
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/build-prototype`, { title: TITLE })
  const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id') ?? ''
  for (let poll = 0; poll < MAX_JOB_POLLS; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${PROJECT}/jobs/${jobId}`)
    const record = isRecord(job.body) && isRecord(job.body['job']) ? job.body['job'] : job.body
    const result = isRecord(record) && isRecord(record['result']) ? record['result'] : undefined
    const documentId = stringField(result, 'document_id')
    if (documentId !== undefined) return documentId
  }
  throw new Error('the mock build-prototype job produced no document')
}

async function atWidth(page: Page, width: number): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
}

/** Opens the series' newest version (v2) on the Documents tab; returns its Feedback button. */
async function openPrototype(page: Page): Promise<Locator> {
  await page.goto(site(`/projects/${PROJECT}?tab=documents`), { waitUntil: 'domcontentloaded' })
  // Below 1280 px the list holds one section: the Prototypes section is opened first.
  await (await revealDocumentRow(page, `${TITLE} (v2)`)).click()
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true })
  await expect(feedback).toBeVisible({ timeout: 20_000 })
  return feedback
}

async function expectAccessible(page: Page, label: string): Promise<void> {
  await expectNoSeriousAxe(page, label)
  await expectNoSidewaysScrolling(page, label)
}

test.describe('prototype feedback view', () => {
  test.skip(!MOCK, 'mock only: it builds prototypes')

  test.beforeAll(async () => {
    await buildVersion()
    await buildVersion()
  })

  for (const width of WIDTHS) {
    test(`at ${String(width)}: folded items, selection and its count, keyboard, axe`, async ({ page }) => {
      await atWidth(page, width)
      const open = await openPrototype(page)
      await open.click()
      const dialog = dialogNamed(page, 'Prototype feedback')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Testers are anonymous: they cannot be told what changed.')).toBeVisible()

      // Every seeded pin is in both versions, so each item folds two testers.
      const folded = dialog.locator('[data-testid^="feedback-item-"]').filter({ hasText: 'does nothing when I click it' })
      await expect(folded.getByText('2 testers said this')).toBeVisible()
      await expect(folded.getByText('v1, v2')).toBeVisible()
      const count = dialog.getByTestId('feedback-selection-count')
      await expect(count).toHaveText(/^0 selected, 0 pins/)
      await expect(count).toHaveAttribute('aria-live', 'polite')
      await expectAccessible(page, `${String(width)} open`)

      await folded.getByRole('checkbox', { name: /^Select: The "Notify me about delays" button does nothing/ }).check()
      await expect(count).toHaveText(/^1 selected, 2 pins/)

      await dialog.getByRole('region', { name: /^Screen: \// }).getByRole('button', { name: 'Select all in this group' }).click()
      await expect(count).toHaveText(/^4 selected, 8 pins/)
      await expectAccessible(page, `${String(width)} selected`)

      // Keyboard: Escape closes, focus back on Feedback.
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(open).toBeFocused()
    })
  }
})
