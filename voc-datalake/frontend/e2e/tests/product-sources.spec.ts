/**
 * 7.104.00 Product tab — "Product description from sources" (docs/project-workspace.md → Product tab): the Sources
 * card, Extract, the proposal review and the gaps panel.
 *
 * Under the dev mock (`E2E_MOCK=1`, mock-product-sources.js): on proj_1 (the mock caller's own project) a Markdown
 * file and a PDF are uploaded, a link is added, every source reaches Ready, Extract runs as a Background job, the
 * review shows its rows; one field is accepted, then Accept all proposed; a gap is answered by typing (one more
 * source) and Extract runs again. On proj_2 (the mock's legacy-shaped, read-only project) the tab offers no write.
 *
 * In PRODUCTION nothing is extracted unless `E2E_PRODUCT_EXTRACT=1` (lib/optIn.ts): an extract is a billed model run
 * (Claude Sonnet 5.5 at max effort). With it, on a public `e2e-<run id>-product-sources` project (lib/projects.ts,
 * ledger-recorded, so its sources and proposal go with it): one Markdown source, Extract, accept one field. The
 * e2e-user role, a viewer of a private e2e project, sees the tab read-only.
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/product-sources.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'
import { optIn } from '../lib/optIn'
import { ensureE2eProject, inviteMember } from '../lib/projects'

const EXTRACT_SWITCH = 'E2E_PRODUCT_EXTRACT'
/** How long a production extract may run (the job's own deadline is about 12.5 minutes). */
const EXTRACT_TIMEOUT_MS = 14 * 60_000
const PUBLIC_PROJECT = `${RUN_PREFIX}product-sources`
const PRIVATE_PROJECT = `${RUN_PREFIX}product-sources-viewer`

const sourcesCard = (page: Page) => page.getByRole('region', { name: 'Sources' })
const extractButton = (page: Page) => page.getByRole('button', { name: 'Extract product description' })
const review = (page: Page) => page.getByRole('region', { name: 'Proposed product description' })

async function openProductTab(page: Page, projectId: string): Promise<void> {
  await page.goto(site(`/projects/${encodeURIComponent(projectId)}/product`), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await expect(sourcesCard(page)).toBeVisible()
}

async function uploadFile(page: Page, name: string, mimeType: string, text: string): Promise<void> {
  await sourcesCard(page).locator('input[type="file"]').setInputFiles({ name, mimeType, buffer: Buffer.from(text) })
  await expect(sourcesCard(page).getByRole('listitem').filter({ hasText: name })).toContainText('Ready', { timeout: 60_000 })
}

async function addLink(page: Page, url: string): Promise<void> {
  await page.getByLabel('Add a link').fill(url)
  await page.getByRole('button', { name: 'Add link' }).click()
  await expect(sourcesCard(page).getByRole('listitem').filter({ hasText: 'Sample product page' })).toContainText('Ready', { timeout: 30_000 })
}

/** Extract, then wait for the review (the mock's job finishes on its second read; production within its deadline). */
async function extract(page: Page, timeout: number): Promise<void> {
  const started = page.waitForResponse((r) => isApi(r, 'POST', /\/product-extract$/))
  await extractButton(page).click()
  expect((await started).status(), 'POST …/product-extract').toBe(202)
  await expect(review(page)).toBeVisible({ timeout })
}

async function acceptOneField(page: Page): Promise<void> {
  const boxes = review(page).getByRole('checkbox')
  const count = await boxes.count()
  for (let index = 1; index < count; index += 1) await boxes.nth(index).uncheck()
  const accepted = page.waitForResponse((r) => isApi(r, 'POST', /\/product-proposals\/[^/]+\/accept$/))
  await review(page).getByRole('button', { name: 'Accept selected' }).click()
  expect((await accepted).status(), 'POST …/accept').toBe(200)
  await expect(review(page).getByText('1 field applied.')).toBeVisible()
}

async function expectReadOnly(page: Page): Promise<void> {
  await expect(extractButton(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /drop files here/i })).toHaveCount(0)
  await expect(page.getByLabel('Add a link')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Type answers' })).toHaveCount(0)
}

test.describe('product description from sources', () => {
  test('mock: sources, extract, review, accept, a typed answer and extract again', async ({ page }, testInfo) => {
    test.skip(!MOCK, 'the whole flow runs on the dev mock; production runs it with E2E_PRODUCT_EXTRACT=1 (below)')
    await assertStep(page, roleOf(testInfo), 'product-sources-mock', async () => {
      await openProductTab(page, 'proj_1')
      await uploadFile(page, 'notes.md', 'text/markdown', '# Parcel Pilot\n\nTells people when a parcel will arrive.')
      await uploadFile(page, 'deck.pdf', 'application/pdf', '%PDF-1.7 sample')
      await addLink(page, 'https://example.com/product')
      await extract(page, 30_000)
      await expect(page.getByRole('heading', { name: 'Gaps' })).toBeVisible()
      await acceptOneField(page)
      await review(page).getByRole('button', { name: 'Accept all proposed' }).click()
      await expect(review(page).getByRole('status')).toContainText('applied')
      await page.getByRole('button', { name: 'Type answers' }).click()
      // (the mock proposal's question for differentiators, mock-product-sources.js)
      await page.getByRole('textbox', { name: /Which alternatives do customers compare it with/ }).fill('Works with every carrier (e2e)')
      const saved = page.waitForResponse((r) => isApi(r, 'POST', /\/product-docs\/answers$/))
      await page.getByRole('button', { name: 'Save answers' }).click()
      expect((await saved).status(), 'POST …/product-docs/answers').toBe(201)
      await expect(sourcesCard(page).getByText('Typed answers')).toBeVisible()
      const again = page.waitForResponse((r) => isApi(r, 'POST', /\/product-extract$/))
      await page.getByRole('button', { name: 'Extract again' }).click()
      expect((await again).status(), 'POST …/product-extract (again)').toBe(202)
    })
  })

  test('mock: a read-only project offers no write on the Product tab', async ({ page }, testInfo) => {
    test.skip(!MOCK, 'production checks the viewer role on a private e2e project (below)')
    await assertStep(page, roleOf(testInfo), 'product-sources-mock-readonly', async () => {
      await openProductTab(page, 'proj_2')
      await expectReadOnly(page)
    })
  })

  test('production: one Markdown source, Extract, accept one field (billed, opt-in)', async ({ page }, testInfo) => {
    test.skip(MOCK, 'the mock runs the whole flow above')
    test.skip(!optIn(EXTRACT_SWITCH), 'an extract is a billed model run: set E2E_PRODUCT_EXTRACT=1')
    test.skip(roleOf(testInfo) !== 'admin', 'the admin runs the billed extract once')
    test.setTimeout(EXTRACT_TIMEOUT_MS + 120_000)
    const projectId = await ensureE2eProject(PUBLIC_PROJECT, 'public')
    await assertStep(page, 'admin', 'product-sources-extract', async () => {
      await openProductTab(page, projectId)
      await uploadFile(page, 'e2e-product.md', 'text/markdown',
        '# Parcel Pilot (e2e sample)\n\nParcel Pilot tells online shoppers when a parcel will arrive and lets them reschedule it.')
      await extract(page, EXTRACT_TIMEOUT_MS)
      await acceptOneField(page)
    })
  })

  test('production: a viewer of a private project sees the tab read-only', async ({ page }, testInfo) => {
    test.skip(MOCK, 'the mock checks its read-only project above')
    test.skip(roleOf(testInfo) !== 'user', 'the e2e-user role is the viewer')
    const projectId = await ensureE2eProject(PRIVATE_PROJECT, 'private')
    await inviteMember(projectId, 'user', 'viewer')
    await assertStep(page, 'user', 'product-sources-viewer', async () => {
      await openProductTab(page, projectId)
      await expectReadOnly(page)
    })
  })
})
