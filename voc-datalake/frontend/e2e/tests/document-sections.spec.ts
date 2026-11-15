/**
 * The Documents tab's list in its four sections (docs/prototype-builder.md "Part 4"): Projects › a project ›
 * Documents lists PRD, PR/FAQ, Prototypes and Documents, always in that order, each a disclosure named with its count
 * ("PR/FAQ, 3 documents", `aria-expanded`), every one open on each page view, with its New for an editor.
 *
 * On the mock's proj_1, with reduced motion:
 * 1. At 1440: the four sections in order with the counts of the project read (whose documents each carry `section`),
 *    all open; each section's New; the keyboard folds and unfolds a section (Enter, Space) with its rows gone and
 *    back, and Tab goes from a section's button to its New; the Prototypes New opens the build dialog (Escape closes
 *    it, nothing is built); axe has no serious or critical finding.
 * 2. At 390: the sections become a row of section buttons above the strip, in order with their counts, the first
 *    section with documents open; Enter on Documents puts its rows in the strip and takes the PRD's out; the page
 *    scrolls nothing sideways and the row of buttons fits the window; axe as above.
 *
 * MOCK ONLY (the mock's fixed project; the counts change with every document a deployment's project gains). From
 * voc-datalake/frontend:
 *   PORT=3417 node mock-server.js &   VITE_API_ENDPOINT=http://localhost:3417 npx vite --port 5417 --strictPort &
 *   cd e2e && E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/document-sections.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { expectInsideWindow, expectNoSeriousAxe, expectNoSidewaysScrolling } from '../lib/a11y'
import { apiCall, listOf, stringField } from '../lib/api'
import { documentSectionButtons, documentsPath } from '../lib/canvas'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, SCREENS_DIR } from '../lib/env'
import { roleOf, site } from '../lib/fixtures'

const PROJECT = 'proj_1'
/** The sections in their one order, with their English names (projectDetail.json documents.sections). */
const SECTIONS = [['prd', 'PRD'], ['prfaq', 'PR/FAQ'], ['prototypes', 'Prototypes'], ['documents', 'Documents']] as const
const NEW_LABELS = ['New PRD', 'New PR/FAQ', 'New prototype', 'New Document'] as const
/** A section button's accessible name: "PR/FAQ, 3 documents". */
const SECTION_NAME = /^(PRD|PR\/FAQ|Prototypes|Documents), \d+ documents?$/

const sectionLabel = (name: string, count: number): string => `${name}, ${String(count)} document${count === 1 ? '' : 's'}`

/** The project read's documents per section, in SECTIONS order; every document carries its `section`. */
async function sectionCounts(): Promise<number[]> {
  const { body } = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
  const sections = listOf(body, 'documents').map((document) => stringField(document, 'section') ?? '')
  expect(sections.filter((section) => !SECTIONS.some(([id]) => id === section)), 'every document has a known section').toStrictEqual([])
  return SECTIONS.map(([id]) => sections.filter((section) => section === id).length)
}

async function atWidth(page: Page, width: number): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
}

/** The documents list's section buttons on screen, in order (the wide disclosures, or the narrow row). */
const visibleSectionButtons = (page: Page): Locator => page.getByRole('button', { name: SECTION_NAME })

/** The list a section button controls. */
function controlledList(page: Page, button: Locator): Promise<Locator> {
  return button.getAttribute('aria-controls').then((id) => page.locator(`[id="${id ?? ''}"]`))
}

/** The four section buttons in order, each named as a screen reader hears it ("PR/FAQ, 3 documents") and open or not. */
async function expectSections(buttons: Locator, counts: readonly number[], expanded: (index: number) => string): Promise<void> {
  await expect(buttons).toHaveCount(SECTIONS.length)
  for (const [index, [, name]] of SECTIONS.entries()) {
    await expect(buttons.nth(index)).toHaveAccessibleName(sectionLabel(name, counts[index] ?? 0))
    await expect(buttons.nth(index)).toHaveAttribute('aria-expanded', expanded(index))
  }
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SCREENS_DIR, `document-sections-${name}.png`), fullPage: true })
}

test.describe('documents in sections', () => {
  test.skip(!MOCK, 'dev mock only: the counts are the mock project\'s')
  test.beforeEach(({}, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the mock has one user, an admin')
  })

  test('at 1440: four open sections in order with their counts and New; fold and unfold by keyboard', async ({ page }) => {
    await atWidth(page, 1440)
    const counts = await sectionCounts()
    await page.goto(site(documentsPath(PROJECT)), { waitUntil: 'domcontentloaded' })
    const buttons = visibleSectionButtons(page)
    await expect(buttons).toHaveCount(4, { timeout: 20_000 })
    await expect(documentSectionButtons(page), 'the row of section buttons is the narrow layout\'s').toBeHidden()
    await expectSections(buttons, counts, () => 'true')
    expect(await buttons.evaluateAll((all) => all.map((b) => b.closest('h2') !== null)), 'each in its heading').toStrictEqual([true, true, true, true])
    for (const name of NEW_LABELS) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New prototype', exact: true }), 'proj_1 has a PRD and a PR/FAQ').toBeEnabled()
    await expectNoSeriousAxe(page, '1440 open')
    await expectNoSidewaysScrolling(page, '1440 open')
    await shot(page, '1440')

    // The keyboard: Enter folds PR/FAQ (its rows go), Space opens it again; Tab goes on to its New.
    const faq = buttons.nth(1)
    const faqList = await controlledList(page, faq)
    await expect(faqList.getByRole('button')).toHaveCount(counts[1] ?? 0)
    await faq.focus()
    await page.keyboard.press('Enter')
    await expect(faq).toHaveAttribute('aria-expanded', 'false')
    await expect(faqList).toHaveCount(0)
    await shot(page, '1440-folded')
    await page.keyboard.press('Space')
    await expect(faq).toHaveAttribute('aria-expanded', 'true')
    await expect(faqList.getByRole('button')).toHaveCount(counts[1] ?? 0)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'New PR/FAQ', exact: true })).toBeFocused()

    // Folding is not remembered: the next page view has every section open.
    await faq.click()
    await expect(faq).toHaveAttribute('aria-expanded', 'false')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(visibleSectionButtons(page).nth(1)).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })

    // The Prototypes New is the Overview card's build dialog; Escape closes it and nothing is built.
    await page.getByRole('button', { name: 'New prototype', exact: true }).click()
    const dialog = dialogNamed(page, 'Build Prototype')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('at 390: a row of section buttons above the strip, one section in it, no sideways scroll', async ({ page }) => {
    await atWidth(page, 390)
    const counts = await sectionCounts()
    await page.goto(site(documentsPath(PROJECT)), { waitUntil: 'domcontentloaded' })
    const picker = documentSectionButtons(page)
    await expect(picker).toBeVisible({ timeout: 20_000 })
    const buttons = picker.getByRole('button')
    const first = counts.findIndex((count) => count > 0)
    await expectSections(buttons, counts, (index) => String(index === first))
    await expect(page.getByRole('heading', { level: 2, name: SECTION_NAME }), 'no wide disclosure below 1280').toHaveCount(0)
    await expectInsideWindow(page, picker, '390 section buttons')
    await expectNoSidewaysScrolling(page, '390')
    await expectNoSeriousAxe(page, '390')
    await shot(page, '390')

    // Enter on Documents: its rows are in the strip, the first section's are not.
    const documentsButton = buttons.nth(3)
    const documentsList = await controlledList(page, documentsButton)
    const firstList = await controlledList(page, buttons.nth(first))
    await documentsButton.focus()
    await page.keyboard.press('Enter')
    await expect(documentsButton).toHaveAttribute('aria-expanded', 'true')
    await expect(buttons.nth(first)).toHaveAttribute('aria-expanded', 'false')
    await expect(documentsList.getByRole('button')).toHaveCount(counts[3] ?? 0)
    await expect(firstList).toBeHidden()
    await expect(page.getByRole('button', { name: 'New Document', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New PRD', exact: true })).toBeHidden()
    await expectNoSidewaysScrolling(page, '390 Documents')
    await expectNoSeriousAxe(page, '390 Documents')
    await shot(page, '390-documents')
  })
})
