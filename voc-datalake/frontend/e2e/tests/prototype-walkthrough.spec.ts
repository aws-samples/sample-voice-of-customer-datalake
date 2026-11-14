/**
 * The guided walkthrough (docs/prototype-builder.md Part 1): a prototype version with saved steps starts its
 * walkthrough by itself the first time a person opens it, once; Next and Back move between steps and Esc skips;
 * Show walkthrough replays it; Don't show again is kept for the series. The Walkthrough editor changes a step, picks
 * an element in the preview for a new one and saves them as a new version (a new file): replayed there, it plays the
 * new text and the picked step is on its screen, not waiting. At 1440 and 390 px, axe clean, no sideways scroll.
 *
 * Mock only: it builds prototypes and writes versions. The dev mock's prototypes carry the walkthrough block
 * (mock-project-actions.js withWalkthrough) and the cards #order-status and #checkout-summary the steps point at.
 */
import { expect, type FrameLocator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { expectNoSeriousAxe, expectNoSidewaysScrolling } from '../lib/a11y'
import { apiCall, stringField } from '../lib/api'
import { revealDocumentRow } from '../lib/canvas'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'
import { roleOf, settle, site } from '../lib/fixtures'

const PROJECT = 'proj_1'
/** The mock job completes on its second read; a few more reads is the margin. */
const MAX_JOB_POLLS = 5
const STEPS = [
  { title: 'Where your order is', body: 'This card says when the parcel arrives.', selector: '#order-status' },
  { title: 'Pay in one place', body: 'The total includes shipping.', selector: '#checkout-summary' },
]

/** Builds v1 of the `title` series through the mock's job; returns its document id. */
async function build(title: string): Promise<string> {
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/build-prototype`, { title })
  const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id') ?? ''
  for (let poll = 0; poll < MAX_JOB_POLLS; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${PROJECT}/jobs/${jobId}`)
    const record = isRecord(job.body) && isRecord(job.body['job']) ? job.body['job'] : job.body
    const documentId = stringField(isRecord(record) && isRecord(record['result']) ? record['result'] : undefined, 'document_id')
    if (documentId !== undefined) return documentId
  }
  throw new Error('the mock build-prototype job produced no document')
}

async function openDocument(page: Page, title: string): Promise<FrameLocator> {
  await page.goto(site(`/projects/${PROJECT}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  // Below 1280 px the list shows one section at a time: its row is reached through the section buttons.
  await (await revealDocumentRow(page, title)).click()
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
  return page.frameLocator(`iframe[title="${title}"]`)
}

async function checkState(page: Page, label: string): Promise<void> {
  await expectNoSeriousAxe(page, label)
  await expectNoSidewaysScrolling(page, label)
}

for (const width of [1440, 390]) {
  test.describe(`prototype walkthrough at ${String(width)} px`, () => {
    test.skip(!MOCK, 'builds prototypes and writes versions: mock only')

    test('starts once, steps with Next, Back and Esc, replays, and the editor saves a new version', async ({ page }, testInfo) => {
      test.skip(roleOf(testInfo) !== 'admin', 'the build and the save run as the admin editor')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      const base = `${RUN_PREFIX}Walkthrough e2e ${String(width)} ${String(Date.now())}`
      const first = await build(base)
      const saved = await apiCall('admin', 'PUT', `/projects/${PROJECT}/prototypes/${first}/walkthrough`, { steps: STEPS })
      expect(saved.status).toBe(201)

      // The first open starts it by itself.
      const frame = await openDocument(page, `${base} (v2)`)
      const popup = frame.getByRole('dialog')
      await expect(popup).toBeVisible({ timeout: 20_000 })
      await expect(popup).toContainText('Step 1 of 2')
      await expect(popup.getByRole('heading', { name: STEPS[0]?.title })).toBeVisible()
      await checkState(page, 'step 1')
      await popup.getByRole('button', { name: 'Next' }).click()
      await expect(popup).toContainText('Step 2 of 2')
      await expect(popup.getByRole('button', { name: 'Done' })).toBeVisible()
      await checkState(page, 'step 2')
      await popup.getByRole('button', { name: 'Back' }).click()
      await expect(popup).toContainText('Step 1 of 2')
      await popup.press('Escape')
      await expect(popup).toBeHidden()

      // Seen: opening the version again does not start it; Show walkthrough replays it.
      const again = await openDocument(page, `${base} (v2)`)
      await settle(page, 1500)
      await expect(again.getByRole('dialog')).toBeHidden()
      await page.getByRole('button', { name: 'Show walkthrough' }).click()
      await expect(again.getByRole('dialog')).toContainText('Step 1 of 2')
      await again.getByRole('dialog').getByRole('button', { name: 'Skip' }).click()
      await expect(again.getByRole('dialog')).toBeHidden()
      await page.getByRole('button', { name: 'Show walkthrough' }).click()
      await expect(again.getByRole('dialog')).toBeVisible()
      // The prototype's own viewport stays on the page: its frame is never taller than the window, whatever the
      // documents list beside it holds (a stretched frame put the fixed popup below the page's visible area).
      const frameBox = await page.locator(`iframe[title="${base} (v2)"]`).boundingBox()
      expect(frameBox?.height ?? Infinity).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0)
      await page.screenshot({ path: testInfo.outputPath(`walkthrough-popup-${String(width)}.png`) })
      await again.getByRole('dialog').getByRole('button', { name: "Don't show again" }).click()
      await expect(again.getByRole('dialog')).toBeHidden()

      // The editor: a new title for step 1, and a third step picked in the preview; saved as v3 (a new file).
      await page.getByRole('button', { name: 'Walkthrough', exact: true }).click()
      const editor = page.getByTestId('walkthrough-editor')
      await expect(editor.getByTestId('walkthrough-step-2')).toBeVisible()
      await checkState(page, 'editor')
      const renamed = 'Your order, at a glance'
      await editor.getByTestId('walkthrough-step-1').getByLabel('Title').fill(renamed)
      await editor.getByRole('button', { name: 'Add a step' }).click()
      await again.locator('#checkout-summary').click()
      const picked = editor.getByTestId('walkthrough-step-3')
      await expect(picked).toBeVisible()
      await picked.getByLabel('Title').fill('Place the order')
      await picked.getByLabel('Text').fill('One button sends it.')
      await checkState(page, 'editor with a picked step')
      await editor.getByRole('button', { name: 'Save as a new version' }).click()
      await expect(page.getByRole('heading', { name: `${base} (v3)`, level: 2 })).toBeVisible({ timeout: 20_000 })

      // v3 is a version this viewer has not seen, but Don't show again (on v2) is kept for the series: no autostart.
      const newest = page.frameLocator(`iframe[title="${base} (v3)"]`).getByRole('dialog')
      await settle(page, 1500)
      await expect(newest).toBeHidden()

      // Replayed on v3: the new text, and the picked step shows there (its screen is this one), not waiting.
      await page.getByRole('button', { name: 'Show walkthrough' }).click()
      await expect(newest.getByRole('heading', { name: renamed })).toBeVisible()
      await checkState(page, 'v3 replay')
      await newest.getByRole('button', { name: 'Next' }).click()
      await newest.getByRole('button', { name: 'Next' }).click()
      await expect(newest).toContainText('Step 3 of 3')
      await expect(newest.getByRole('heading', { name: 'Place the order' })).toBeVisible()
      await expect(newest.getByRole('button', { name: 'Done' })).toBeEnabled()
    })
  })
}
