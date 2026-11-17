/**
 * 5.35 coverage — the URL-addressed surfaces of 5.00–5.34, read only, both roles where they differ.
 *
 * - Account `/account/profile|preferences|briefing|objectives|access` (pages/Account/accountSections.ts):
 *   each tab is the selected one (`aria-selected`) and shows its own heading. Both roles (every Account tab is
 *   self-scoped).
 * - Administration (7.54.00, pages/Settings/adminTabs.ts, adminPaths.ts): the home `/admin` (h1 "Administration",
 *   its groups, the footer's Release notes link to `/admin/version`); every tab `/admin/<tab>` and every card a path
 *   names `/admin/<tab>/<section>` (Platform, platform admins only, is workspace-admin.spec.ts's) renders as the admin
 *   at its own path: the tab's name as the h1 under "← Administration" (`/admin`), from `lg` up the left navigation's
 *   link of the tab `aria-current="page"` (none for Version; below `lg` the navigation is not shown), no tab row, the
 *   named card's anchor and a heading of the page; Version shows a `X.YY.ZZ` platform version. A path of before
 *   7.54.00 (`/admin/access/users`, …) is not aliased: it opens the home. e2e-user is redirected off /admin
 *   (AdminRoute).
 * - Company `/company/vision|design`.
 * - Agents `/agents` and `/agents/workflows`: the admin gets both tabs; e2e-user gets no tabs and the agents
 *   list on `/agents/workflows`.
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
import { expect, type Locator, type Page } from '@playwright/test'
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

/** The current path plus query (`/account/access`). */
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
    test(`/account/${tab.id} is selected and shows "${tab.heading}"`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      await assertStep(page, role, `surfaces-account-${tab.id}`, async () => {
        await visit(page, `/account/${tab.id}`)
        expect(where(page)).toBe(`/account/${tab.id}`)
        await expectTab(page, tab.label, tab.heading)
      })
    })
  }
})

// ── Administration ────────────────────────────────────────────────────────────

/** What a place shows: an h2 of its page (the card the location names, when it names one), or a button. */
type Shows = { heading: string } | { button: string }

interface AdminSurface {
  /** Under `/admin/`: `<tab>` or `<tab>/<section>` (pages/Settings/adminPaths.ts). */
  location: string
  /** The tab's name (settings:tabs.*): the page's h1 and, from `lg` up, the left navigation's current link. */
  tab: string
  shows: Shows
}

/** The tab Administration's left navigation does not list (the home's footer opens it). */
const NOT_IN_NAV = 'Version'

const ADMIN_SURFACES: readonly AdminSurface[] = [
  // People has no card heading of its own (UserAdmin.tsx): the page's one primary is.
  { location: 'people', tab: 'People', shows: { button: 'Invite person' } },
  // The source cards carry no heading; the Advanced fold (an h2 disclosure) holds the three cards below.
  { location: 'sources', tab: 'Data sources', shows: { heading: 'Advanced' } },
  { location: 'sources/inbox', tab: 'Data sources', shows: { heading: 'Email inbox' } },
  { location: 'sources/radar', tab: 'Data sources', shows: { heading: 'Radar' } },
  { location: 'sources/tokens', tab: 'Data sources', shows: { heading: 'Design-system tokens' } },
  { location: 'logs', tab: 'Logs', shows: { heading: 'System Logs' } },
  { location: 'categories', tab: 'Categories', shows: { heading: 'Feedback Categories' } },
  { location: 'categories/dimensions', tab: 'Categories', shows: { heading: 'Dimensions' } },
  { location: 'boards', tab: 'Feedback boards', shows: { heading: 'Feedback boards' } },
  { location: 'boards/domains', tab: 'Feedback boards', shows: { heading: 'Company domains' } },
  { location: 'boards/participants', tab: 'Feedback boards', shows: { heading: 'Participant email' } },
  { location: 'ai', tab: 'AI models', shows: { heading: 'AI Models' } },
  { location: 'brand', tab: 'Brand & appearance', shows: { heading: 'Brand Configuration' } },
  { location: 'brand/theme', tab: 'Brand & appearance', shows: { heading: 'Default theme' } },
  { location: 'privacy', tab: 'Privacy', shows: { heading: 'Source policies' } },
  { location: 'privacy/erasure', tab: 'Privacy', shows: { heading: 'Source policies' } },
  { location: 'version', tab: 'Version', shows: { heading: 'Version' } },
]

/** A padded platform version (`5.34.00`, buildInfo.ts `paddedVersion`). */
const PLATFORM_VERSION = /^\d+\.\d{2}\.\d{2}$/

/** Tailwind's `lg`: from here up a tab's page has the left navigation (AdminNav.tsx); below it the nav is not shown. */
const LG_WIDTH = 1024

const adminNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Administration', exact: true })

function shown(page: Page, shows: Shows): Locator {
  return 'heading' in shows
    ? page.getByRole('heading', { name: shows.heading, exact: true, level: 2 }).first()
    : page.getByRole('button', { name: shows.button, exact: true })
}

/** The card a location names (`<tab>/<section>`), by its anchor (adminTabLabels.ts `sectionAnchorId`), or null. */
function sectionAnchor(page: Page, location: string): Locator | null {
  const [, section] = location.split('/')
  return section === undefined ? null : page.locator(`#admin-section-${section}`)
}

/** Where the tab's page says it is: its header (back link, h1) and, from `lg` up, the navigation's current link. */
async function expectTabPage(page: Page, tab: string): Promise<void> {
  await expect(page.getByRole('heading', { name: tab, exact: true, level: 1 })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Administration', exact: true })).toHaveAttribute('href', '/admin')
  const nav = adminNav(page)
  if ((page.viewportSize()?.width ?? 0) < LG_WIDTH) {
    await expect(nav).toBeHidden()
    return
  }
  await expect(nav).toBeVisible()
  const current = nav.locator('[aria-current="page"]')
  if (tab === NOT_IN_NAV) {
    await expect(current).toHaveCount(0)
    return
  }
  await expect(nav.getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(current).toHaveCount(1)
}

test.describe('Administration home, tabs and cards', () => {
  test('/admin is the home: its groups and the Release notes link', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
    await assertStep(page, role, 'surfaces-admin-home', async () => {
      await visit(page, '/admin')
      expect(where(page), 'already the canonical form').toBe('/admin')
      await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible()
      for (const group of ['Everyday', 'Regularly', 'Set up once', 'Rare']) {
        await expect(page.getByRole('heading', { name: group, exact: true, level: 2 })).toBeVisible()
      }
      await expect(page.getByRole('link', { name: 'Release notes', exact: true })).toHaveAttribute('href', '/admin/version')
      // No tab page here: no left navigation, no back link.
      await expect(adminNav(page)).toHaveCount(0)
    })
  })

  test('a path of before 7.54.00 is not aliased: it opens the home', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
    await assertStep(page, role, 'surfaces-admin-old-path', async (recorder) => {
      for (const old of ['/admin/access/users', '/admin/taxonomy/categories', '/admin/system/logs']) {
        await visit(page, old)
        await expect.poll(() => where(page), `${old} replaced`).toBe('/admin')
        await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible()
        recorder.note(`${old} → ${where(page)}`)
      }
    })
  })

  for (const surface of ADMIN_SURFACES) {
    const label = 'heading' in surface.shows ? surface.shows.heading : surface.shows.button
    test(`/admin/${surface.location} renders "${label}" for the admin`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
      await assertStep(page, role, `surfaces-admin-${surface.location.replace('/', '-')}`, async (recorder) => {
        await visit(page, `/admin/${surface.location}`)
        expect(where(page), 'already the canonical form').toBe(`/admin/${surface.location}`)
        await expectTabPage(page, surface.tab)
        // One page per tab: no second row of section tabs, no pressed tab buttons.
        await expect(page.getByRole('main').getByRole('tab')).toHaveCount(0)
        await expect(shown(page, surface.shows)).toBeVisible()
        const anchor = sectionAnchor(page, surface.location)
        if (anchor !== null) await expect(anchor, 'the card the path names').toBeVisible()
        if (surface.location === 'version') {
          const platform = page.getByTestId('platform-version')
          await expect(platform).toHaveText(PLATFORM_VERSION)
          recorder.note(`platform version ${await platform.innerText()}`)
        }
      })
    })
  }

  test('e2e-user is redirected away from the home and every tab and card', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(role !== 'user', 'the non-admin redirect')
    await assertStep(page, role, 'surfaces-admin-user-redirect', async (recorder) => {
      for (const pathname of ['/admin', ...ADMIN_SURFACES.map((surface) => `/admin/${surface.location}`)]) {
        await visit(page, pathname)
        await expect.poll(() => new URL(page.url()).pathname, `${pathname} redirected`).not.toMatch(/^\/admin(\/|$)/)
        await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toHaveCount(0)
        await expect(adminNav(page)).toHaveCount(0)
        recorder.note(`${pathname} → ${where(page)}`)
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
    test(`/company/${tab.id} is selected and shows "${tab.heading}"`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      await assertStep(page, role, `surfaces-company-${tab.id}`, async () => {
        await visit(page, `/company/${tab.id}`)
        await expect(page.getByRole('heading', { name: 'Company', level: 1 })).toBeVisible()
        await expectTab(page, tab.label, tab.heading)
      })
    })
  }
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
      await visit(page, '/agents/workflows')
      await expect(page.getByRole('tab', { name: 'Workflows', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
      await expect(page.getByRole('heading', { name: 'Workflow library' })).toBeVisible()
    })
  })

  test('e2e-user has no tabs and /agents/workflows shows the agents list', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(role !== 'user', 'the non-admin fallback')
    await assertStep(page, role, 'surfaces-agents-user', async () => {
      await visit(page, '/agents/workflows')
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
      await visit(page, '/account/profile')
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
