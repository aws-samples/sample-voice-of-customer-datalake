/**
 * Prototype drafts (docs/prototype-builder.md, part 2).
 *
 * A draft started over the API (an editor's instruction) shows on the prototype's pane as a banner,
 * "Draft ready: applied to a preview, not saved", with the instruction and the summary; the preview
 * shows the draft (its own URL, a frame without popups) until the editor switches to Current. Apply
 * writes the next version and selects it; a second draft is discarded (the job delete) and its banner
 * goes. From the keyboard, and at 390 px without sideways scroll. Then the same asked for in words: Edit with
 * the assistant, the draft_prototype_revision card with the exact instruction, Approve, and the banner.
 *
 * Mock only: it builds prototypes and writes versions (production stays read-only).
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { revealDocumentRow } from '../lib/canvas'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { overflowsHorizontally, widthMetrics } from '../lib/mode'
import { roleOf, settle, site } from '../lib/fixtures'
import { approve, ask, composer, lastApprovalCard } from '../lib/assistant'
import { installSseTap } from '../lib/sse'

const PROJECT = 'proj_1'
/** The mock job completes on its second read; a few more reads is the margin. */
const MAX_JOB_POLLS = 5
const BANNER = 'Draft ready: applied to a preview, not saved'

/** Reads a job until it is finished; its result. */
async function jobResult(jobId: string): Promise<Record<string, unknown>> {
  for (let poll = 0; poll < MAX_JOB_POLLS; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${PROJECT}/jobs/${jobId}`)
    const record = isRecord(job.body) ? job.body : {}
    if (record['status'] === 'completed' && isRecord(record['result'])) return record['result']
  }
  throw new Error(`the mock job ${jobId} did not complete`)
}

const jobIdOf = (body: unknown): string => stringField(isRecord(body) ? body : undefined, 'job_id') ?? ''

/** Builds a prototype through the mock's job; its document id. */
async function build(title: string): Promise<string> {
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/build-prototype`, { title })
  const documentId = stringField(await jobResult(jobIdOf(started.body)), 'document_id')
  if (documentId === undefined) throw new Error('the mock build-prototype job produced no document')
  return documentId
}

/** Starts a draft of `documentId`'s series and waits for it; the draft id. */
async function draft(documentId: string, instruction: string): Promise<string> {
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/prototypes/${documentId}/drafts`, { instruction })
  expect(started.status).toBe(200)
  const draftId = stringField(await jobResult(jobIdOf(started.body)), 'draft_id')
  if (draftId === undefined) throw new Error('the mock draft job produced no draft id')
  return draftId
}

async function titles(base: string): Promise<string[]> {
  const detail = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
  return listOf(detail.body, 'documents')
    .map((d) => stringField(d, 'title') ?? '')
    .filter((title) => title.startsWith(base))
    .sort()
}

async function openDocument(page: Page, title: string): Promise<Locator> {
  await page.goto(site(`/projects/${PROJECT}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  // Below 1280 px the list holds one section: the Prototypes section is opened first.
  await (await revealDocumentRow(page, title)).click()
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
  return page.getByRole('region', { name: BANNER })
}

/** Presses a button from the keyboard (focus, then Enter). */
async function press(button: Locator): Promise<void> {
  await button.focus()
  await expect(button).toBeFocused()
  await button.press('Enter')
}

test.describe('prototype drafts', () => {
  test.skip(!MOCK, 'builds prototypes and writes versions: mock only')

  test('a draft is previewed and applied as the next version; a second one is discarded', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the builds, drafts and Apply run as the admin editor')
    const base = `Draft e2e ${String(Date.now())}`
    const instruction = 'make the summary a sticky footer on phones'
    const v1 = await build(base)
    await draft(v1, instruction)

    const banner = await openDocument(page, `${base} (v1)`)
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(`Instruction: ${instruction}`)
    await expect(banner.getByRole('listitem')).toHaveCount(2)

    // The draft is in the frame (its own page, no popups); Current switches back to v1.
    const draftFrame = page.locator(`iframe[title="${base} (v1) (draft)"]`)
    await expect(draftFrame).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(page.frameLocator(`iframe[title="${base} (v1) (draft)"]`).getByText(`Draft: ${instruction}`)).toBeVisible()
    await press(banner.getByRole('button', { name: 'Current' }))
    await expect(banner.getByRole('button', { name: 'Current' })).toHaveAttribute('aria-pressed', 'true')
    await expect(draftFrame).toHaveCount(0)
    await expect(page.locator(`iframe[title="${base} (v1)"]`)).toBeVisible()
    await press(banner.getByRole('button', { name: 'Draft' }))
    await expect(draftFrame).toBeVisible()

    // Apply writes v2 and selects it; the applied draft has no banner there.
    await press(banner.getByRole('button', { name: 'Apply as v2' }))
    await expect(page.getByRole('heading', { name: `${base} (v2)`, level: 2 })).toBeVisible()
    await expect(page.getByRole('region', { name: BANNER })).toHaveCount(0)
    expect(await titles(base)).toStrictEqual([`${base} (v1)`, `${base} (v2)`])

    // A second draft, on v2, at phone width: no sideways scroll, then Discard.
    const v2 = (await apiCall('admin', 'GET', `/projects/${PROJECT}`)).body
    const v2Id = listOf(v2, 'documents').map((d) => [stringField(d, 'title'), stringField(d, 'document_id')] as const)
      .find(([title]) => title === `${base} (v2)`)?.[1] ?? ''
    const second = await draft(v2Id, 'drop the footer')
    await page.setViewportSize({ width: 390, height: 844 })
    const again = await openDocument(page, `${base} (v2)`)
    await expect(again.getByRole('button', { name: 'Apply as v3' })).toBeVisible()
    expect(overflowsHorizontally(await widthMetrics(page))).toBe(false)

    await press(again.getByRole('button', { name: 'Discard' }))
    await expect(page.getByRole('region', { name: BANNER })).toHaveCount(0)
    await expect(page.locator(`iframe[title="${base} (v2)"]`)).toBeVisible()
    const gone = await apiCall('admin', 'GET', `/projects/${PROJECT}/prototypes/${v2Id}/drafts/${second}`, undefined, { expect: [404] })
    expect(gone.status).toBe(404)
  })

  // 6.14.00: the same draft asked for in words. The dev mock's assistant proposes draft_prototype_revision on a
  // prototype's page (mock-server.js proposedWrite: the request as the instruction), so the card is the real one.
  test('Edit with the assistant: the approved instruction becomes the draft the banner shows', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the build and the draft run as the admin editor')
    await installSseTap(page)
    const base = `Assistant draft e2e ${String(Date.now())}`
    const request = 'Change this prototype: make the summary a sticky footer on phones'
    await build(base)
    await openDocument(page, `${base} (v1)`)

    // Opens the panel on a new conversation with a starter drafted; the chip names the prototype.
    await press(page.getByRole('button', { name: 'Edit with the assistant' }))
    await expect(composer(page)).toHaveValue('Change this prototype: ')
    await expect(page.getByText(`Editing: ${base} (v1)`).first()).toBeVisible()

    const asked = await ask(page, request)
    expect(asked.summary.interrupted).toBe(true)
    const card = lastApprovalCard(page)
    await expect(card.getByTestId('prototype-draft-instruction')).toHaveText(request)
    await expect(card).toContainText(`${base} (v1)`)

    const approved = await approve(page, (r) => r.request().method() === 'POST' && /\/prototypes\/[^/]+\/drafts$/.test(new URL(r.url()).pathname))
    expect(approved.write?.status()).toBe(200)

    // The draft job runs in the background; when it finishes, the 6.12.00 banner shows it.
    const banner = page.getByRole('region', { name: BANNER })
    await expect(banner).toBeVisible({ timeout: 30_000 })
    await expect(banner).toContainText(`Instruction: ${request}`)
    await expect(banner.getByRole('button', { name: 'Apply as v2' })).toBeVisible()
  })
})
