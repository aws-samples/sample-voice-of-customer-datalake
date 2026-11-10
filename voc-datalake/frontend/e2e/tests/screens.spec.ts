/**
 * Visits every route and URL tab from the inventory as the project's role.
 * Admin: dark and light themes; user: dark. Admin-only routes must refuse the
 * user (redirect away, no admin data requested). READ only.
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { resolveIds, resolvePath, type Ids } from '../lib/designRun'
import { roleOf, runStep, pinTheme, settle, site, type Theme } from '../lib/fixtures'
import { SCREENS } from '../lib/inventory'
import { apiUrl, type Role } from '../lib/env'
import { breachOf, enforceBudgets, screenDclBudget, screenSlowestCallBudget, slowestApiCall } from '../lib/budgets'

const THEMES: Record<Role, Theme[]> = { admin: ['dark', 'light'], user: ['dark'] }

test.describe('screens', () => {
  const ids: Ids = {}

  test.beforeAll(async ({}, testInfo) => {
    Object.assign(ids, await resolveIds(roleOf(testInfo)))
  })

  for (const screen of SCREENS) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${screen.step} [${theme}]`, async ({ page }, testInfo) => {
        const role = roleOf(testInfo)
        test.skip(!THEMES[role].includes(theme), `${role} runs ${THEMES[role].join('+')} only`)
        const target = resolvePath(screen, ids)
        test.skip(target === null, `no ${screen.needs ?? ''} visible to ${role} to open`)
        await pinTheme(page, theme)

        const { record, problems } = await runStep({
          page, role, theme, step: screen.step,
          action: async (recorder) => {
            await page.goto(site(target ?? '/'), { waitUntil: 'domcontentloaded' })
            await settle(page)
            const heading = await page.getByRole('heading').first().textContent().catch(() => null)
            const landedUrl = new URL(page.url())
            const landed = landedUrl.pathname
            recorder.note(`landed on ${landed}${landedUrl.search}; first heading: ${heading?.trim() ?? '(none)'}`)
            if (screen.adminOnly === true && role === 'user') {
              expect(landed, 'user must be redirected away from an admin route').not.toMatch(/^\/(admin|data-explorer|settings)/)
            }
            if (screen.step === 'not-found') {
              await expect(page.getByText('Page not found')).toBeVisible()
            }
            if (screen.step === 'settings-redirect' && role === 'admin') {
              expect(landed).toBe('/admin')
            }
          },
        })
        expect(problems, `${screen.step}: ${record.screenshot ?? ''}`).toEqual([])
        const slowest = slowestApiCall(record.calls, new URL(apiUrl()).host)
        enforceBudgets(testInfo, [
          breachOf(`screen ${screen.step} [${theme}] DOMContentLoaded`, record.navigation?.domContentLoadedMs ?? null, screenDclBudget(screen.step)),
          breachOf(`screen ${screen.step} [${theme}] slowest call ${slowest?.label ?? ''}`, slowest?.ms ?? null, screenSlowestCallBudget(screen.step)),
        ])
      })
    }
  }
})
