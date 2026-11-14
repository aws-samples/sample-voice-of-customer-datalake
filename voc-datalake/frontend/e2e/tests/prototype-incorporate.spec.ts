/**
 * Incorporate (docs/prototype-builder.md Part 3): an editor selects tester feedback in the prototype's Feedback
 * dialog and incorporates it. The dialog sends the pins' ids only and closes; when the draft is ready its banner
 * lists each item's outcome (Done and what changed, Not done and why); Apply writes v2 and says what it marked
 * and replied to; the dialog then shows the Done pin as "Incorporated in v2" and the Not done pin's reason as the
 * AI's, approved by the editor. At 1440 and 390 px without sideways scroll.
 *
 * Mock only: it builds prototypes and writes versions, marks and replies (production stays read-only). The dev
 * mock seeds proj_1's prototypes with tester pins (mock-project-actions.js seedPins) and answers every other
 * accepted pin Done.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { overflowsHorizontally, widthMetrics } from '../lib/mode'
import { roleOf, settle, site } from '../lib/fixtures'

const PROJECT = 'proj_1'
const MAX_JOB_POLLS = 5
const BANNER = 'Draft ready: applied to a preview, not saved'
const NOTIFY = 'The "Notify me about delays" button does nothing when I click it.'
const THURSDAY = 'I cannot tell whether Thursday is the new date or the old one.'

async function build(title: string): Promise<void> {
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/build-prototype`, { title })
  const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id') ?? ''
  for (let poll = 0; poll < MAX_JOB_POLLS; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${PROJECT}/jobs/${jobId}`)
    if (isRecord(job.body) && job.body['status'] === 'completed') return
  }
  throw new Error('the mock build-prototype job did not complete')
}

async function openDocument(page: Page, title: string): Promise<void> {
  await page.goto(site(`/projects/${PROJECT}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  await page.getByRole('button', { name: title }).first().click()
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
}

async function openFeedback(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Feedback', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Prototype feedback' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function noSideways(page: Page): Promise<void> {
  expect(overflowsHorizontally(await widthMetrics(page))).toBe(false)
}

for (const width of [1440, 390]) {
  test.describe(`prototype Incorporate at ${String(width)} px`, () => {
    test.skip(!MOCK, 'builds prototypes and writes versions, marks and replies: mock only')

    test('selected feedback becomes a draft with per-item outcomes; Apply marks and replies', async ({ page }, testInfo) => {
      test.skip(roleOf(testInfo) !== 'admin', 'the build, the draft and Apply run as the admin editor')
      await page.setViewportSize({ width, height: 900 })
      const base = `Incorporate e2e ${String(width)} ${String(Date.now())}`
      await build(base)
      await openDocument(page, `${base} (v1)`)

      const dialog = await openFeedback(page)
      await dialog.getByRole('checkbox', { name: `Select: ${NOTIFY.slice(0, 50)}`, exact: false }).check()
      await dialog.getByRole('checkbox', { name: `Select: ${THURSDAY.slice(0, 50)}`, exact: false }).check()
      await expect(dialog.getByTestId('feedback-selection-count')).toContainText('2 selected')
      await noSideways(page)
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/prototypes\/[^/]+\/drafts$/.test(new URL(r.url()).pathname))
      await dialog.getByRole('button', { name: 'Incorporate' }).click()
      const body: unknown = (await posted).postDataJSON()
      expect(isRecord(body) && Array.isArray(body['pin_ids']) && !('instruction' in body)).toBe(true)
      await expect(dialog).toBeHidden()

      // The draft's banner, when the job is done: each item's outcome.
      const banner = page.getByRole('region', { name: BANNER })
      await expect(banner).toBeVisible({ timeout: 30_000 })
      const outcomes = banner.getByTestId('draft-outcomes')
      await expect(outcomes.getByRole('listitem')).toHaveCount(2)
      await expect(outcomes.getByRole('listitem').first()).toContainText('Done')
      await expect(outcomes.getByRole('listitem').nth(1)).toContainText('Not done')
      await noSideways(page)

      await banner.getByRole('button', { name: 'Apply as v2' }).click()
      await expect(page.getByRole('heading', { name: `${base} (v2)`, level: 2 })).toBeVisible()
      await expect(page.getByTestId('incorporation-result'))
        .toContainText('Applied as v2: 1 pin marked incorporated, 1 AI reason posted as a reply.')
      await noSideways(page)

      const after = await openFeedback(page)
      await expect(after.getByText('Incorporated in v2').first()).toBeVisible()
      await expect(after.getByTestId('ai-reply-author').first()).toContainText('AI reason, approved by an editor:')
      await noSideways(page)
    })
  })
}
