/**
 * P3 — the main flows in BOTH themes, and the project flow on a phone (390 px).
 *
 * Theme matrix: Home, Dashboard, Projects → a project (Overview / Personas /
 * Documents), Feedback Forms and the assistant (/chat), each with the theme
 * pinned through localStorage `voc-theme` before boot: `<html>` carries that
 * theme (`data-mode`, `data-theme="kiro-<theme>"`), the page renders its heading,
 * no uncaught error, no route error boundary, and no API 5xx (runStep).
 *
 * Mobile project flow (390 × 844, touch): Projects list → "Open Project" → each
 * section tab, in both themes, with no horizontal overflow at any step.
 *
 * Read only. In production the project is an e2e-named PUBLIC project made
 * through the admin API (so both roles see it), ledger-recorded and deleted by
 * cleanup; under E2E_MOCK it is the mock's proj_1.
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { pinTheme, roleOf, runStep, settle, site, type Theme } from '../lib/fixtures'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { overflowsHorizontally, themeAttributes, themeAttributesMatch, widthMetrics } from '../lib/mode'
import { ensureE2eProject } from '../lib/projects'

const THEMES: readonly Theme[] = ['dark', 'light']
const MOCK_PROJECT = { id: 'proj_1', name: 'Q1 Product Improvements' }
const E2E_PROJECT_NAME = `${RUN_PREFIX}flows-matrix`
const PROJECT_TABS = ['Overview', 'Personas', 'Documents'] as const

/** The flow's project: the mock's, or this run's public e2e project (ensureE2eProject reuses the ledger's). */
async function flowProject(): Promise<{ id: string; name: string }> {
  if (MOCK) return MOCK_PROJECT
  return { id: await ensureE2eProject(E2E_PROJECT_NAME, 'public'), name: E2E_PROJECT_NAME }
}

async function expectTheme(page: Page, theme: Theme): Promise<void> {
  await expect.poll(async () => themeAttributesMatch(await themeAttributes(page), theme), { message: `<html> in ${theme}` }).toBe(true)
}

interface Flow {
  step: string
  run: (page: Page) => Promise<void>
}

/** A flow that is just opening one screen. */
const visit = (step: string, pathname: string): Flow => ({
  step, run: async (page) => { await page.goto(site(pathname), { waitUntil: 'domcontentloaded' }) },
})

const FLOWS: readonly Flow[] = [
  visit('home', '/'),
  visit('dashboard', '/dashboard'),
  {
    step: 'project',
    run: async (page) => {
      const project = await flowProject()
      await page.goto(site(`/projects/${encodeURIComponent(project.id)}`), { waitUntil: 'domcontentloaded' })
      for (const tab of PROJECT_TABS) {
        await page.getByRole('tab', { name: tab }).click()
        await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
      }
    },
  },
  visit('feedback-forms', '/feedback-forms'),
  visit('chat', '/chat'),
]

test.describe('main flows × theme', () => {
  for (const flow of FLOWS) {
    for (const theme of THEMES) {
      test(`${flow.step} [${theme}]`, async ({ page }, testInfo) => {
        const role = roleOf(testInfo)
        await pinTheme(page, theme)
        const { record, problems } = await runStep({
          page, role, theme, step: `p3-flow-${flow.step}`, audit: false,
          action: async () => {
            await flow.run(page)
            await settle(page, 600)
            await expectTheme(page, theme)
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
          },
        })
        expect(problems, record.screenshot ?? '').toEqual([])
      })
    }
  }
})

test.describe('project flow on a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  for (const theme of THEMES) {
    test(`projects → project → each section, no horizontal overflow [${theme}]`, async ({ page }, testInfo) => {
      const role = roleOf(testInfo)
      const project = await flowProject()
      await pinTheme(page, theme)
      const overflow: string[] = []
      const measure = async (where: string): Promise<void> => {
        const widths = await widthMetrics(page)
        if (overflowsHorizontally(widths)) overflow.push(`${where}: ${widths.scrollWidth} > ${widths.clientWidth}`)
      }
      const { record, problems } = await runStep({
        page, role, theme, step: 'p3-mobile-project', audit: false,
        action: async (recorder) => {
          await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
          await settle(page, 600)
          await expectTheme(page, theme)
          await measure('projects')
          const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: project.name, exact: true }) })
          await card.getByRole('button', { name: 'Open Project' }).tap()
          await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`))
          for (const tab of PROJECT_TABS) {
            await page.getByRole('tab', { name: tab }).tap()
            await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
            await settle(page, 300)
            await measure(`project ${tab}`)
          }
          recorder.note(`overflow: ${overflow.join('; ') || 'none'}`)
        },
      })
      expect(problems, record.screenshot ?? '').toEqual([])
      expect(overflow, 'no horizontal overflow at 390 px').toEqual([])
    })
  }
})
