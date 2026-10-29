/**
 * 5.x Radar (`/radar`, pages/Radar, docs/radar.md): other brands' reviews, kept out
 * of our own numbers. Read-only, both roles.
 *
 * 1. Brands: `GET /radar` 200; the Brand picker lists every brand it answered, and
 *    the chosen brand's view renders (or the "No brand on the Radar yet" empty state).
 * 2. Compare view ("Compared with us"): one row per category with Them / Us / Verdict.
 * 3. Releases: the timeline lists releases with their dates and sources.
 * 4. Reviews: "Read all reviews" opens "<brand> reviews"; a review's Details opens
 *    "Radar review details" (`GET /radar/brands/{brand}/reviews/{id}` 200) on top;
 *    Escape closes that one first, then the reviews list.
 * 5. Admin: Administration → Sources → Radar offers "Scan now". It is NEVER clicked
 *    (a scan runs billed third-party web searches), and the spec fails if any
 *    `POST /radar/scan` leaves the page.
 *
 * A section that is empty on the deployment (no brand, no release, no category,
 * no review in the window) is skipped with its reason as an annotation, not failed.
 * The dev mock (`E2E_MOCK=1`, mock-radar*.js) serves every section filled.
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/radar.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { dialogNamed } from '../lib/dialogs'
import { isRecord } from '../lib/guards'
import { assertStep, escapeRegExp, isApi, jsonOf, roleOf, settle, site } from '../lib/fixtures'

/** radar.json / feedbackDetail.json strings. */
const TEXT = {
  emptyTitle: 'No brand on the Radar yet',
  brand: 'Brand',
  compare: 'Compared with us',
  compareEmpty: 'No category to compare yet.',
  releases: 'Releases',
  releasesEmpty: 'No release found yet. Releases come from the scheduled scan or Scan now.',
  noReviews: 'No reviews in this window',
  readAll: 'Read all reviews',
  reviewList: 'Reviews',
  details: 'Details',
  reviewDialog: 'Radar review details',
  scanNow: 'Scan now',
} as const

/** Administration → Sources → Radar (radarFormat.ts RADAR_SETUP_PATH). */
const RADAR_SETUP_PATH = '/admin?tab=sources&section=radar'

const compareSection = (page: Page): Locator => page.getByRole('region', { name: TEXT.compare })
const releasesSection = (page: Page): Locator => page.getByRole('region', { name: TEXT.releases })
const brandPicker = (page: Page): Locator => page.getByLabel(TEXT.brand, { exact: true })

/** The brand labels `GET /radar` answered. */
function brandLabels(body: Record<string, unknown>): string[] {
  const brands = Array.isArray(body['brands']) ? body['brands'].filter(isRecord) : []
  return brands.flatMap((b) => (typeof b['label'] === 'string' ? [b['label']] : []))
}

/** Fails the test if a Radar scan is ever started from this page. */
function forbidScan(page: Page): string[] {
  const scans: string[] = []
  page.on('request', (r) => { if (isApi(r, 'POST', /\/radar\/scan$/)) scans.push(r.url()) })
  return scans
}

/** Opens /radar; returns the brand labels the API answered ([] = the empty state). */
async function openRadar(page: Page): Promise<string[]> {
  const overview = page.waitForResponse((r) => isApi(r, 'GET', /\/radar$/))
  await page.goto(site('/radar'), { waitUntil: 'domcontentloaded' })
  const response = await overview
  expect(response.status(), 'GET /radar').toBe(200)
  const labels = brandLabels(await jsonOf(response))
  await settle(page, 500)
  return labels
}

/** The label of the brand the picker shows. */
const chosenBrand = async (page: Page): Promise<string> => (await brandPicker(page).locator('option:checked').innerText()).trim()

test.describe('radar', () => {
  test('lists its brands and renders the chosen brand', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const scans = forbidScan(page)
    let labels: string[] = []
    await assertStep(page, role, 'radar-brands', async () => {
      labels = await openRadar(page)
      if (labels.length === 0) {
        await expect(page.getByText(TEXT.emptyTitle, { exact: true })).toBeVisible()
        return
      }
      const options = brandPicker(page).locator('option')
      await expect(options).toHaveCount(labels.length)
      expect((await options.allInnerTexts()).map((t) => t.trim())).toEqual(labels)
      expect(labels).toContain(await chosenBrand(page))
      await expect(releasesSection(page)).toBeVisible()
    })
    expect(scans, 'no Radar scan was started').toEqual([])
    test.skip(labels.length === 0, 'no brand on the Radar in this deployment (empty state shown)')
  })

  test('the compare view shows them against us per category', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const labels = await openRadar(page)
    test.skip(labels.length === 0, 'no brand on the Radar in this deployment')
    await expect(compareSection(page)).toBeVisible()
    test.skip(await compareSection(page).getByText(TEXT.compareEmpty, { exact: true }).isVisible(), 'no category to compare in this window')
    await assertStep(page, role, 'radar-compare', async () => {
      const section = compareSection(page)
      for (const header of ['Category', 'Them', 'Us', 'Verdict']) {
        await expect(section.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
      }
      const rows = section.getByRole('rowheader')
      expect(await rows.count()).toBeGreaterThan(0)
      // Every row offers their reviews of that category ("Read their … reviews in <category>").
      await expect(section.getByRole('button', { name: /^Read their / }).first()).toBeVisible()
    })
  })

  test('the releases timeline lists releases with their sources', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const labels = await openRadar(page)
    test.skip(labels.length === 0, 'no brand on the Radar in this deployment')
    await expect(releasesSection(page)).toBeVisible()
    test.skip(await releasesSection(page).getByText(TEXT.releasesEmpty, { exact: true }).isVisible(), 'no release found yet for this brand')
    await assertStep(page, role, 'radar-releases', async () => {
      const section = releasesSection(page)
      const releases = section.getByTestId('radar-release')
      expect(await releases.count()).toBeGreaterThan(0)
      await expect(releases.first().locator('time')).toBeVisible()
      await expect(releases.first().getByRole('list', { name: 'Sources' }).getByRole('link').first()).toBeVisible()
    })
  })

  test('a brand review opens over the reviews list and Escape closes both in turn', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const scans = forbidScan(page)
    const labels = await openRadar(page)
    test.skip(labels.length === 0, 'no brand on the Radar in this deployment')
    test.skip(await page.getByText(TEXT.noReviews, { exact: true }).isVisible(), 'the chosen brand has no review in the window')
    await assertStep(page, role, 'radar-reviews', async () => {
      const brand = await chosenBrand(page)
      await page.getByRole('button', { name: TEXT.readAll, exact: true }).click()
      const list = dialogNamed(page, `${brand} reviews`)
      await expect(list).toBeVisible()
      const reviews = list.getByRole('list', { name: TEXT.reviewList }).getByRole('listitem')
      await expect(reviews.first()).toBeVisible()

      const fetched = page.waitForResponse((r) => isApi(r, 'GET', /\/radar\/brands\/[^/]+\/reviews\/[^/]+$/))
      await reviews.first().getByRole('link', { name: TEXT.details, exact: true }).click()
      const response = await fetched
      expect(response.status(), new URL(response.url()).pathname).toBe(200)
      const review = dialogNamed(page, TEXT.reviewDialog)
      await expect(review).toBeVisible()
      await expect(review).toContainText(brand)

      // Escape belongs to the top-most dialog: the review first, then the list.
      await page.keyboard.press('Escape')
      await expect(review).toHaveCount(0)
      await expect(list).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialogNamed(page, new RegExp(`^${escapeRegExp(brand)} reviews$`))).toHaveCount(0)
    })
    expect(scans, 'no Radar scan was started').toEqual([])
  })

  test('the admin setup offers Scan now, which is never pressed', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'Scan now is in Administration (admin-only)')
    const scans = forbidScan(page)
    await assertStep(page, role, 'radar-scan-now-present', async () => {
      await page.goto(site(RADAR_SETUP_PATH), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await expect(page.getByRole('button', { name: TEXT.scanNow, exact: true })).toBeVisible()
    })
    expect(scans, 'no Radar scan was started').toEqual([])
  })
})
