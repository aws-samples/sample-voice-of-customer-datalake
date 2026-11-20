/**
 * 5.35 coverage — the URL-addressed surfaces of 5.00–5.34, read only, both roles where they differ.
 *
 * - Account `/account/profile|preferences|briefing|objectives|access` (pages/Account/accountSections.ts):
 *   each tab is the selected one (`aria-selected`) and shows its own heading. Both roles (every Account tab is
 *   self-scoped).
 * - Administration (7.59.00, main's tabs again: pages/Settings/adminTabs.ts, adminPaths.ts): `/admin` opens General
 *   (h1 "Administration", the search, the "Needs attention" region); every tab `/admin/<tab>`, section
 *   `/admin/<tab>/<section>` and card `#<card>` (Workspaces is workspace-admin.spec.ts's; Engineering agents shows only
 *   where the engineering module is on) renders as the admin at its own address: the tab selected in the tab row (from
 *   `md` up a tablist, below it a select), the section selected in its switch, the named card's anchor and a heading
 *   of it; Version shows a `X.YY.ZZ` platform version. A 7.54.00 address (`/admin/people`, …) is replaced by its new
 *   one. e2e-user is redirected off /admin (AdminRoute).
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

interface AdminSurface {
  /** Under `/admin/`: `<tab>[/<section>][#<card>]` (pages/Settings/adminPaths.ts). */
  location: string
  /** The tab's name (settings:tabs.*), selected in the tab row. */
  tab: string
  /** The section's name (settings:sections.*), selected in the section switch; none on a tab without sections. */
  section?: string
  /** An h2 of the section (the card the location names, when it names one). */
  heading: string
}

const ADMIN_SURFACES: readonly AdminSurface[] = [
  { location: 'general', tab: 'General', heading: 'Brand Configuration' },
  { location: 'general#theme', tab: 'General', heading: 'Default theme' },
  // The source cards carry no heading; the selected section names the place.
  { location: 'sources/plugins', tab: 'Sources', section: 'Source settings', heading: '' },
  { location: 'sources/integrations', tab: 'Sources', section: 'Integrations', heading: 'Integrations' },
  { location: 'sources/inbox', tab: 'Sources', section: 'Email inbox', heading: 'Email inbox' },
  { location: 'sources/radar', tab: 'Sources', section: 'Radar', heading: 'Radar' },
  { location: 'taxonomy/categories', tab: 'Taxonomy', section: 'Categories', heading: 'Feedback Categories' },
  { location: 'taxonomy/dimensions', tab: 'Taxonomy', section: 'Dimensions', heading: 'Dimensions' },
  { location: 'access/policies', tab: 'Privacy & access', section: 'Source policies', heading: 'Source policies' },
  { location: 'access/policies#erasure', tab: 'Privacy & access', section: 'Source policies', heading: 'Source policies' },
  { location: 'access/users', tab: 'Privacy & access', section: 'Users', heading: 'User Administration' },
  { location: 'access/boards', tab: 'Privacy & access', section: 'Boards', heading: 'Feedback boards' },
  { location: 'access/boards#domains', tab: 'Privacy & access', section: 'Boards', heading: 'Company domains' },
  { location: 'access/boards#participants', tab: 'Privacy & access', section: 'Boards', heading: 'Participant email' },
  { location: 'ai', tab: 'AI models', heading: 'AI Models' },
  { location: 'system/logs', tab: 'System', section: 'Logs', heading: 'System Logs' },
  { location: 'system/version', tab: 'System', section: 'Version', heading: 'Version' },
]

/** A padded platform version (`5.34.00`, buildInfo.ts `paddedVersion`). */
const PLATFORM_VERSION = /^\d+\.\d{2}\.\d{2}$/

/** Tailwind's `md`: from here up the tabs are a tablist; below it a select (Settings.tsx). */
const MD_WIDTH = 768

const tabRow = (page: Page): Locator => page.getByRole('tablist', { name: 'Administration tabs', exact: true })

/** The card a location names (`#<card>`), by its anchor (adminTabLabels.ts `cardAnchorId`), or null. */
function cardAnchor(page: Page, location: string): Locator | null {
  const [, card] = location.split('#')
  return card === undefined ? null : page.locator(`#admin-card-${card}`)
}

/** Where the page says it is: the tab selected in the tab row (or the select, below `md`), the section in its switch. */
async function expectPlace(page: Page, surface: AdminSurface): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Administration', exact: true, level: 1 })).toBeVisible()
  if ((page.viewportSize()?.width ?? 0) < MD_WIDTH) {
    const select = page.getByRole('combobox', { name: 'Administration tabs', exact: true })
    await expect(select.locator('option:checked')).toHaveText(new RegExp(`^${surface.tab}`))
  } else {
    await expect(tabRow(page).getByRole('tab', { selected: true })).toHaveText(new RegExp(`^${surface.tab}`))
  }
  if (surface.section !== undefined) {
    const sections = page.getByRole('tablist', { name: surface.tab, exact: true })
    await expect(sections.getByRole('tab', { selected: true })).toHaveText(surface.section)
  }
}

test.describe('Administration tabs, sections and cards', () => {
  test('/admin opens General: the header, the search and the "Needs attention" region', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
    await assertStep(page, role, 'surfaces-admin-general', async () => {
      await visit(page, '/admin')
      await expect.poll(() => where(page), 'replaced by General').toBe('/admin/general')
      await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Search settings', exact: true })).toBeVisible()
      await expect(page.getByRole('tabpanel', { name: /^General/ }).getByRole('status').first()).toBeAttached()
    })
  })

  test("a 7.54.00 address leads to its new place", async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
    await assertStep(page, role, 'surfaces-admin-old-path', async (recorder) => {
      const moved: readonly (readonly [string, string])[] = [
        ['/admin/people', '/admin/access/users'], ['/admin/categories', '/admin/taxonomy/categories'],
        ['/admin/logs', '/admin/system/logs'], ['/admin/brand', '/admin/general'],
      ]
      for (const [old, now] of moved) {
        await visit(page, old)
        await expect.poll(() => where(page), `${old} replaced`).toBe(now)
        recorder.note(`${old} → ${where(page)}`)
      }
    })
  })

  for (const surface of ADMIN_SURFACES) {
    test(`/admin/${surface.location} shows ${surface.section ?? surface.tab} for the admin`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(role !== 'admin', 'admin-only route (the redirect is its own test)')
      await assertStep(page, role, `surfaces-admin-${surface.location.split(/[/#]/).join('-')}`, async (recorder) => {
        await visit(page, `/admin/${surface.location}`)
        const url = new URL(page.url())
        expect(`${url.pathname}${url.hash}`, 'already the canonical form').toBe(`/admin/${surface.location}`)
        await expectPlace(page, surface)
        if (surface.heading !== '') {
          await expect(page.getByRole('heading', { name: surface.heading, exact: true, level: 2 }).first()).toBeVisible()
        }
        const anchor = cardAnchor(page, surface.location)
        if (anchor !== null) await expect(anchor, 'the card the address names').toBeVisible()
        if (surface.location === 'system/version') {
          const platform = page.getByTestId('platform-version')
          await expect(platform).toHaveText(PLATFORM_VERSION)
          recorder.note(`platform version ${await platform.innerText()}`)
        }
      })
    })
  }

  test('e2e-user is redirected away from every tab, section and card', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    test.skip(MOCK, 'e2e-user needs a real login')
    test.skip(role !== 'user', 'the non-admin redirect')
    await assertStep(page, role, 'surfaces-admin-user-redirect', async (recorder) => {
      for (const pathname of ['/admin', ...ADMIN_SURFACES.map((surface) => `/admin/${surface.location}`)]) {
        await visit(page, pathname)
        await expect.poll(() => new URL(page.url()).pathname, `${pathname} redirected`).not.toMatch(/^\/admin(\/|$)/)
        await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toHaveCount(0)
        await expect(tabRow(page)).toHaveCount(0)
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
