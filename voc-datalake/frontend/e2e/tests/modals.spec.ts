/**
 * Opens each modal/dialog that can be opened without touching data, audits it
 * while open (axe + design + screenshot), then closes it with Escape and
 * proves it closed. Nothing is submitted. Modals that need an e2e-owned entity
 * (project personas/sharing/prototype, delete confirms) live in writes.spec.ts.
 *
 * The Add Data Source selector is also checked for WHAT it offers (s1 F1): only
 * plugins the deployment enables, each tile opening its own dialog with no API
 * 4xx. The enabled set is the server's (`GET /sources/status` covers exactly the
 * enabled plugins, #256); on the dev mock it is the manifests the dev build bundles.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, apiUrl } from '../lib/env'
import { roleOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'

interface ModalCase {
  step: string
  path: string
  adminOnly?: boolean
  /** Opens the modal; returns the locator that must be visible while open. */
  open: (page: Page) => Promise<Locator>
  /** How it is meant to close. Default: Escape (the ModalShell contract). */
  close?: (page: Page) => Promise<void>
  /** Why it does not close on Escape, when that is the intended design. */
  closeNote?: string
}

const SESSIONS_TITLE = 'Past conversations'

/**
 * The accessible name of every dialog this spec opens (`dialogNamed`, never by
 * position: the floating assistant panel is a dialog too). From the ModalShell
 * `aria-label` / `aria-labelledby` title of each component, in English.
 */
const DIALOG = {
  createProject: 'Create New Project',
  formTemplates: 'Create New Form',
  addSource: 'Add Data Source',
  // ScraperEditor.tsx: "New Scraper" for a new one, "Edit Scraper" when editing.
  scraperEditor: 'New Scraper',
  manualImport: 'Manual Import',
  jsonUpload: 'JSON Upload',
  // The tile reads "CSV Upload"; the dialog title is "CSV upload".
  csvUpload: 'CSV upload',
  createAgent: 'Create an autonomous agent',
  categoryAccess: 'Category access',
  // TimeRangeSelector.tsx: a non-modal role=dialog popover.
  customRange: 'Custom range',
} as const satisfies Record<string, string>

type DialogName = (typeof DIALOG)[keyof typeof DIALOG]

const pressEscape = async (page: Page): Promise<void> => { await page.keyboard.press('Escape') }
const clickInDialog = (dialogName: DialogName, name: string) => async (page: Page): Promise<void> => {
  await dialogNamed(page, dialogName).getByRole('button', { name, exact: true }).click()
}
const closeAssistant = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Close assistant' }).click()
}

async function clickAndDialog(page: Page, trigger: Locator, name: DialogName): Promise<Locator> {
  await trigger.click()
  const dialog = dialogNamed(page, name)
  await expect(dialog).toBeVisible()
  return dialog
}

/** "New Source" -> a tile of "Add Data Source"; the selector closes and the tile's own dialog opens. */
async function openSourceTile(page: Page, tile: RegExp, name: DialogName): Promise<Locator> {
  const selector = await clickAndDialog(page, page.getByRole('button', { name: 'New Source' }), DIALOG.addSource)
  await selector.getByRole('button', { name: tile }).first().click()
  const dialog = dialogNamed(page, name)
  await expect(dialog).toBeVisible()
  return dialog
}

const CASES: readonly ModalCase[] = [
  { step: 'modal-create-project', path: '/projects', open: (p) => clickAndDialog(p, p.getByRole('button', { name: /^(New Project|Create Project)$/ }).first(), DIALOG.createProject) },
  { step: 'modal-form-template-wizard', path: '/feedback-forms', open: (p) => clickAndDialog(p, p.getByRole('button', { name: /^(Create Form|Create Your First Form)$/ }).first(), DIALOG.formTemplates) },
  { step: 'modal-source-template-selector', path: '/scrapers', open: (p) => clickAndDialog(p, p.getByRole('button', { name: 'New Source' }), DIALOG.addSource) },
  {
    step: 'modal-scraper-editor', path: '/scrapers', open: (p) => openSourceTile(p, /Custom \(CSS Selectors\)/, DIALOG.scraperEditor),
    close: clickInDialog(DIALOG.scraperEditor, 'Cancel'), closeNote: 'dismissable={false} by design (ScraperEditor.tsx:161): Escape must not discard a half-written config',
  },
  { step: 'modal-manual-import', path: '/scrapers', open: (p) => openSourceTile(p, /Manual Import/, DIALOG.manualImport) },
  { step: 'modal-json-upload', path: '/scrapers', open: (p) => openSourceTile(p, /JSON Upload/, DIALOG.jsonUpload) },
  { step: 'modal-csv-upload', path: '/scrapers', open: (p) => openSourceTile(p, /CSV Upload/, DIALOG.csvUpload) },
  { step: 'modal-create-agent', path: '/agents', adminOnly: true, open: (p) => clickAndDialog(p, p.getByRole('button', { name: 'New agent' }).first(), DIALOG.createAgent) },
  { step: 'modal-category-access', path: '/admin?tab=users', adminOnly: true, open: (p) => clickAndDialog(p, p.getByRole('button', { name: /category access/i }).first(), DIALOG.categoryAccess) },
  { step: 'popover-time-range-custom', path: '/dashboard', open: (p) => clickAndDialog(p, p.getByRole('button', { name: /^Custom/ }).first(), DIALOG.customRange) },
  {
    step: 'assistant-panel', path: '/dashboard',
    open: async (p) => {
      await p.getByRole('button', { name: 'Open assistant' }).click()
      const panel = p.getByRole('textbox', { name: 'Message the assistant' })
      await expect(panel).toBeVisible()
      return panel
    },
    close: closeAssistant, closeNote: 'docked panel, not modal: Escape only exits full screen (AssistantPanel.tsx:166)',
  },
  {
    step: 'assistant-sessions-drawer', path: '/dashboard',
    open: async (p) => {
      await p.getByRole('button', { name: 'Open assistant' }).click()
      await p.getByRole('button', { name: 'Past conversations' }).click()
      // SessionsDrawer.tsx:20 is an <aside aria-label={sessions.title}>.
      const drawer = p.getByRole('complementary', { name: SESSIONS_TITLE })
      await expect(drawer).toBeVisible()
      return drawer
    },
    close: async (p) => {
      // The drawer's own Close button (sessions.close), then the panel.
      await p.getByRole('complementary', { name: SESSIONS_TITLE }).getByRole('button', { name: 'Close', exact: true }).click()
      await closeAssistant(p)
    },
    closeNote: 'drawer lives inside the docked assistant panel; dismissed, then the panel closed',
  },
]

test.describe('modals', () => {
  for (const modal of CASES) {
    test(modal.step, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      test.skip(modal.adminOnly === true && role !== 'admin', 'admin-only trigger')
      const opened: Locator[] = []
      const { record, problems } = await runStep({
        page, role, theme: 'dark', step: modal.step,
        action: async (recorder) => {
          await page.goto(site(modal.path), { waitUntil: 'domcontentloaded' })
          await settle(page, 800)
          const target = await modal.open(page)
          opened.push(target)
          await settle(page, 800)
          const title = await target.locator('.dialog-title, h2').first().textContent({ timeout: 2_000 }).catch(() => null)
          recorder.note(`opened; title: ${title?.trim() ?? '(no dialog title)'}`)
        },
      })
      expect(problems, `${modal.step}: ${record.screenshot ?? ''}`).toEqual([])

      // Close the way it is designed to close, and prove it closed.
      if (modal.closeNote !== undefined) testInfo.annotations.push({ type: 'close', description: modal.closeNote })
      await (modal.close ?? pressEscape)(page)
      const target = opened[0]
      if (target !== undefined) await expect(target).toBeHidden({ timeout: 5_000 })
    })
  }
})

// ------------------------------------------------ template selector: enabled plugins only ----

interface Manifest { id: string; name: string; enabled: boolean; category: string; hasIngestor: boolean }

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The plugin manifests in this checkout (generated `src/plugins/manifests.json`), read leniently. */
function manifests(): Manifest[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../src/plugins/manifests.json'), 'utf8'))
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((m) => ({
    id: String(m['id'] ?? ''), name: String(m['name'] ?? ''), enabled: m['enabled'] === true,
    category: String(m['category'] ?? ''), hasIngestor: m['hasIngestor'] === true,
  }))
}

/** Plugin ids the deployment runs: the server's `/sources/status` keys, or the bundled manifests on the mock. */
async function enabledPluginIds(): Promise<Set<string>> {
  if (MOCK) return new Set(manifests().filter((m) => m.enabled).map((m) => m.id))
  const status = await apiCall('admin', 'GET', '/sources/status')
  expect(status.status, 'GET /sources/status').toBe(200)
  const sources = isRecord(status.body) && isRecord(status.body['sources']) ? status.body['sources'] : {}
  return new Set(Object.keys(sources))
}

/** Plugins the selector shows as tiles (TemplateSelector.tsx: app-review sources + synthetic generators). */
const isTilePlugin = (m: Manifest): boolean => m.id !== 'webscraper' && m.hasIngestor

const isClientError = (res: Response): boolean =>
  new URL(res.url()).origin === new URL(apiUrl()).origin && res.status() >= 400 && res.status() < 500

test.describe('modals: Add Data Source offers enabled plugins only', () => {
  test('modal-source-template-plugins', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const enabled = await enabledPluginIds()
    const tilePlugins = manifests().filter(isTilePlugin)
    const offered = tilePlugins.filter((m) => enabled.has(m.id))
    const notOffered = tilePlugins.filter((m) => !enabled.has(m.id))
    const clientErrors: string[] = []
    page.on('response', (res) => { if (isClientError(res)) clientErrors.push(`${res.request().method()} ${new URL(res.url()).pathname} -> ${res.status()}`) })

    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'modal-source-template-plugins', audit: false,
      action: async (r) => {
        await page.goto(site('/scrapers'), { waitUntil: 'domcontentloaded' })
        await settle(page, 800)
        r.note(`enabled: ${[...enabled].join(', ')}; offered: ${offered.map((m) => m.id).join(', ')}; not offered: ${notOffered.map((m) => m.id).join(', ')}`)
        const selector = await clickAndDialog(page, page.getByRole('button', { name: 'New Source' }), DIALOG.addSource)
        for (const m of notOffered) await expect(selector.getByRole('button', { name: new RegExp(`^${escapeRegExp(m.name)}`) }), `${m.id} is not enabled`).toHaveCount(0)
        for (const m of offered) await expect(selector.getByRole('button', { name: new RegExp(`^${escapeRegExp(m.name)}`) }), `${m.id} is enabled`).toBeVisible()
        await pressEscape(page)
        for (const m of offered) {
          const tile = await openSourceTilePlugin(page, m.name)
          r.note(`${m.id}: its dialog opened`)
          await pressEscape(page)
          await expect(tile).toBeHidden()
        }
        await expect(page.getByRole('dialog')).toHaveCount(0)
      },
    })
    expect(problems, `modal-source-template-plugins: ${record.screenshot ?? ''}`).toEqual([])
    expect(clientErrors, 'API 4xx while opening the tiles').toEqual([])
  })
})

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "New Source" -> the plugin's tile -> its own dialog (named after the plugin). */
async function openSourceTilePlugin(page: Page, name: string): Promise<Locator> {
  const selector = await clickAndDialog(page, page.getByRole('button', { name: 'New Source' }), DIALOG.addSource)
  await selector.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}`) }).first().click()
  const dialog = dialogNamed(page, name)
  await expect(dialog).toBeVisible()
  return dialog
}
