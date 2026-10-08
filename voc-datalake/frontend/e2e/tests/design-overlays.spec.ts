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
const openAssistant = async (p: Page): Promise<void> => {
  await p.getByRole('button', { name: 'Open assistant' }).click()
  await expect(p.getByRole('textbox', { name: 'Message the assistant' })).toBeVisible()
}

const CASES: readonly OverlayCase[] = [
  { step: 'create-project', path: '/projects', trigger: byName(/^(New Project|Create Project)$/) },
  { step: 'form-template-wizard', path: '/feedback-forms', trigger: byName(/^(Create Form|Create Your First Form)$/) },
  { step: 'form-submissions', path: '/feedback-forms', trigger: byName(/^(View )?Submissions$/) },
  { step: 'source-template-selector', path: '/scrapers', trigger: byName('New Source') },
  { step: 'create-agent', path: '/agents', adminOnly: true, trigger: byName('New agent') },
  { step: 'category-access', path: '/admin?tab=users', adminOnly: true, trigger: byName(/category access/i) },
  { step: 'data-source-wizard', path: '/admin?tab=plugins', adminOnly: true, trigger: byName(/^(Add (data )?source|New Source|Add Data Source)$/i) },
  { step: 'time-range-listbox', path: '/dashboard', trigger: (p) => p.locator('button[aria-haspopup="listbox"]').first() },
  { step: 'time-range-custom', path: '/dashboard', trigger: byName(/^Custom/) },
  { step: 'project-share', path: '/projects/{project}', trigger: byName(/^Share/) },
  { step: 'persona-import', path: '/projects/{project}?tab=personas', trigger: byName('Import Persona') },
  { step: 'persona-new', path: '/projects/{project}?tab=personas', trigger: byName(/^(New|Add|Create) Persona$/i) },
  { step: 'document-new', path: '/projects/{project}?tab=documents', trigger: byName(/^(New Document|Create Document)$/) },
  { step: 'prototype-build-wizard', path: '/projects/{project}?tab=documents', trigger: byName('Build Prototype') },
  { step: 'workflow-editor', path: '/agents/{agent}?tab=workflow', adminOnly: true, trigger: byName(/^(Edit workflow|Open editor|Edit)$/i) },
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
  { step: 'project-personas', path: '/projects/{project}?tab=personas' },
  { step: 'project-documents', path: '/projects/{project}?tab=documents' },
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
