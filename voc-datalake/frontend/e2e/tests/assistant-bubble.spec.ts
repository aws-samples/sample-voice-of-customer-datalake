/**
 * E2E F5 — the draggable assistant launcher, both roles, at 1440 and 390 px.
 *
 * Given any protected page, When the launcher is dragged (mouse) or moved with
 * the arrow keys, Then it stays inside the viewport on every edge and after a
 * resize, and its position survives a reload. Given pages with primary actions
 * (the agent page's sticky Save bar first — the owner's "hovers over the Save
 * button" report), Then the launcher's box never intersects a visible
 * Save / Create / Import / Run button.
 *
 * Writes: e2e-admin creates ONE agent named `e2e-<run id>-bubble-agent`
 * (ledger-recorded) and archives it in afterAll. Nothing else is written; the
 * launcher position lives in this context's localStorage only.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { archiveE2eAgent, createE2eAgent, type E2eAgent } from '../lib/agentFixture'
import { roleOf, settle, site } from '../lib/fixtures'
import { boxOf, expectTravel, intersects, settledBoxOf } from '../lib/geometry'

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
] as const

/**
 * Pages with primary actions, per role (admin-only routes redirect a user).
 * Includes every page whose form save / submit row the R3 audit made a
 * registered sticky bar (`actionBars.audit.test.ts`): Company (both tabs),
 * Account (password + objectives), Connect (Create token), Memory (Remember),
 * Administration data sources and categories.
 */
const ACTION_PAGES: Record<'admin' | 'user', readonly string[]> = {
  admin: [
    '/feedback-forms', '/scrapers', '/projects', '/company', '/company?tab=design', '/account', '/account?tab=objectives',
    '/connect', '/memory', '/admin', '/admin?tab=plugins', '/admin?tab=categories',
  ],
  user: ['/feedback-forms', '/projects', '/company', '/account', '/account?tab=objectives', '/connect', '/memory'],
}
const PRIMARY = /Save|Create|Import|Run|Change Password|Remember|Start reprocess/
/** The app's clamp margin and key steps (src/assistant/bubble/geometry.ts). */
const EDGE = 8
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

const launcher = (page: Page): Locator => page.getByTestId('assistant-launcher')

/** Inside the viewport once settled: a clamp after a resize eases like any other move. */
async function expectInsideViewport(page: Page): Promise<void> {
  const size = page.viewportSize()
  if (size === null) throw new Error('no viewport')
  await expect(async () => {
    const box = await boxOf(launcher(page))
    expect(box.x).toBeGreaterThanOrEqual(EDGE - 1)
    expect(box.y).toBeGreaterThanOrEqual(EDGE - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(size.width - EDGE + 1)
    expect(box.y + box.height).toBeLessThanOrEqual(size.height - EDGE + 1)
  }).toPass({ timeout: 5_000 })
}

/** Every visible primary button, after scrolling the content to the bottom (where Save bars sit). */
async function expectClearOfPrimaryActions(page: Page, where: string): Promise<number> {
  await page.locator('main .overflow-auto').first().evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => undefined)
  // The launcher eases clear of a bar after the scroll (QA 3.00.00 S5): judge where it settles.
  const bubble = await settledBoxOf(launcher(page))
  let checked = 0
  for (const button of await page.getByRole('button', { name: PRIMARY }).all()) {
    if (!(await button.isVisible())) continue
    const box = await button.boundingBox()
    if (box === null) continue
    checked += 1
    const name = (await button.getAttribute('aria-label')) ?? (await button.innerText())
    expect(intersects(bubble, box), `launcher covers "${name.trim()}" on ${where}`).toBe(false)
  }
  return checked
}

async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const start = await boxOf(launcher(page))
  const x = start.x + start.width / 2
  const y = start.y + start.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

let agent: E2eAgent | undefined

test.beforeAll(async ({}, testInfo) => {
  if (roleOf(testInfo) === 'admin') agent = await createE2eAgent('bubble-agent')
})

test.afterAll(async () => {
  await archiveE2eAgent(agent)
})

for (const viewport of VIEWPORTS) {
  test.describe(`assistant launcher at ${viewport.width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
    })

    test(`F5-${viewport.label}-a: never covers the agent page's Save bar`, async ({ page }, testInfo) => {
      test.skip(agent === undefined, `${roleOf(testInfo)} has no e2e agent (admin creates it)`)
      await page.goto(site(`/agents/${agent?.id ?? ''}`))
      await expect(page.getByRole('heading', { name: agent?.name ?? '' })).toBeVisible()
      const save = page.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeVisible()
      expect(intersects(await settledBoxOf(launcher(page)), await boxOf(save))).toBe(false)
      expect(await expectClearOfPrimaryActions(page, 'the agent page')).toBeGreaterThan(0)
    })

    test(`F5-${viewport.label}-b: never covers a primary action on the editor pages`, async ({ page }, testInfo) => {
      for (const path of ACTION_PAGES[roleOf(testInfo)]) {
        await page.goto(site(path))
        await settle(page)
        await expectClearOfPrimaryActions(page, path)
      }
    })

    test(`F5-${viewport.label}-c: drags inside the viewport, survives resize and reload`, async ({ page }) => {
      await page.goto(site('/'))
      await expect(launcher(page)).toBeVisible()
      const before = await boxOf(launcher(page))

      await drag(page, -Math.round(viewport.width / 3), -Math.round(viewport.height / 3))
      const moved = await boxOf(launcher(page))
      expect(moved.x).toBeLessThan(before.x - 20)
      expect(moved.y).toBeLessThan(before.y - 20)
      // The drag did not open the panel.
      await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false')

      // Past every edge: clamped.
      await drag(page, -5000, -5000)
      await expectInsideViewport(page)
      await drag(page, 5000, 5000)
      await expectInsideViewport(page)
      await drag(page, -120, -160)
      const placed = await boxOf(launcher(page))

      // A narrower window keeps it on screen.
      await page.setViewportSize({ width: 320, height: 568 })
      await expectInsideViewport(page)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })

      await page.reload()
      await expect(launcher(page)).toBeVisible()
      const reloaded = await boxOf(launcher(page))
      expect(Math.abs(reloaded.x - placed.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(reloaded.y - placed.y)).toBeLessThanOrEqual(1)
    })

    test(`F5-${viewport.label}-d: keyboard alternative — arrows move, Home resets`, async ({ page }) => {
      await page.goto(site('/'))
      await expect(launcher(page)).toHaveAccessibleName('Open assistant')
      await expect(launcher(page)).toHaveAccessibleDescription(/arrow keys/i)
      const home = await boxOf(launcher(page))
      await launcher(page).focus()
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Shift+ArrowLeft')
      // The launcher eases each move (QA 3.00.00 S5): wait for where it must end up.
      await expectTravel(launcher(page), home, { up: 2 * KEY_STEP, left: KEY_STEP_LARGE }, 'arrows move it up 2 steps, left 1 large step')
      await page.keyboard.press('Home')
      await expectTravel(launcher(page), home, { up: 0, left: 0 }, 'Home puts it back')
    })
  })
}
