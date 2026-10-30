/**
 * The in-app Sales feedback board, `/feature-requests/sales-feature-requests` (pages/FeatureRequests,
 * docs/feature-requests.md): the board every pre-boards request belongs to.
 *
 * Admin, one request end to end:
 * - "New request" creates `${RUN_PREFIX}request` (its reporter's own row carries no revenue impact),
 *   `POST /feature-requests` 201, and the detail opens on `?request=<id>`.
 * - "+1 with my customer" adds `Example Air`, committed, 123456 → `POST …/supports` 201; the totals read
 *   "$123,456" (USD currency formatting, never the raw digits), 2 customers, "2 supports".
 * - Search, the Status filter and "Sort by: Committed revenue" find it (the sort is judged on the rendered
 *   Committed figures: every card above it carries at least as much).
 * - The deep link `?request=<id>` opens its dialog on a fresh load (the pre-boards `/feature-requests?request=<id>`
 *   resolves to the request's board first).
 * - Admin → Status → Planned: `PUT …/status` 200, the badge and the Planned filter show it.
 * - Admin → "Delete request" → "Delete this request?" → Delete: gone from the list, `GET` is a 404.
 * The request is not a ledger kind, so `afterAll` deletes it (admin API) if a step failed before the
 * delete, and proves the 404. It is never promoted (that would create a project).
 *
 * e2e-user (production only; the mock has only the admin): opens a listed request and sees no Admin
 * section (no Status select, no "Delete request", no "Promote to project"); a forced `PUT …/status`
 * (with the request's CURRENT status, so nothing could change even if it were accepted) is a 403.
 *
 * Nothing here sends email (create / support / status / delete have no mail path; only promote does).
 *
 * Mock run:
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5482 E2E_API=http://127.0.0.1:3482 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/feature-requests.spec.ts
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { assertStep, isApi, jsonOf, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

const TITLE = `${RUN_PREFIX}request`
const DESCRIPTION = 'Written by the e2e suite: a request with one supporting customer.'
const REPORTER_CUSTOMER = 'Example Labs'
const SUPPORT_CUSTOMER = 'Example Air'
const AMOUNT = 123456
/** `formatUsd(123456, 'en')` (boardFormat.ts): whole dollars, en currency spelling. */
const AMOUNT_USD = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(AMOUNT)
const SUPPORTER_NAME = 'e2e admin'

const state: { id: string } = { id: '' }

const listRegion = (page: Page): Locator => page.getByRole('region', { name: 'Requests' })
/** The seeded board (shared/feature_boards_store.py): every pre-boards request is on it. */
const SALES_BOARD = { slug: 'sales-feature-requests', name: 'Sales feature requests' } as const
/** A request's card on the board, by its id (RequestList's `fr-card-<id>`). */
const cardOf = (page: Page, id: string): Locator => listRegion(page).getByTestId(`fr-card-${id}`)

async function openBoard(page: Page, search = ''): Promise<void> {
  await page.goto(site(`/feature-requests/${SALES_BOARD.slug}${search}`), { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: SALES_BOARD.name, level: 1 })).toBeVisible()
  await expect(listRegion(page)).toBeVisible()
  await settle(page, 300)
}

/** The request's GET status (200 / 404) as the admin. */
async function requestStatus(id: string): Promise<number> {
  return (await apiCall('admin', 'GET', `/feature-requests/${encodeURIComponent(id)}`)).status
}

/** Every card's title and rendered Committed figure (its digits), top to bottom. */
async function cardFigures(page: Page): Promise<Array<{ title: string; committed: number }>> {
  return listRegion(page).locator('[data-testid^="fr-card-"]').evaluateAll((items) => items.map((item) => {
    const title = item.querySelector('button')?.textContent?.trim() ?? ''
    const term = Array.from(item.querySelectorAll('dt')).find((dt) => dt.textContent?.trim() === 'Committed')
    const digits = (term?.nextElementSibling?.textContent ?? '').replace(/\D/g, '')
    return { title, committed: digits === '' ? 0 : Number(digits) }
  }))
}

async function fillCreate(page: Page): Promise<void> {
  const dialog = dialogNamed(page, 'New request')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Title', { exact: true }).fill(TITLE)
  await dialog.getByLabel('Description', { exact: true }).fill(DESCRIPTION)
  await dialog.getByLabel('Customer (required)', { exact: true }).fill(REPORTER_CUSTOMER)
  await dialog.getByLabel('Revenue impact').selectOption('none')
  await dialog.getByLabel('Your name').fill(SUPPORTER_NAME)
}

async function addSupport(detail: Locator): Promise<void> {
  await detail.getByRole('button', { name: '+1 with my customer' }).click()
  const form = detail.getByRole('form', { name: '+1 with my customer' })
  await form.getByLabel('Customer (required)', { exact: true }).fill(SUPPORT_CUSTOMER)
  await form.getByLabel('Revenue impact').selectOption('committed')
  await form.getByLabel('Amount (USD)').fill(String(AMOUNT))
  await form.getByLabel('Your name').fill(SUPPORTER_NAME)
  await form.getByRole('button', { name: 'Add my +1' }).click()
}

/** A request's status badge (StatusBadge's `fr-status-badge`) inside `scope`: the detail dialog or a card. */
const statusBadge = (scope: Locator): Locator => scope.getByTestId('fr-status-badge')

/** The `<dd>` beside a totals term inside `scope`. */
const figure = (scope: Locator, term: string): Locator =>
  scope.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]')

test.describe('feature requests: the in-app board', () => {
  test.afterAll(async () => {
    if (state.id === '') return
    if ((await requestStatus(state.id)) === 200) {
      await apiCall('admin', 'DELETE', `/feature-requests/${encodeURIComponent(state.id)}`)
    }
    expect(await requestStatus(state.id), 'the e2e request is gone').toBe(404)
  })

  test('admin creates a request, +1s it in USD, finds it, deep-links it, plans it and deletes it', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'writes are admin-only')
    const detail = dialogNamed(page, TITLE)

    await assertStep(page, 'admin', 'fr-01-create', async (r) => {
      await openBoard(page)
      await page.getByRole('button', { name: 'New request' }).click()
      await fillCreate(page)
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/feature-requests$/))
      await dialogNamed(page, 'New request').getByRole('button', { name: 'Add request' }).click()
      const response = await created
      expect(response.status()).toBe(201)
      const body = await jsonOf(response)
      state.id = stringField(isRecord(body['request']) ? body['request'] : undefined, 'request_id') ?? ''
      expect(state.id, 'request_id').not.toBe('')
      r.note(`created ${state.id}`)
      await expect(detail).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`[?&]request=${state.id}(&|$)`))
      await expect(detail.getByText(DESCRIPTION)).toBeVisible()
      await expect(statusBadge(detail)).toHaveText('New')
    })

    await assertStep(page, 'admin', 'fr-02-plus-one-usd', async (r) => {
      // The reporter's own +1 is filed with the request, so a reporter with an email is offered "Edit my +1",
      // never a second "+1" (the API refuses it with 409); the second customer's +1 then comes from e2e-user.
      // A viewer without an email (the dev mock) is not matched to the reporter row and +1s here.
      const plusOne = detail.getByRole('button', { name: '+1 with my customer' })
      const editMine = detail.getByRole('button', { name: 'Edit my +1' })
      await expect(plusOne.or(editMine).first()).toBeVisible()
      if (await plusOne.isVisible()) {
        const added = page.waitForResponse((res) => isApi(res, 'POST', /\/feature-requests\/[^/]+\/supports$/))
        await addSupport(detail)
        expect((await added).status()).toBe(201)
        r.note('the second +1 was added in the dialog')
      } else {
        await expect(detail.getByText('You support this request.', { exact: true })).toBeVisible()
        const added = await apiCall('user', 'POST', `/feature-requests/${encodeURIComponent(state.id)}/supports`, {
          name: SUPPORTER_NAME,
          fields: { customer: SUPPORT_CUSTOMER, impact: 'committed', amount_usd: AMOUNT },
        })
        expect(added.status, 'e2e-user files the second +1').toBe(201)
        await openBoard(page, `?request=${encodeURIComponent(state.id)}`)
        r.note('the reporter is offered "Edit my +1"; e2e-user filed the second +1')
      }
      await expect(detail.getByRole('heading', { name: '2 supports' })).toBeVisible()
      await expect(figure(detail, 'Committed')).toHaveText(AMOUNT_USD)
      await expect(figure(detail, 'Customers')).toHaveText('2')
      await expect(detail.getByText(SUPPORT_CUSTOMER, { exact: false }).first()).toBeVisible()
      await expect(detail.getByText(String(AMOUNT), { exact: true })).toHaveCount(0)
      r.note(`Committed reads ${AMOUNT_USD}`)
      await detail.getByRole('button', { name: 'Close' }).click()
      await expect(detail).toBeHidden()
      await expect(figure(cardOf(page, state.id), 'Committed')).toHaveText(AMOUNT_USD)
    })

    await assertStep(page, 'admin', 'fr-03-search-filter-sort', async (r) => {
      const region = listRegion(page)
      await region.getByRole('searchbox', { name: 'Search' }).fill(TITLE)
      await expect(region.getByRole('listitem')).toHaveCount(1)
      await expect(cardOf(page, state.id)).toBeVisible()
      await region.getByRole('searchbox', { name: 'Search' }).fill(`${TITLE}-no-such-request`)
      await expect(region.getByText('No request matches these filters.')).toBeVisible()
      await region.getByRole('searchbox', { name: 'Search' }).fill('')
      await region.getByLabel('Status', { exact: true }).selectOption('new')
      await expect(cardOf(page, state.id)).toBeVisible()
      await region.getByLabel('Status', { exact: true }).selectOption('shipped')
      await expect(cardOf(page, state.id)).toHaveCount(0)
      await region.getByLabel('Status', { exact: true }).selectOption('all')
      await region.getByLabel('Sort by').selectOption('committed')
      await expect(cardOf(page, state.id)).toBeVisible()
      const cards = await cardFigures(page)
      const at = cards.findIndex((card) => card.title === TITLE)
      expect(at, 'listed').toBeGreaterThanOrEqual(0)
      const above = cards.slice(0, at).filter((card) => card.committed < AMOUNT)
      expect(above, 'every card above carries at least as much committed revenue').toEqual([])
      r.note(`sorted by committed: position ${at + 1} of ${cards.length}`)
    })

    await assertStep(page, 'admin', 'fr-04-deep-link', async () => {
      await openBoard(page, `?request=${encodeURIComponent(state.id)}`)
      await expect(detail).toBeVisible()
      await expect(figure(detail, 'Committed')).toHaveText(AMOUNT_USD)
    })

    await assertStep(page, 'admin', 'fr-05-status-planned', async () => {
      const admin = detail.getByRole('region', { name: 'Admin' })
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', /\/feature-requests\/[^/]+\/status$/))
      await admin.getByLabel('Status', { exact: true }).selectOption('planned')
      expect((await saved).status()).toBe(200)
      await expect(statusBadge(detail)).toHaveText('Planned')
      await detail.getByRole('button', { name: 'Close' }).click()
      await listRegion(page).getByLabel('Status', { exact: true }).selectOption('planned')
      await expect(cardOf(page, state.id)).toBeVisible()
      await expect(statusBadge(cardOf(page, state.id))).toHaveText('Planned')
    })

    await assertStep(page, 'admin', 'fr-06-delete', async (r) => {
      await cardOf(page, state.id).getByRole('button', { name: TITLE, exact: true }).click()
      await detail.getByRole('button', { name: 'Delete request' }).click()
      const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', /\/feature-requests\/[^/]+$/))
      await dialogNamed(page, 'Delete this request?').getByRole('button', { name: 'Delete', exact: true }).click()
      expect((await deleted).status()).toBeLessThan(300)
      await expect(detail).toBeHidden()
      await expect(cardOf(page, state.id)).toHaveCount(0)
      expect(await requestStatus(state.id)).toBe(404)
      const list = await apiCall('admin', 'GET', '/feature-requests')
      expect(listOf(list.body, 'requests').some((item) => item['request_id'] === state.id)).toBe(false)
      r.note('deleted: GET is a 404, absent from the list')
    })
  })

  test('e2e-user sees no admin controls and a forced status change is a 403', async ({ page }, testInfo) => {
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(roleOf(testInfo) !== 'user', 'the refusals run as e2e-user')
    const list = await apiCall('user', 'GET', '/feature-requests')
    expect(list.status).toBe(200)
    const viewer = isRecord(list.body) && isRecord(list.body['viewer']) ? list.body['viewer'] : {}
    expect(viewer['is_admin'], 'e2e-user is no board admin').toBe(false)
    const first = listOf(list.body, 'requests')[0]
    const id = stringField(first, 'request_id')
    const title = stringField(first, 'title')
    const current = stringField(first, 'status')
    test.skip(id === undefined || title === undefined || current === undefined, 'no request on the board to open')
    if (id === undefined || title === undefined || current === undefined) return

    await assertStep(page, 'user', 'fr-user-no-admin-controls', async () => {
      await openBoard(page, `?request=${encodeURIComponent(id)}`)
      const detail = dialogNamed(page, title)
      await expect(detail).toBeVisible()
      await expect(detail.getByRole('button', { name: '+1 with my customer' })).toBeVisible()
      await expect(detail.getByRole('region', { name: 'Admin' })).toHaveCount(0)
      await expect(detail.getByRole('button', { name: 'Delete request' })).toHaveCount(0)
      await expect(detail.getByRole('region', { name: 'Promote to project' })).toHaveCount(0)
      await expect(detail.getByLabel('Status', { exact: true })).toHaveCount(0)
    })

    const forced = await apiCall('user', 'PUT', `/feature-requests/${encodeURIComponent(id)}/status`, { status: current })
    expect(forced.status).toBe(403)
  })
})
