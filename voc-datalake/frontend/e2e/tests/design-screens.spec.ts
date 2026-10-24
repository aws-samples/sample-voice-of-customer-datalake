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
import { dialogNamed } from '../lib/dialogs'

const THEMES: readonly Theme[] = ['dark', 'light']

/** Tailwind blue-500, the old form-theme default and chart hue (E2E F7). */
const TAILWIND_BLUE_500 = 'rgb(59, 130, 246)'
/** Marks the subtree an F7 step judges (set on the form editor dialog). */
const F7_SCOPE_ATTR = 'data-e2e-f7-scope'

/**
 * F7: the five screens the off-palette blue was seen on. `open` lands on the
 * screen; the form editor's Theme tab is reached by Create Form → a template
 * → Continue → Theme (nothing is saved: the editor is cancelled).
 */
const F7_SCREENS: ReadonlyArray<{ step: string; scope?: string; open: (page: Page) => Promise<void> }> = [
  { step: 'home', open: async (page) => { await openScreen(page, '/') } },
  { step: 'dashboard', open: async (page) => { await openScreen(page, '/dashboard') } },
  { step: 'prioritization', open: async (page) => { await openScreen(page, '/prioritization') } },
  { step: 'feedback-forms', open: async (page) => { await openScreen(page, '/feedback-forms') } },
  {
    step: 'form-editor-theme',
    // Only the editor: the forms list behind it shows existing forms' own colours (user data).
    scope: `[${F7_SCOPE_ATTR}]`,
    open: async (page) => {
      await openScreen(page, '/feedback-forms')
      await page.getByRole('button', { name: 'Create Form' }).first().click()
      const wizard = dialogNamed(page, 'Create New Form')
      await wizard.getByRole('button', { name: /General Feedback/ }).click()
      await wizard.getByRole('button', { name: 'Continue' }).click()
      const editor = dialogNamed(page, 'Create New Feedback Form')
      await editor.getByRole('tab', { name: /^Theme$/ }).click()
      await expect(page.getByText('Primary Color')).toBeVisible()
      await editor.evaluate((el, attr) => el.setAttribute(attr, ''), F7_SCOPE_ATTR)
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
 * form's default theme must itself be on the palette (its swatch is checked).
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
        expect(fills.filter((f) => f.color === TAILWIND_BLUE_500 && (!f.inline || screen.step === 'form-editor-theme')),
          `${screen.step}: no ${TAILWIND_BLUE_500}`).toEqual([])
        if (screen.step === 'form-editor-theme') {
          expect(userFills, 'the default theme of a NEW form is on the palette').toEqual([])
        }
      })
    }
  }
})
