/**
 * Back to vN on a prototype (docs/prototype-builder.md, part 2).
 *
 * A prototype revised once (v1 → v2) shows **Back to v1** in its pane's header, for editors.
 * One click (or Enter, from the keyboard) writes v3 from v1 through the existing restore
 * route and selects it; v3 then offers Back to v2, and every earlier version is still listed.
 * Opening v1 itself offers **Restore v1**. (A viewer sees neither: the pane renders it for
 * editors only, as Delete, tested in DocumentsTab.test.tsx.)
 *
 * Mock only: it builds prototypes and writes versions (production stays read-only).
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { roleOf, settle, site } from '../lib/fixtures'
import { revealDocumentRow } from '../lib/canvas'

const PROJECT = 'proj_1'
/** The mock job completes on its second read; a few more reads is the margin. */
const MAX_JOB_POLLS = 5

/** Builds (or, with `base`, revises) a prototype through the mock's job; its document id. */
async function build(title: string, base?: string): Promise<string> {
  const body = base === undefined ? { title } : { title, feedback: 'make the summary sticky', base_prototype_id: base }
  const started = await apiCall('admin', 'POST', `/projects/${PROJECT}/build-prototype`, body)
  const jobId = stringField(isRecord(started.body) ? started.body : undefined, 'job_id') ?? ''
  for (let poll = 0; poll < MAX_JOB_POLLS; poll += 1) {
    const job = await apiCall('admin', 'GET', `/projects/${PROJECT}/jobs/${jobId}`)
    const record = isRecord(job.body) && isRecord(job.body['job']) ? job.body['job'] : isRecord(job.body) ? job.body : {}
    const documentId = stringField(isRecord(record['result']) ? record['result'] : undefined, 'document_id')
    if (documentId !== undefined) return documentId
  }
  throw new Error('the mock build-prototype job produced no document')
}

async function titles(base: string): Promise<string[]> {
  const detail = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
  return listOf(detail.body, 'documents')
    .map((d) => stringField(d, 'title') ?? '')
    .filter((title) => title.startsWith(base))
    .sort()
}

async function openDocument(page: Page, title: string): Promise<void> {
  await page.goto(site(`/projects/${PROJECT}?tab=documents`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  // Below 1280 px the list shows one section at a time: its row is reached through the section buttons.
  await (await revealDocumentRow(page, title)).click()
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
}

test.describe('prototype Back to vN', () => {
  test.skip(!MOCK, 'builds prototypes and writes versions: mock only')

  test('Back to v1 writes v3 from v1 and selects it; earlier versions stay', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the builds and the restore run as the admin editor')
    const base = `Back e2e ${String(Date.now())}`
    const v1 = await build(base)
    await build(base, v1)
    await openDocument(page, `${base} (v2)`)

    const back = page.getByRole('button', { name: 'Back to v1' })
    await expect(back).toHaveAttribute('title', 'Saves v1 again as the newest version. Nothing is deleted.')
    await back.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByRole('heading', { name: `${base} (v3)`, level: 2 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back to v2' })).toBeVisible()
    expect(await titles(base)).toStrictEqual([`${base} (v1)`, `${base} (v2)`, `${base} (v3)`])

    // An older version offers itself.
    await openDocument(page, `${base} (v1)`)
    await expect(page.getByRole('button', { name: 'Restore v1' })).toBeVisible()
  })
})
