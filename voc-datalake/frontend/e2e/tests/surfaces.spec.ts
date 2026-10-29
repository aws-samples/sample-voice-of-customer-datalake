/**
 * 5.35 coverage — the URL-addressed surfaces of 5.00–5.34, read only, both roles where they differ.
 *
 * - Account `/account?tab=profile|preferences|briefing|objectives|access` (pages/Account/accountSections.ts):
 *   each tab is the selected one (`aria-selected`) and shows its own heading; a 5.09–5.11 `?section=mcp` is
 *   rewritten to `?tab=access`. Both roles (every Account tab is self-scoped).
 * - Administration `/admin?tab=…&section=…` (pages/Settings/adminTabs.ts): every tab and section (incl. inbox,
 *   radar, dimensions, policies, version) renders as the admin with its top tab pressed, its section tab selected
 *   and its heading; Version shows a `X.YY.ZZ` platform version. e2e-user is redirected off /admin (AdminRoute).
 * - Company `/company?tab=vision|design`; the retired `?tab=mine` lands on `/account?tab=objectives`.
 * - Agents `/agents` and `/agents?tab=workflows`: the admin gets both tabs; e2e-user gets no tabs and falls back
 *   to the agents list on `?tab=workflows`.
 * - Home's morning brief (docs/briefing.md, mock-briefing.js): header, "Your brief" and "Things to do" render,
 *   never the "could not be built" error; on the mock its cards and the live "needs your decision" card show.
 *   Home is reached by the sidebar's Home link, so a user whose start page is the dashboard still sees it.
 *   Viewing Home marks the caller's own brief cards `seen` (the app's own PUT) — nothing else is written.
 * - The review modal (`?review=<feedback id>`, hooks/useReviewModal.ts, hosted in Layout): opens on a deep link
 *   on /categories, has NO previous/next controls, and Escape closes it and drops the param.
 * - i18n smoke in `de` (`voc-language`, as i18n-smoke.spec.ts) for /participants and /feature-requests:
 *   `<html lang="de">`, no raw key of the `participants` / `featureRequests` namespaces, no horizontal overflow,
 *   and each namespace's German page title visible.
 *
 * Mock vs prod: under `E2E_MOCK=1` only the admin runs (no login); every e2e-user step is prod-only. The review
 * id comes from `GET /feedback` (skipped when the deployment has no feedback).
 *
 * Run (mock): cd voc-datalake/frontend/e2e && E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP>
 *   npx playwright test -c playwright.config.ts tests/surfaces.spec.ts
 * Run (prod): npx playwright test -c playwright.config.ts tests/surfaces.spec.ts (env per e2e/README.md)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK } from '../lib/env'
import { isRecord } from '../lib/guards'
import { assertStep, roleOf, settle, site } from '../lib/fixtures'
import { keyPaths, overflowsHorizontally, rawKeysIn, widthMetrics } from '../lib/mode'

/** Opens `pathname` and waits for the page to settle. */
async function visit(page: Page, pathname: string): Promise<void> {
  await page.goto(site(pathname), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)
}

/** The current path plus query (`/account?tab=access`). */
const where = (page: Page): string => {
  const url = new URL(page.url())
  return `${url.pathname}${url.search}`
}

// ── Account ───────────────────────────────────────────────────────────────────

const ACCOUNT_TABS: ReadonlyArray<{ id: string; label: string; heading: string }> = [
  { id: 'profile', label: 'Profile', heading: 'Profile' },
  { id: 'preferences', label: 'Preferences', heading: 'Language & theme' },
  { id: 'briefing', label: 'Morning brief', heading: 'Morning brief' },
  { id: 'objectives', label: 'Objectives', heading: 'My objectives & KPIs' },
  { id: 'access', label: 'Access & tokens', heading: 'My access' },
]

/** The page shows `label` as the one selected tab and `heading` as a section heading. */
async function expectTab(page: Page, label: string, heading: string): Promise<void> {
  await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
}

test.describe('Account tabs', () => {
  for (const tab of ACCOUNT_TABS) {
    test(`?tab=${tab.id} is selected and shows "${tab.heading}"`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      await assertStep(page, role, `surfaces-account-${tab.id}`, async () => {
        await visit(page, `/account?tab=${tab.id}`)
        expect(where(page)).toBe(`/account?tab=${tab.id}`)
        await expectTab(page, tab.label, tab.heading)
      })
    })
  }

  test('a legacy ?section=mcp is rewritten to ?tab=access', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await assertStep(page, role, 'surfaces-account-legacy-mcp', async () => {
      await visit(page, '/account?section=mcp')
      await expect.poll(() => where(page)).toBe('/account?tab=access')
      await expectTab(page, 'Access & tokens', 'My access')
      await expect(page.getByRole('heading', { name: 'My MCP tokens', exact: true })).toBeVisible()
    })
  })
})

// ── Administration ────────────────────────────────────────────────────────────

interface AdminSurface {
  query: string
  /** The pressed top tab (settings:tabs.*). */
  tab: string
  /** The selected section tab (settings:sections.*), when the tab has sections. */
  section: string | null
  heading: string
}

const ADMIN_SURFACES: readonly AdminSurface[] = [
  { query: 'tab=brand', tab: 'General', section: null, heading: 'Brand Configuration' },
  { query: 'tab=sources&section=plugins', tab: 'Sources', section: 'Source settings', heading: 'Source settings' },
  { query: 'tab=sources&section=integrations', tab: 'Sources', section: 'Integrations', heading: 'Integrations' },
  { query: 'tab=sources&section=inbox', tab: 'Sources', section: 'Email inbox', heading: 'Email inbox' },
  { query: 'tab=sources&section=radar', tab: 'Sources', section: 'Radar', heading: 'Radar' },
  { query: 'tab=taxonomy&section=categories', tab: 'Taxonomy', section: 'Categories', heading: 'Feedback Categories' },
  { query: 'tab=taxonomy&section=dimensions', tab: 'Taxonomy', section: 'Dimensions', heading: 'Dimensions' },
  { query: 'tab=access&section=policies', tab: 'Privacy & access', section: 'Source policies', heading: 'Source policies' },
  { query: 'tab=access&section=users', tab: 'Privacy & access', section: 'Users', heading: 'User Administration' },
  { query: 'tab=access&section=boards', tab: 'Privacy & access', section: 'Boards', heading: 'Feedback boards' },
  { query: 'tab=ai', tab: 'AI models', section: null, heading: 'AI Models' },
  { query: 'tab=system&section=logs', tab: 'System', section: 'Logs', heading: 'System Logs' },
  { query: 'tab=system&section=version', tab: 'System', section: 'Version', heading: 'Version' },
]

/** A padded platform version (`5.34.00`, buildInfo.ts `paddedVersion`). */
const PLATFORM_VERSION = /^\d+\.\d{2}\.\d{2}$/

test.describe('Administration tabs and sections', () => {
  for (const surface of ADMIN_SURFACES) {
    test(`/admin?${surface.query} renders "${surface.heading}" for the admin`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
      await assertStep(page, role, `surfaces-admin-${surface.query.replace(/[=&]/g, '-')}`, async (recorder) => {
        await visit(page, `/admin?${surface.query}`)
        expect(where(page), 'already the canonical form').toBe(`/admin?${surface.query}`)
        await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible()
        await expect(page.getByRole('button', { name: surface.tab, exact: true, pressed: true })).toBeVisible()
        if (surface.section === null) {
          await expect(page.getByRole('tab')).toHaveCount(0)
        } else {
          await expect(page.getByRole('tab', { name: surface.section, exact: true })).toHaveAttribute('aria-selected', 'true')
          await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
        }
        await expect(page.getByRole('heading', { name: surface.heading, exact: true, level: 2 }).first()).toBeVisible()
        if (surface.query.endsWith('section=version')) {
          const platform = page.getByTestId('platform-version')
          await expect(platform).toHaveText(PLATFORM_VERSION)
          recorder.note(`platform version ${await platform.innerText()}`)
        }
      })
    })
  }

  test('e2e-user is redirected away from every Administration section', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(role !== 'user', 'the non-admin redirect')
    await assertStep(page, role, 'surfaces-admin-user-redirect', async (recorder) => {
      for (const surface of ADMIN_SURFACES) {
        await visit(page, `/admin?${surface.query}`)
        await expect.poll(() => new URL(page.url()).pathname, `${surface.query} redirected`).not.toBe('/admin')
        await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toHaveCount(0)
        recorder.note(`${surface.query} → ${where(page)}`)
      }
    })
  })
})

// ── Company ───────────────────────────────────────────────────────────────────

test.describe('Company tabs', () => {
  const tabs: ReadonlyArray<{ id: string; label: string; heading: string }> = [
    { id: 'vision', label: 'Vision & objectives', heading: 'Company context' },
    { id: 'design', label: 'Design system', heading: 'Design system' },
  ]
  for (const tab of tabs) {
    test(`/company?tab=${tab.id} is selected and shows "${tab.heading}"`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      await assertStep(page, role, `surfaces-company-${tab.id}`, async () => {
        await visit(page, `/company?tab=${tab.id}`)
        await expect(page.getByRole('heading', { name: 'Company', level: 1 })).toBeVisible()
        await expectTab(page, tab.label, tab.heading)
      })
    })
  }

  test('/company?tab=mine lands on /account?tab=objectives', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await assertStep(page, role, 'surfaces-company-mine', async () => {
      await visit(page, '/company?tab=mine')
      await expect.poll(() => where(page)).toBe('/account?tab=objectives')
      await expectTab(page, 'Objectives', 'My objectives & KPIs')
    })
  })
})

// ── Agents ────────────────────────────────────────────────────────────────────

test.describe('Agents list tabs', () => {
  test('the admin gets the Agents and Workflows tabs', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'only admins have the workflow library')
    await assertStep(page, role, 'surfaces-agents-admin', async () => {
      await visit(page, '/agents')
      await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('heading', { name: 'Workflow library' })).toHaveCount(0)
      await visit(page, '/agents?tab=workflows')
      await expect(page.getByRole('tab', { name: 'Workflows', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
      await expect(page.getByRole('heading', { name: 'Workflow library' })).toBeVisible()
    })
  })

  test('e2e-user has no tabs and ?tab=workflows falls back to the agents list', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(role !== 'user', 'the non-admin fallback')
    await assertStep(page, role, 'surfaces-agents-user', async () => {
      await visit(page, '/agents?tab=workflows')
      await expect(page.getByRole('heading', { name: 'Autonomous agents', level: 1 })).toBeVisible()
      await expect(page.getByRole('tab')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Workflow library' })).toHaveCount(0)
    })
  })
})

// ── Home: the morning brief ───────────────────────────────────────────────────

test.describe('Home morning brief', () => {
  test('the brief renders its sections (cards on the mock), never its error', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    await assertStep(page, role, 'surfaces-home-brief', async (recorder) => {
      // Reach Home in-app: a fresh load of `/` honours a "dashboard" start page.
      await visit(page, '/account?tab=profile')
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Home', exact: true }).click()
      await expect.poll(() => new URL(page.url()).pathname).toBe('/')
      await settle(page, 800)
      await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 1 })).toBeVisible()
      await expect(page.getByText('The last brief could not be built. Press Refresh to try again.')).toHaveCount(0)
      const cards = page.getByRole('region', { name: 'Your brief' })
      await expect(cards).toBeVisible()
      await expect(page.getByRole('region', { name: 'Things to do' })).toBeVisible()
      const count = await cards.getByRole('listitem').count()
      recorder.note(`brief cards: ${count}`)
      if (count === 0) await expect(cards.getByText('Nothing new in your brief.')).toBeVisible()
      if (MOCK) {
        expect(count, 'the mock brief has cards').toBeGreaterThan(0)
        await expect(cards.getByRole('button', { name: 'Investigate' }).first()).toBeVisible()
        await expect(page.getByRole('article', { name: /needs your decision$/ }).first(), 'the live agent-decision card').toBeVisible()
      }
    })
  })
})

// ── Review modal ──────────────────────────────────────────────────────────────

/** Any previous / next walking control (none may exist in the review modal). */
const PREV_NEXT = /\b(prev|previous|next|older|newer)\b/i

/** The id of one feedback item the caller can see, or null when there is none. */
async function someFeedbackId(role: 'admin' | 'user'): Promise<string | null> {
  const res = await apiCall(role, 'GET', '/feedback?days=0&limit=1')
  expect(res.status, 'GET /feedback').toBe(200)
  return stringField(listOf(res.body, 'items')[0], 'feedback_id') ?? null
}

test.describe('Review modal deep link', () => {
  test('?review=<id> opens the modal without prev/next; Escape closes it and drops the param', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const id = await someFeedbackId(role)
    test.skip(id === null, 'no visible feedback in this deployment')
    await assertStep(page, role, 'surfaces-review-modal', async (recorder) => {
      await visit(page, `/categories?review=${encodeURIComponent(id ?? '')}`)
      const modal = dialogNamed(page, 'Review details')
      await expect(modal).toBeVisible()
      await expect(modal.getByRole('button', { name: 'Close review' })).toBeVisible()
      await expect(modal.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', `/feedback/${encodeURIComponent(id ?? '')}`)
      await expect(modal.getByRole('button', { name: PREV_NEXT })).toHaveCount(0)
      await expect(modal.getByRole('link', { name: PREV_NEXT })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
      await expect.poll(() => new URL(page.url()).searchParams.has('review')).toBe(false)
      expect(new URL(page.url()).pathname).toBe('/categories')
      recorder.note(`review ${id ?? ''} opened and closed`)
    })
  })
})

// ── i18n smoke (de) ───────────────────────────────────────────────────────────

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/locales')
const I18N_NAMESPACES = ['participants', 'featureRequests'] as const

function catalogue(locale: string, namespace: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf8'))
}

/** `page.title` of a namespace in a locale (the page heading the smoke expects). */
function pageTitle(locale: string, namespace: string): string {
  const root = catalogue(locale, namespace)
  const page = isRecord(root) ? root['page'] : undefined
  const title = isRecord(page) ? page['title'] : undefined
  if (typeof title !== 'string' || title === '') throw new Error(`${locale}/${namespace}.json has no page.title`)
  return title
}

/** A floor well under the real size of the two namespaces: a broken read yields a handful. */
const MIN_I18N_KEYS = 50

const I18N_KEYS = new Set(I18N_NAMESPACES.flatMap((ns) => [...keyPaths(catalogue('en', ns)), ...keyPaths(catalogue('de', ns))]))

const I18N_SCREENS: ReadonlyArray<{ path: string; namespace: typeof I18N_NAMESPACES[number] }> = [
  { path: '/participants', namespace: 'participants' },
  { path: '/feature-requests', namespace: 'featureRequests' },
]

/** Visible text plus the accessible names an icon button carries instead of text. */
async function visibleStrings(page: Page): Promise<string> {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('[aria-label], [title], [placeholder]'))
      .flatMap((el) => ['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) ?? ''))
    return [document.body.innerText, ...labels].join('\n')
  })
}

test.describe('i18n smoke (de): participants and feature requests', () => {
  test('the de/en catalogues of both namespaces were read', () => {
    expect(I18N_KEYS.size).toBeGreaterThan(MIN_I18N_KEYS)
    for (const ns of I18N_NAMESPACES) expect(pageTitle('de', ns)).not.toBe(pageTitle('en', ns))
  })

  for (const screen of I18N_SCREENS) {
    test(`de ${screen.path}: lang, German title, no raw keys, no overflow`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      await page.addInitScript(() => window.localStorage.setItem('voc-language', 'de'))
      await assertStep(page, role, `surfaces-i18n-de-${screen.namespace}`, async (recorder) => {
        await visit(page, screen.path)
        await expect(page.locator('html')).toHaveAttribute('lang', 'de')
        await expect(page.getByRole('heading', { name: pageTitle('de', screen.namespace), exact: true }).first()).toBeVisible()
        const raw = rawKeysIn(await visibleStrings(page), I18N_KEYS, I18N_NAMESPACES)
        const widths = await widthMetrics(page)
        recorder.note(`raw keys: ${raw.join(', ') || 'none'}; scrollWidth ${widths.scrollWidth} / ${widths.clientWidth}`)
        expect(raw, 'raw i18n keys on screen').toEqual([])
        expect(overflowsHorizontally(widths), `horizontal overflow ${JSON.stringify(widths)}`).toBe(false)
      })
    })
  }
})
