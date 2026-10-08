/**
 * Request counts per page load (E2E F10, perf F4/F5, #399). Each of these was
 * once N identical calls; the fix is a shared query (or one batched read), so a
 * regression shows up as a count, not as a failure. READ-only, both roles
 * (Admin › Data Sources only as the admin), safe on production.
 *
 * - `/admin?tab=plugins`: ONE `GET /sources/status` (each SourceCard used to fetch it).
 * - `/feedback-forms`: ONE `GET /feedback-forms?include=stats` and NO per-card
 *   `GET /feedback-forms/{id}/stats` (the list seeds every card's stats).
 * - `/categories`: ONE `GET /feedback/entities` (two hooks share the key).
 * - `/prioritization` (#399): its project details now come in batched
 *   `GET /projects?ids=…` reads, held by `prioritization-requests.spec.ts`.
 *
 * Local dev mock: E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 \
 *   npx playwright test -c playwright.config.ts --project=admin --no-deps tests/request-counts.spec.ts
 */
import { expect, type Page, type Request } from '@playwright/test'
import { test } from '../lib/test'
import { apiUrl } from '../lib/env'
import { roleOf, runStep, settle, site } from '../lib/fixtures'

/** One API GET as `path?search` (path without the API stage prefix). */
interface Get {
  path: string
  search: string
}

/** Every GET the page sends to the app's API from now on. */
function recordGets(page: Page): Get[] {
  const api = new URL(apiUrl())
  const prefix = api.pathname.replace(/\/+$/, '')
  const gets: Get[] = []
  page.on('request', (request: Request) => {
    if (request.method() !== 'GET') return
    const url = new URL(request.url())
    if (url.origin !== api.origin || !url.pathname.startsWith(prefix)) return
    gets.push({ path: url.pathname.slice(prefix.length) || '/', search: url.search })
  })
  return gets
}

const count = (gets: readonly Get[], predicate: (get: Get) => boolean): number => gets.filter(predicate).length

interface CountCase {
  step: string
  path: string
  adminOnly?: boolean
  check: (gets: readonly Get[]) => void
}

const CASES: readonly CountCase[] = [
  {
    step: 'counts-admin-plugins', path: '/admin?tab=plugins', adminOnly: true,
    check: (gets) => {
      expect(count(gets, (g) => g.path === '/sources/status' && g.search === ''), 'GET /sources/status').toBe(1)
      expect(count(gets, (g) => g.path === '/integrations/status'), 'GET /integrations/status').toBeLessThanOrEqual(1)
    },
  },
  {
    step: 'counts-feedback-forms', path: '/feedback-forms',
    check: (gets) => {
      const lists = gets.filter((g) => g.path === '/feedback-forms')
      expect(lists.map((g) => g.search), 'GET /feedback-forms').toEqual(['?include=stats'])
      expect(count(gets, (g) => /^\/feedback-forms\/[^/]+\/stats$/.test(g.path)), 'per-card GET /feedback-forms/{id}/stats').toBe(0)
    },
  },
  {
    step: 'counts-categories', path: '/categories',
    check: (gets) => {
      expect(count(gets, (g) => g.path === '/feedback/entities'), 'GET /feedback/entities').toBe(1)
    },
  },
]

test.describe('request counts per page load', () => {
  for (const c of CASES) {
    test(c.step, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(c.adminOnly === true && role !== 'admin', 'admin-only screen')
      const gets = recordGets(page)
      const { record, problems } = await runStep({
        page, role, theme: 'dark', step: c.step, audit: false,
        action: async (r) => {
          await page.goto(site(c.path), { waitUntil: 'domcontentloaded' })
          await settle(page, 2_000)
          r.note(`API GETs: ${gets.map((g) => `${g.path}${g.search}`).join(', ')}`)
        },
      })
      expect(problems, `${c.step}: ${record.screenshot ?? ''}`).toEqual([])
      c.check(gets)
    })
  }
})
