/**
 * ops track: a look at D-13 (form-control borders) and D-14 (category colours by
 * rank) against the dev mock, both themes. Screenshots plus two computed-style
 * checks; the unit assertions live in theme/controlBorder.test.ts and
 * pages/Categories/*.test.ts(x). Mock only — never runs against production.
 *
 *   E2E_MOCK=1 E2E_TRACK=ops E2E_BASE_URL=http://localhost:5291 npx playwright test tests/ops-visual-check.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import path from 'node:path'
import { test } from '../lib/test'
import { MOCK, OUT_DIR } from '../lib/env'

const RUN = process.env['E2E_TRACK'] === 'ops' && MOCK
const BASE = process.env['E2E_BASE_URL'] ?? 'http://localhost:5291'
const OUT = process.env['E2E_EVIDENCE_DIR'] ?? path.join(OUT_DIR, 'ops', 'screens')

/** Custom (non-taxonomy) categories, like production's, served in place of the mock's breakdown. */
const CUSTOM_CATEGORIES = {
  subscription_billing: 30, cartridge_quality: 25, app_connectivity: 20, shipping_delays: 10,
  customer_care: 8, setup_experience: 4, water_taste: 2, refunds: 1,
}

/** `--control-border` as computed colours (index.css: #77727f dark, #86818e light). */
const CONTROL_BORDER = { dark: 'rgb(119, 114, 127)', light: 'rgb(134, 129, 142)' } as const

type Mode = keyof typeof CONTROL_BORDER

/** Open `path` in `mode` and screenshot it as `<mode>-<name>.png` once `ready` resolves. */
async function visit(page: Page, mode: Mode, path: string, name: string, ready: () => Promise<void>): Promise<void> {
  await page.goto(`${BASE}${path}`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', `kiro-${mode}`)
  await ready()
  await page.screenshot({ path: `${OUT}/${mode}-${name}.png` })
}

test.describe('ops visual check (mock only)', () => {
  test.skip(!RUN, 'E2E_TRACK=ops E2E_MOCK=1 only')

  for (const mode of ['dark', 'light'] as const) {
    test(`categories + form controls, ${mode}`, async ({ page }) => {
      await page.addInitScript((preference) => {
        localStorage.setItem('voc-theme', JSON.stringify({ state: { preference }, version: 0 }))
      }, mode)
      await page.route('**/metrics/categories**', (route) => route.fulfill({ json: { period_days: 30, categories: CUSTOM_CATEGORIES } }))
      await page.setViewportSize({ width: 1440, height: 1000 })

      await visit(page, mode, '/categories', 'categories', async () => {
        await page.getByRole('button', { name: /show all 8 categories/i }).click({ timeout: 20_000 })
        const bars = await page.getByTestId('category-bar').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))
        expect(new Set(bars.slice(0, 7)).size, bars.join(' | ')).toBe(7)
      })

      await visit(page, mode, '/settings', 'settings', async () => {
        const field = page.locator('input.input, select.select').first()
        await expect(field).toBeVisible({ timeout: 20_000 })
        expect(await field.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(CONTROL_BORDER[mode])
      })

      await visit(page, mode, '/feedback-forms', 'feedback-forms', () => page.waitForLoadState('networkidle'))
    })
  }
})
