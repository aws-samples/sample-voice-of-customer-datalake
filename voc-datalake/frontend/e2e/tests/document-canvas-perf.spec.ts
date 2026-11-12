/**
 * The document canvas on long documents: typing stays responsive and the Markdown written after each pause
 * costs the edited block, not the document. A revise pass stores at most 60,000 characters, but a document can be
 * longer, so this measures a 60,000- and a 200,000-character document in the browser.
 *
 * For each size: a document is created through the API (`POST /projects/{id}/documents`, named
 * `e2e-<run id>-canvas perf …`) and opened; the caret goes to the end of a paragraph in the middle that holds a
 * citation (`[FR:id]`, the text whose escapes the serialiser has to decide on); three bursts of typing follow, each
 * followed by a pause longer than the canvas's 150 ms debounce, so each pause writes the Markdown once. The browser's
 * own Event Timing (each keystroke's input delay + handling + paint) and Long Tasks (any main-thread task over 50 ms:
 * the writes after the pauses) give the numbers, attached to the report and written to `$E2E_OUT/canvas-perf-<size>.json`.
 *
 * The bars (200 ms) leave room for a dev build on a shared machine and still catch the canvas as it was before the
 * large-document work (measured with this spec on the dev mock: the longest task 276 ms at 60,000 characters and
 * 957 ms at 200,000, the slowest keystroke 256 ms; after it, over several runs: 0 ms, 54-65 ms and 56-88 ms).
 *
 * MOCK ONLY (as document-canvas.spec.ts): run from voc-datalake/frontend/e2e with the mock and vite on your own ports:
 *   E2E_MOCK=1 E2E_SITE=http://localhost:5417 E2E_API=http://localhost:3417 E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/document-canvas-perf.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { CANVAS_TEXT, createDocument, openDocument, saveStatus } from '../lib/canvas'
import { apiCall, listOf, stringField } from '../lib/api'
import { MOCK, OUT_DIR, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'

const PROJECT = 'proj_1'
const STAMP = Date.now()
const SIZES = [60_000, 200_000]
const titleOf = (size: number): string => `${RUN_PREFIX}canvas perf ${String(size)} ${String(STAMP)}`

/** One part of the long document: a heading, prose with a citation and marks, a list and a small table. */
function part(n: number): string {
  const id = String(n)
  return [
    `## Theme ${id}`,
    `Reviewers in cohort ${id} raise **refund delays** first and *unclear status* second [FR:fr_${id}], see the [notes](https://example.com/n${id}).`,
    `- ${id} mentions on the app\n- ${id} mentions on the web`,
    `| Signal | Count |\n| --- | --- |\n| Reviews | ${id} |`,
  ].join('\n\n')
}

function longMarkdown(characters: number): string {
  const parts = ['# Research notes']
  for (let n = 1; parts.join('\n\n').length < characters; n += 1) parts.push(part(n))
  return parts.join('\n\n')
}

interface Timings { readonly keystrokes: readonly number[]; readonly longTasks: readonly number[] }

/** Starts the browser's Event Timing and Long Tasks observers; their entries collect on `window.__canvasPerf`. */
async function observe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: { keystrokes: number[]; longTasks: number[] } = { keystrokes: [], longTasks: [] }
    Reflect.set(window, '__canvasPerf', store)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === 'keydown' || entry.name === 'keypress') store.keystrokes.push(entry.duration)
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.longTasks.push(entry.duration)
    }).observe({ type: 'longtask' })
  })
}

async function timings(page: Page): Promise<Timings> {
  const raw: unknown = await page.evaluate(() => Reflect.get(window, '__canvasPerf'))
  const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [])
  return isRecord(raw) ? { keystrokes: numbers(raw['keystrokes']), longTasks: numbers(raw['longTasks']) } : { keystrokes: [], longTasks: [] }
}

const max = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), 0)

test.skip(!MOCK, 'dev mock only, as document-canvas.spec.ts')
// This run's documents only, by title.
test.afterAll(async () => {
  if (!MOCK) return
  const titles = new Set(SIZES.map(titleOf))
  const { body } = await apiCall('admin', 'GET', `/projects/${PROJECT}`)
  const ids = listOf(body, 'documents').filter((d) => titles.has(stringField(d, 'title') ?? '')).map((d) => stringField(d, 'document_id') ?? '')
  for (const id of ids) await apiCall('admin', 'DELETE', `/projects/${PROJECT}/documents/${encodeURIComponent(id)}`)
})

for (const size of SIZES) {
  test(`typing in a ${String(size)}-character document: each keystroke and each pause's write stay short`, async ({ page }) => {
    test.setTimeout(180_000)
    const markdown = longMarkdown(size)
    expect(markdown.length).toBeGreaterThanOrEqual(size)
    const title = titleOf(size)
    await createDocument(PROJECT, { title, content: markdown })
    const canvas = await openDocument(page, PROJECT, title)

    // A paragraph in the middle, with a citation: the caret at its end, as a click there would put it.
    const middle = Math.floor((markdown.match(/^## Theme /gm)?.length ?? 2) / 2)
    const paragraph = canvas.getByText(new RegExp(`^Reviewers in cohort ${String(middle)} raise`))
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.click()
    await page.keyboard.press('End')
    await observe(page)

    for (const burst of [' and more [FR:fr_2]', ' with *stars* and_under', ' then [a link] text']) {
      await page.keyboard.type(burst, { delay: 30 })
      // Longer than the debounce: the Markdown is written once per pause.
      await page.waitForTimeout(600)
    }
    await expect(saveStatus(page)).toHaveText(CANVAS_TEXT.unsaved)
    // `*stars*` is the italic shortcut: the text keeps the word, in italics.
    await expect(paragraph).toContainText('and more [FR:fr_2] with stars and_under then [a link] text')

    const measured = await timings(page)
    const summary = {
      characters: markdown.length,
      keystrokes: measured.keystrokes.length,
      slowestKeystrokeMs: Math.round(max(measured.keystrokes)),
      longTasks: measured.longTasks.map(Math.round),
      longestTaskMs: Math.round(max(measured.longTasks)),
    }
    const report = JSON.stringify(summary, null, 2)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, `canvas-perf-${String(size)}.json`), report)
    await test.info().attach(`canvas-perf-${String(size)}.json`, { body: report, contentType: 'application/json' })
    test.info().annotations.push({ type: 'canvas-perf', description: JSON.stringify(summary) })

    expect(summary.longestTaskMs, `no main-thread task over 200 ms while typing (${JSON.stringify(summary)})`).toBeLessThan(200)
    expect(summary.slowestKeystrokeMs, `no keystroke over 200 ms (${JSON.stringify(summary)})`).toBeLessThan(200)
  })
}
