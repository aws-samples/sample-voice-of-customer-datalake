/**
 * Feedback boards (5.36, docs/feature-requests.md): the rename, the board list and the admin section.
 * Read-only: nothing here creates, saves or deletes a board (the board writes are unit-tested and the
 * request writes are feature-requests.spec.ts's).
 *
 * - The sidebar's LISTEN item reads "Feedback boards" and opens `/feature-requests`, the board list
 *   (h1 "Feedback boards"), whose seeded Sales board card opens `/feature-requests/sales-feature-requests`.
 * - Admin: the card's Edit links to `/admin?tab=access&section=boards&board=<id>`, the gear
 *   ("Configure boards") to `/admin?tab=access&section=boards`.
 * - Admin: Administration → Privacy & access → Boards lists the boards with the company domains above
 *   them; Edit on the Sales board opens its editor (`&board=brd_sales`), and "Back to boards" returns.
 * - Admin: the Sales card's Delete opens the delete dialog; when the board has requests it asks for the
 *   board's name (Delete stays off until it is typed). The dialog is only cancelled, never confirmed.
 * - e2e-user (production only): the list shows no Edit, no Delete and no gear.
 *
 * Mock run:
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/feedback-boards.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, stringField } from '../lib/api'
import { RUN_PREFIX } from '../lib/env'
import { assertStep, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { recordCreated } from '../lib/ledger'

/** The board seeded on every deployment (shared/feature_boards_store.py) and in the dev mock. */
const SALES = { id: 'brd_sales', slug: 'sales-feature-requests', name: 'Sales feature requests' } as const
const BOARDS_ADMIN = '/admin?tab=access&section=boards'

async function visit(page: Page, pathname: string): Promise<void> {
  await page.goto(site(pathname), { waitUntil: 'domcontentloaded' })
  await settle(page, 400)
}

const salesCard = (page: Page) => page.getByTestId(`board-card-${SALES.id}`)

test.describe('feedback boards', () => {
  test('the nav item, the board list and a board page', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await assertStep(page, role, 'fb-01-list', async (r) => {
      await visit(page, '/')
      const item = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Feedback boards' })
      await expect(item).toHaveAttribute('href', '/feature-requests')
      await item.click()
      await expect(page.getByRole('heading', { name: 'Feedback boards', level: 1 })).toBeVisible()
      await expect(salesCard(page)).toBeVisible()
      r.note(`${String(await page.locator('[data-testid^="board-card-"]').count())} board card(s)`)
    })
    await assertStep(page, role, 'fb-02-open', async () => {
      await salesCard(page).getByRole('link', { name: `Open ${SALES.name}` }).click()
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/feature-requests/${SALES.slug}`)
      await expect(page.getByRole('heading', { name: SALES.name, level: 1 })).toBeVisible()
    })
  })

  test('admin: Edit and the gear lead to Administration → Boards', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'admin controls')
    await assertStep(page, 'admin', 'fb-03-admin-links', async () => {
      await visit(page, '/feature-requests')
      await expect(salesCard(page).getByRole('link', { name: `Edit ${SALES.name}` }))
        .toHaveAttribute('href', `${BOARDS_ADMIN}&board=${SALES.id}`)
      await expect(page.getByRole('link', { name: 'Configure boards' })).toHaveAttribute('href', BOARDS_ADMIN)
    })
    await assertStep(page, 'admin', 'fb-04-admin-section', async () => {
      await page.getByRole('link', { name: 'Configure boards' }).click()
      await expect(page.getByRole('tab', { name: 'Boards', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('heading', { name: 'Company domains', level: 2 })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Feedback boards', level: 2 })).toBeVisible()
      await page.getByRole('button', { name: `Edit ${SALES.name}` }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('board')).toBe(SALES.id)
      await expect(page.getByRole('heading', { name: SALES.name, level: 2 })).toBeVisible()
      await page.getByRole('button', { name: 'Back to boards' }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('board')).toBeNull()
      await expect(page.getByRole('heading', { name: 'Feedback boards', level: 2 })).toBeVisible()
    })
  })

  test('admin: Delete is offered only on an archived board, and asks for the name of one with requests (cancelled)', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'admin controls')
    // 5.48.02: archiving is the step before deleting, so the open seeded board offers no Delete.
    await assertStep(page, 'admin', 'fb-06a-open-board-no-delete', async () => {
      await visit(page, '/feature-requests')
      await expect(salesCard(page)).toBeVisible()
      await expect(salesCard(page).getByRole('button', { name: `Delete ${SALES.name}` })).toHaveCount(0)
    })

    // A board of this run's own, with one request, archived: the dialog is checked there, then the board is removed.
    const name = `${RUN_PREFIX}delete-dialog-board`
    const made = await apiCall('admin', 'POST', '/feature-requests/boards', { name, template: 'blank' })
    expect(made.status, 'POST /feature-requests/boards').toBe(201)
    const board = isRecord(made.body) && isRecord(made.body['board']) ? made.body['board'] : {}
    const boardId = stringField(board, 'board_id') ?? ''
    expect(boardId, 'board_id').not.toBe('')
    // In the run ledger at once: a killed worker leaves the board to the cleanup teardown's sweep.
    recordCreated('board', boardId, name)
    try {
      const request = await apiCall('admin', 'POST', '/feature-requests', {
        board: boardId, title: `${RUN_PREFIX}delete-dialog-request`, description: 'Written by the e2e suite.', name: 'e2e admin', fields: {},
      })
      expect(request.status, 'POST /feature-requests').toBe(201)
      expect((await apiCall('admin', 'PUT', `/feature-requests/boards/${boardId}`, { archived: true })).status, 'archive').toBe(200)
      await assertStep(page, 'admin', 'fb-06-delete-dialog', async (r) => {
        await visit(page, '/feature-requests')
        const card = page.getByTestId(`board-card-${boardId}`)
        await card.getByRole('button', { name: `Delete ${name}`, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Delete this board?' })
        await expect(dialog.getByRole('textbox', { name: 'Type the board name to confirm' })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toHaveCount(0)
        await expect(card).toBeVisible()
        r.note('archived board with 1 request: type-the-name confirm, cancelled, board still there')
      })
    } finally {
      // Soft: a failed cleanup is reported without replacing an error the steps above threw (the ledger sweep retries it).
      const removed = await apiCall('admin', 'DELETE', `/feature-requests/boards/${boardId}?with_requests=true`)
      expect.soft(removed.status, 'the scratch board is deleted').toBeLessThan(300)
    }
  })

  test('e2e-user sees no board admin controls', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'user', 'the non-admin view')
    await assertStep(page, 'user', 'fb-05-user', async () => {
      await visit(page, '/feature-requests')
      await expect(salesCard(page)).toBeVisible()
      await expect(salesCard(page).getByRole('link', { name: /^Edit / })).toHaveCount(0)
      await expect(salesCard(page).getByRole('button', { name: /^Delete / })).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Configure boards' })).toHaveCount(0)
    })
  })
})
