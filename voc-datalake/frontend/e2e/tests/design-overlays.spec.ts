/**
 * Design track: every modal / drawer / menu / popover reachable without
 * writing data, in both themes at the project's viewport. Each overlay is
 * opened FROM THE KEYBOARD (trigger focused, Enter), audited while open (axe +
 * deep audit + reduced-motion durations), its focus trap walked, then closed
 * with Escape; the step records whether it closed and whether focus went back
 * to the trigger. Nothing is ever submitted: only Enter on a trigger, Tab and
 * Escape are pressed.
 *
 * Besides the curated cases, each page in POPUP_PAGES is scanned for buttons
 * that declare `aria-haspopup` (dialog/menu/listbox), which by contract only
 * open an overlay, and each is exercised the same way.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { pinTheme, roleOf, runStep, settle, site, type Theme } from '../lib/fixtures'
import { attachDeep, useDesignIds, viewportOf, type Ids, type Viewport } from '../lib/designRun'
import { MOCK } from '../lib/env'
import { motionAudit } from '../lib/deepAudit'
import { documentSectionButtons } from '../lib/canvas'
import type { StepRecorder } from '../lib/recorder'

interface OverlayCase {
  step: string
  /** Path; `{project}`, `{feedback}`, `{agent}` are resolved at run time. */
  path: string
  adminOnly?: boolean
  only?: Viewport
  /** Runs first (e.g. opening the assistant before the drawer trigger exists). */
  prepare?: (page: Page) => Promise<void>
  trigger: (page: Page) => Locator
  /** Escape is not the designed dismissal (documented reason). */
  noEscape?: string
}

const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"], aside[aria-label]'
const DESTRUCTIVE = /delete|remove|revoke|archive|disable|reset|forget|run now|send|save|submit|publish|generate|confirm|close session/i

const byName = (name: RegExp | string) => (p: Page): Locator => p.getByRole('button', { name, exact: typeof name === 'string' }).first()
/** Opens one section of the Documents tab when the list shows one at a time (below 1280 px); a no-op from 1280 px. */
const openDocumentSection = (name: RegExp) => async (p: Page): Promise<void> => {
  const button = documentSectionButtons(p).getByRole('button', { name })
  if (await button.isVisible()) await button.click()
}
/** People → the first person's editor sheet (its row's Edit; only the visible layout's button is in the tree). */
const openPersonEditor = async (p: Page): Promise<void> => {
  await p.getByRole('button', { name: /^Edit / }).first().click()
  await expect(p.getByRole('dialog', { name: /^Edit / })).toBeVisible()
}
const openAssistant = async (p: Page): Promise<void> => {
  await p.getByRole('button', { name: 'Open assistant' }).click()
  await expect(p.getByRole('textbox', { name: 'Message the assistant' })).toBeVisible()
}
/** The template picker's Blank form, unsaved in the forms builder (nothing is saved). */
const openBlankForm = async (p: Page): Promise<void> => {
  await p.getByRole('button', { name: /^Blank form\b/ }).click()
  await p.getByRole('button', { name: 'Use this template', exact: true }).click()
  await expect(p.getByRole('tablist', { name: 'Form builder sections' })).toBeVisible()
}
/** A row's opener in the builder's Results › Responses (results/ResponsesTable.tsx). */
const responseOpener = (p: Page): Locator => p.getByRole('button', { name: /^Open the response from / }).first()
/** How many listed forms are tried for one with a response (the mock's first v2 form with responses is the 6th). */
const FORMS_TRIED_FOR_A_RESPONSE = 8
/**
 * Results › Responses of the first listed form that has a response, from the list's Results links. Read only: the
 * builder's Results tab GETs the form, its results and its responses (the test token, a POST, is read only by the
 * Test, Share and Hidden fields tabs).
 */
const openFirstResponses = async (p: Page): Promise<void> => {
  const links = await p.locator('main').getByRole('link', { name: 'Results', exact: true })
    .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? '').filter((href) => href !== ''))
  for (const href of links.slice(0, FORMS_TRIED_FOR_A_RESPONSE)) {
    await gotoAndSettle(p, `${href}/responses`)
    if (await responseOpener(p).isVisible()) return
  }
}

const CASES: readonly OverlayCase[] = [
  { step: 'create-project', path: '/projects', trigger: byName(/^(New Project|Create Project)$/) },
  // The forms builder (7.55.00): "Improve with AI" over an unsaved Blank form, and a response's side sheet in Results.
  { step: 'form-improve-sheet', path: '/feedback-forms/new', prepare: openBlankForm, trigger: byName('Improve with AI') },
  { step: 'form-response-sheet', path: '/feedback-forms', prepare: openFirstResponses, trigger: responseOpener },
  { step: 'source-template-selector', path: '/scrapers', trigger: byName('New source') },
  { step: 'create-agent', path: '/agents', adminOnly: true, trigger: byName('New agent') },
  // People: the first person's editor sheet, then its "Change access…" (the Category access dialog over the sheet).
  { step: 'category-access', path: '/admin/access/users', adminOnly: true, prepare: openPersonEditor, trigger: byName('Change access…') },
  { step: 'data-source-wizard', path: '/admin/sources/plugins', adminOnly: true, trigger: byName(/^(Add (data )?source|New Source|Add Data Source)$/i) },
  { step: 'time-range-listbox', path: '/dashboard', trigger: (p) => p.locator('button[aria-haspopup="listbox"]').first() },
  { step: 'time-range-custom', path: '/dashboard', trigger: byName(/^Custom/) },
  { step: 'project-share', path: '/projects/{project}', trigger: byName(/^Share/) },
  { step: 'persona-import', path: '/projects/{project}/personas', trigger: byName('Import Persona') },
  { step: 'persona-new', path: '/projects/{project}/personas', trigger: byName(/^(New|Add|Create) Persona$/i) },
  // Below 1280 px the Documents tab shows one section at a time (6.16.00): its New is reached through the section
  // buttons first; from 1280 px every section is open and the row is hidden.
  { step: 'document-new', path: '/projects/{project}/documents', prepare: openDocumentSection(/^Documents\b/), trigger: byName(/^(New Document|Create Document)$/) },
  { step: 'prototype-build-wizard', path: '/projects/{project}/documents', prepare: openDocumentSection(/^Prototypes\b/), trigger: byName('New prototype') },
  { step: 'workflow-editor', path: '/agents/{agent}/workflow', adminOnly: true, trigger: byName(/^(Edit workflow|Open editor|Edit)$/i) },
  { step: 'mobile-menu', path: '/dashboard', only: 'mobile', trigger: byName('Open menu') },
  {
    step: 'assistant-panel', path: '/dashboard', trigger: byName('Open assistant'),
    noEscape: 'docked panel, not modal: Escape only exits full screen (AssistantPanel.tsx)',
  },
  { step: 'assistant-sessions-drawer', path: '/dashboard', prepare: openAssistant, trigger: byName('Past conversations') },
  { step: 'assistant-fullscreen', path: '/dashboard', only: 'desktop', prepare: openAssistant, trigger: byName(/full ?screen|expand/i) },
]

/** Pages scanned for `aria-haspopup` triggers. */
const POPUP_PAGES: ReadonlyArray<{ step: string; path: string; adminOnly?: boolean }> = [
  { step: 'dashboard', path: '/dashboard' },
  { step: 'categories', path: '/categories' },
  { step: 'feedback-detail', path: '/feedback/{feedback}' },
  { step: 'project-overview', path: '/projects/{project}' },
  { step: 'project-personas', path: '/projects/{project}/personas' },
  { step: 'project-documents', path: '/projects/{project}/documents' },
  { step: 'feedback-forms', path: '/feedback-forms' },
  { step: 'prioritization', path: '/prioritization' },
  { step: 'agents', path: '/agents' },
]

const THEMES: readonly Theme[] = ['dark', 'light']

async function gotoAndSettle(page: Page, target: string): Promise<void> {
  await page.goto(site(target), { waitUntil: 'domcontentloaded' })
  await settle(page, MOCK ? 600 : 1200)
}

function resolve(path: string, ids: Ids): string | null {
  let out = path
  for (const key of ['project', 'feedback', 'agent'] as const) {
    if (!out.includes(`{${key}}`)) continue
    const id = ids[key]
    if (id === undefined) return null
    out = out.replace(`{${key}}`, encodeURIComponent(id))
  }
  return out
}

const visibleOverlays = (page: Page): Promise<number> =>
  page.locator(OVERLAY).evaluateAll((els) => els.filter((e) => {
    // On screen, not merely rendered: the mobile sidebar is always in the DOM, translated off-canvas.
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.right > 1 && r.left < innerWidth - 1 && getComputedStyle(e).visibility !== 'hidden'
  }).length)

/** Tabs `presses` times inside the open overlay; counts focus landing outside it. */
async function trapWalk(page: Page, presses: number): Promise<{ escapes: number; stops: number; samples: string[] }> {
  let escapes = 0
  const samples: string[] = []
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('Tab')
    const where = await page.evaluate((sel) => {
      const overlays = Array.from(document.querySelectorAll(sel))
      const top = overlays[overlays.length - 1]
      const el = document.activeElement
      if (!el || el === document.body) return { inside: false, label: 'body' }
      return { inside: top?.contains(el) ?? false, label: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"` }
    }, OVERLAY)
    if (!where.inside) {
      escapes += 1
      if (samples.length < 5) samples.push(where.label)
    }
  }
  return { escapes, stops: presses, samples }
}

/** Opens via keyboard, audits, walks the trap, Escapes, checks close + focus return. */
async function exercise(page: Page, recorder: StepRecorder, trigger: Locator, options: { noEscape?: string; theme: Theme }): Promise<void> {
  const before = await visibleOverlays(page)
  await trigger.scrollIntoViewIfNeeded()
  await trigger.evaluate((el) => el.setAttribute('data-qa-trigger', '1'))
  await trigger.focus()
  if (options.theme === 'dark') await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(60)
  const motion = options.theme === 'dark' ? await motionAudit(page) : null
  await settle(page, MOCK ? 500 : 900)
  const opened = (await visibleOverlays(page)) > before
  const name = await page.locator(OVERLAY).last().evaluate((el) =>
    el.getAttribute('aria-label') ?? document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? el.querySelector('h2,h3')?.textContent ?? '').catch(() => '')
  const focusMovedIn = await page.evaluate((sel) => {
    const overlays = Array.from(document.querySelectorAll(sel))
    return overlays[overlays.length - 1]?.contains(document.activeElement) ?? false
  }, OVERLAY)
  recorder.note(`opened=${opened} name="${(name ?? '').trim().slice(0, 60)}" focusMovedIn=${focusMovedIn}`)
  await attachDeep(page, recorder, { keyboard: false })
  const trap = opened ? await trapWalk(page, 25) : null
  // Non-modal overlays (menus, listboxes, popovers) may let Tab out, but should close when it does.
  const modal = await page.locator('[aria-modal="true"]').count() > 0
  const openAfterTab = opened ? (await visibleOverlays(page)) > before : null
  if (options.noEscape === undefined) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const after = await visibleOverlays(page)
  const focusReturned = await page.evaluate(() => document.activeElement?.getAttribute('data-qa-trigger') === '1')
  recorder.attach('overlay', {
    opened, name: (name ?? '').trim(), focusMovedIn, trap, motion, modal, openAfterTab,
    escape: options.noEscape ?? (after <= before ? 'closed' : 'STILL OPEN'),
    focusReturned: options.noEscape === undefined ? focusReturned : null,
  })
  await page.emulateMedia({ reducedMotion: null })
}

test.describe('design overlays', () => {
  const ids = useDesignIds()

  for (const overlay of CASES) {
    for (const theme of THEMES) {
      test(`${overlay.step} [${theme}]`, async ({ page }, testInfo) => {
        const role = roleOf(testInfo)
        const viewport = viewportOf(testInfo)
        test.skip(overlay.adminOnly === true && role !== 'admin', 'admin-only trigger')
        test.skip(overlay.only !== undefined && overlay.only !== viewport, `${overlay.only} only`)
        const target = resolve(overlay.path, ids)
        test.skip(target === null, 'needs an entity this role cannot see')
        await pinTheme(page, theme)
        const { record } = await runStep({
          page, role, theme, step: `${viewport}-overlay-${overlay.step}`,
          action: async (recorder) => {
            await gotoAndSettle(page, target ?? '/')
            if (overlay.prepare) await overlay.prepare(page)
            const trigger = overlay.trigger(page)
            if (!(await trigger.isVisible().catch(() => false))) {
              recorder.note('trigger not present for this role/data')
              recorder.attach('overlay', { opened: false, reason: 'trigger not present' })
              return
            }
            await exercise(page, recorder, trigger, { noEscape: overlay.noEscape, theme })
          },
        })
        expect(record.extra?.['overlay']).toBeDefined()
      })
    }
  }

  for (const popupPage of POPUP_PAGES) {
    test(`haspopup on ${popupPage.step} [dark+light]`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      const viewport = viewportOf(testInfo)
      const target = resolve(popupPage.path, ids)
      test.skip(target === null, 'needs an entity this role cannot see')
      for (const theme of THEMES) {
        await pinTheme(page, theme)
        await gotoAndSettle(page, target ?? '/')
        const labels = await page.locator('button[aria-haspopup]:visible').evaluateAll((els) =>
          els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()).filter((l) => l !== ''))
        const unique = Array.from(new Set(labels)).filter((l) => !DESTRUCTIVE.test(l)).slice(0, 6)
        for (const [index, label] of unique.entries()) {
          await runStep({
            page, role, theme, step: `${viewport}-popup-${popupPage.step}-${index}`,
            action: async (recorder) => {
              recorder.note(`trigger "${label}"`)
              await gotoAndSettle(page, target ?? '/')
              const trigger = page.getByRole('button', { name: label, exact: true })
                .or(page.locator('button[aria-haspopup]:visible').filter({ hasText: label })).first()
              await exercise(page, recorder, trigger, { theme })
            },
          })
        }
      }
    })
  }
})
