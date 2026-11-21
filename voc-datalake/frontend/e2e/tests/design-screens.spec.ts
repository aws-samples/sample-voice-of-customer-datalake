/**
 * Design track: every route and URL tab (lib/inventory.ts) in dark and light,
 * at the project's viewport, with axe (recorder) + the deep audit
 * (lib/deepAudit.ts) + a keyboard walk. Desktop projects also re-render each
 * screen at 720×450 CSS px — what a 1440 px window shows at 200% zoom — for
 * the reflow check. READ only: nothing is clicked except Tab.
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { pinTheme, roleOf, runStep, settle, site, type Theme } from '../lib/fixtures'
import { SCREENS } from '../lib/inventory'
import { attachDeep, resolvePath, useDesignIds, viewportOf } from '../lib/designRun'
import { MOCK } from '../lib/env'
import { offPaletteFills } from '../lib/design'

const THEMES: readonly Theme[] = ['dark', 'light']

/** Tailwind blue-500, the old form-theme default and chart hue (E2E F7). */
const TAILWIND_BLUE_500 = 'rgb(59, 130, 246)'
/** The same blue as a colour field writes it. */
const TAILWIND_BLUE_500_HEX = '#3b82f6'
/** Marks the subtree an F7 step judges (set on the forms builder). */
const F7_SCOPE_ATTR = 'data-e2e-f7-scope'
/** The F7 step on a NEW form's theme (the forms builder's Settings tab). */
const FORM_THEME_STEP = 'form-builder-theme'
/** The Settings › Appearance colour fields (feedbackForms.json theme.colours). */
const THEME_COLOUR_FIELDS = ['Primary', 'Background', 'Text'] as const

/**
 * F7: the five screens the off-palette blue was seen on. `open` lands on the
 * screen; a new form's theme is reached by the template picker's Blank form →
 * Use this template → the builder's Settings tab, Appearance (nothing is saved: the
 * unsaved form is dropped with the page).
 */
/** Longer than the app's `.btn` colour transition, so a sampled fill is the resting one. */
const HOVER_TRANSITION_SETTLE_MS = 400

const F7_SCREENS: ReadonlyArray<{ step: string; scope?: string; open: (page: Page) => Promise<void> }> = [
  { step: 'home', open: async (page) => { await openScreen(page, '/') } },
  { step: 'dashboard', open: async (page) => { await openScreen(page, '/dashboard') } },
  { step: 'prioritization', open: async (page) => { await openScreen(page, '/prioritization') } },
  { step: 'feedback-forms', open: async (page) => { await openScreen(page, '/feedback-forms') } },
  {
    step: FORM_THEME_STEP,
    // Only the builder (its header, tabs and the Settings panel), never the forms list's own colours (user data).
    scope: `[${F7_SCOPE_ATTR}]`,
    open: async (page) => {
      await openScreen(page, '/feedback-forms/new')
      await page.getByRole('button', { name: /^Blank form\b/ }).click()
      await page.getByRole('button', { name: 'Use this template', exact: true }).click()
      const tabs = page.getByRole('tablist', { name: 'Form builder sections' })
      await tabs.getByRole('tab', { name: /^Settings\b/ }).click()
      const theme = page.getByRole('region', { name: 'Appearance' })
      await theme.scrollIntoViewIfNeeded()
      // The new form's own defaults: no colour field holds the old blue (the fields' swatches are native, not fills).
      for (const field of THEME_COLOUR_FIELDS) {
        await expect(theme.getByRole('textbox', { name: field }).last(), field).not.toHaveValue(new RegExp(`^${TAILWIND_BLUE_500_HEX}$`, 'i'))
      }
      // The pointer still rests where the tab was: a primary button under it would be sampled
      // mid-way through its hover transition (between --accent and --accent-hover). Park it.
      await page.mouse.move(0, 0)
      await page.waitForTimeout(HOVER_TRANSITION_SETTLE_MS)
      // The builder: the innermost block holding both its name heading and its tabs (builder/FormBuilderPage.tsx).
      const builder = page.locator('main div').filter({ has: tabs }).filter({ has: page.getByRole('heading', { level: 1 }) }).last()
      await builder.evaluate((el, attr) => el.setAttribute(attr, ''), F7_SCOPE_ATTR)
    },
  },
]

async function openScreen(page: Page, target: string): Promise<void> {
  await page.goto(site(target), { waitUntil: 'domcontentloaded' })
  await settle(page, MOCK ? 800 : 1500)
}

test.describe('design screens', () => {
  const ids = useDesignIds()

  for (const screen of SCREENS) {
    for (const theme of THEMES) {
      test(`${screen.step} [${theme}]`, async ({ page }, testInfo) => {
        const role = roleOf(testInfo)
        const viewport = viewportOf(testInfo)
        const target = resolvePath(screen, ids)
        test.skip(target === null, `no ${screen.needs ?? ''} visible to ${role}`)
        test.skip(screen.adminOnly === true && role === 'user', 'admin-only route (redirect is covered by screens.spec.ts)')
        await pinTheme(page, theme)
        // Focus-ring contrast depends on the theme, reachability does not: walk dark everywhere, light once.
        const keyboard = theme === 'dark' || (viewport === 'desktop' && role === 'admin')
        const { record } = await runStep({
          page, role, theme, step: `${viewport}-${screen.step}`,
          action: async (recorder) => {
            await openScreen(page, target ?? '/')
            recorder.note(`landed on ${new URL(page.url()).pathname}${new URL(page.url()).search}`)
            await attachDeep(page, recorder, { keyboard })
          },
        })
        expect(record.extra?.['deep'], `${screen.step}: deep audit recorded`).toBeDefined()
      })
    }

    test(`${screen.step} [zoom 200%]`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(viewportOf(testInfo) !== 'desktop', 'reflow is measured from the desktop window')
      test.skip(screen.adminOnly === true && role === 'user', 'admin-only route')
      const target = resolvePath(screen, ids)
      test.skip(target === null, `no ${screen.needs ?? ''} visible to ${role}`)
      await pinTheme(page, 'dark')
      await page.setViewportSize({ width: 720, height: 450 })
      const { record } = await runStep({
        page, role, theme: 'dark', step: `zoom200-${screen.step}`, audit: false,
        action: async (recorder) => {
          await openScreen(page, target ?? '/')
          await attachDeep(page, recorder, { keyboard: false })
        },
      })
      expect(record.extra?.['deep']).toBeDefined()
    })
  }
})

/**
 * F7 (E2E-COVERAGE-GAPS §3): on the five screens, in both themes, no element the
 * APP colours has a solid background off the Kiro palette, and none is
 * Tailwind's rgb(59, 130, 246). Fills from an inline style — a customer's own
 * form brand colour on a card swatch or in the theme preview — are user data
 * and are only reported (as a `user-colour` annotation), except that the NEW
 * form's default theme must itself be on the palette: in the builder no inline
 * fill may be off it, and its colour fields must not hold the old blue.
 */
test.describe('F7 off-palette swatch', () => {
  for (const screen of F7_SCREENS) {
    for (const theme of THEMES) {
      test(`F7 ${screen.step} [${theme}]`, async ({ page }, testInfo) => {
        await pinTheme(page, theme)
        await screen.open(page)
        const fills = await offPaletteFills(page, screen.scope)
        const appFills = fills.filter((f) => !f.inline)
        const userFills = fills.filter((f) => f.inline)
        if (userFills.length > 0) {
          testInfo.annotations.push({ type: 'user-colour', description: userFills.map((f) => `${f.selector} ${f.color}`).join('; ').slice(0, 900) })
        }
        expect(appFills, `${screen.step}: app backgrounds off the Kiro palette`).toEqual([])
        expect(fills.filter((f) => f.color === TAILWIND_BLUE_500 && (!f.inline || screen.step === FORM_THEME_STEP)),
          `${screen.step}: no ${TAILWIND_BLUE_500}`).toEqual([])
        if (screen.step === FORM_THEME_STEP) {
          expect(userFills, 'the default theme of a NEW form is on the palette').toEqual([])
        }
      })
    }
  }
})
