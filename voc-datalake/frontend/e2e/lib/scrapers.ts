/**
 * The scraper editor flow shared by writes.spec.ts and track s1: fill a
 * "Manual only" custom scraper (Frequency 0, so the scheduled ingestor never
 * picks it up), run Auto-detect, and note POST /scrapers/analyze-url.
 * Callers assert the status they accept and save the scraper themselves.
 */
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { isApi, jsonOf } from './fixtures'
import type { StepRecorder } from './recorder'

const ANALYZE_TIMEOUT_MS = 120_000

export async function analyzeManualScraper(page: Page, editor: Locator, r: StepRecorder, options: { name: string; url: string }): Promise<Response> {
  await expect(editor.getByLabel('Scraper Name')).toBeVisible()
  await editor.getByLabel('Scraper Name').fill(options.name)
  await editor.getByLabel('Frequency').selectOption('0')
  await editor.getByLabel('Website URL').fill(options.url)
  const analyzed = page.waitForResponse((res) => isApi(res, 'POST', /\/scrapers\/analyze-url$/), { timeout: ANALYZE_TIMEOUT_MS })
  const t0 = Date.now()
  await editor.getByRole('button', { name: /Auto-detect/ }).click()
  const res = await analyzed
  const body = await jsonOf(res)
  r.note(`POST /scrapers/analyze-url -> ${res.status()} in ${Date.now() - t0}ms success=${String(body['success'])} message=${String(body['message'] ?? body['error'] ?? '').slice(0, 200)}`)
  return res
}
