/**
 * Records what the dashboard data endpoints answer per time window, so an
 * empty dashboard can be told apart from "no data in this window" and from an
 * aggregate gap (feedback present, METRIC# rows missing). READ only; writes
 * counts (never bodies) to OUT_DIR/dashboard-data-<role>.json.
 *
 * The dashboard UI is then held to that data (E2E F4): on a 30-day window, a
 * workspace with feedback never shows the "workspace is empty" welcome — it shows
 * counts, or "Show all time" when the window is empty — and an empty workspace (an
 * injected all-zero summary, so nothing reaches the deployment) shows the welcome.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf } from '../lib/api'
import { OUT_DIR } from '../lib/env'
import { ERROR_BOUNDARY_TEXT, pinTimeRange, roleOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { injectFailure, type InjectionSpec } from '../lib/inject'

const WINDOWS = [1, 7, 30, 90, 0] as const

function totalOf(body: unknown): unknown {
  if (!isRecord(body)) return null
  return body['total_feedback'] ?? body['total'] ?? body['count'] ?? null
}

test('dashboard data per window', async ({}, testInfo) => {
  const role = roleOf(testInfo)
  const rows = []
  for (const days of WINDOWS) {
    const [summary, feedback] = await Promise.all([
      apiCall(role, 'GET', `/metrics/summary?days=${days}`),
      apiCall(role, 'GET', `/feedback?days=${days}&limit=50`),
    ])
    rows.push({
      days,
      summaryStatus: summary.status, summaryMs: summary.ms, summaryTotal: totalOf(summary.body),
      summaryKeys: isRecord(summary.body) ? Object.keys(summary.body).slice(0, 12) : [],
      feedbackStatus: feedback.status, feedbackMs: feedback.ms, feedbackItems: listOf(feedback.body, 'items').length,
    })
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `dashboard-data-${role}.json`), JSON.stringify({ role, at: new Date().toISOString(), rows }, null, 2))
  for (const row of rows) {
    expect(row.summaryStatus).toBe(200)
    expect(row.feedbackStatus).toBe(200)
  }
})

/** dashboard.json emptyState.subheading (the welcome of a workspace with no feedback). */
const WORKSPACE_EMPTY = 'Your workspace is empty'

/** The Total Feedback card's figure (MetricCard: title `<p>`, then the `font-mono` value), as a number. */
async function totalFeedbackShown(page: Page): Promise<number | null> {
  const value = page.locator('.card', { hasText: 'Total Feedback' }).locator('p.font-mono').first()
  if (await value.count() === 0) return null
  const digits = (await value.innerText()).replace(/[^0-9]/g, '')
  return digits === '' ? null : Number(digits)
}

async function openDashboard(page: Page): Promise<void> {
  await page.goto(site('/dashboard'), { waitUntil: 'domcontentloaded' })
  await settle(page, 1_500)
}

test('dashboard UI agrees with the data on a 30-day window', async ({ page }, testInfo) => {
  const role = roleOf(testInfo)
  const allTime = await apiCall(role, 'GET', '/metrics/summary?days=0')
  const total = totalOf(allTime.body)
  expect(allTime.status).toBe(200)
  await pinTimeRange(page, '30d')
  const { record, problems } = await runStep({
    page, role, theme: 'dark', step: 'dashboard-empty-state-logic', audit: false,
    action: async (r) => {
      await openDashboard(page)
      const shown = await totalFeedbackShown(page)
      const showAllTime = await page.getByRole('button', { name: 'Show all time' }).isVisible()
      r.note(`all-time total ${String(total)}; Total Feedback card ${String(shown)}; Show all time ${String(showAllTime)}`)
      if (typeof total === 'number' && total > 0) {
        await expect(page.getByText(WORKSPACE_EMPTY)).toHaveCount(0)
        expect((shown ?? 0) > 0 || showAllTime, 'counts, or the Show all time notice').toBe(true)
      } else {
        await expect(page.getByText(WORKSPACE_EMPTY)).toBeVisible()
      }
    },
  })
  expect(problems, `dashboard-empty-state-logic: ${record.screenshot ?? ''}`).toEqual([])
})

test('an empty workspace shows the welcome, not the window notice', async ({ page }, testInfo) => {
  const role = roleOf(testInfo)
  const empty: InjectionSpec = { method: 'GET', path: /\/metrics\/summary$/, failure: { status: 200, body: { total_feedback: 0, avg_sentiment: 0, urgent_count: 0 } } }
  const injected = await injectFailure(page, empty)
  const { record, problems } = await runStep({
    page, role, theme: 'dark', step: 'dashboard-empty-workspace', audit: false,
    action: async () => {
      await openDashboard(page)
      await expect(page.getByRole('heading', { name: /^Welcome — let.s get your feedback flowing$/ })).toBeVisible()
      await expect(page.getByText(WORKSPACE_EMPTY)).toBeVisible()
      await expect(page.getByRole('link', { name: 'Start here' })).toHaveAttribute('href', '/')
      await expect(page.getByRole('button', { name: 'Show all time' })).toHaveCount(0)
      await expect(page.getByText(ERROR_BOUNDARY_TEXT, { exact: true })).toHaveCount(0)
    },
  })
  expect(injected.hits()).toBeGreaterThan(0)
  expect(problems, `dashboard-empty-workspace: ${record.screenshot ?? ''}`).toEqual([])
})
