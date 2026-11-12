/**
 * Accessibility and layout checks a spec runs on one state of a page: axe's WCAG 2.2 AA and best-practice rules with
 * no serious or critical finding, nothing sticking out or scrolled sideways (the page, lib/mode.ts's width check, and
 * the app's page scroller), and a box that sits inside the window (a menu a person must be able to read whole).
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'
import { overflowsHorizontally, widthMetrics } from './mode'

/** The tags lib/recorder.ts scans with: WCAG 2.0 to 2.2 AA and best practice. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical'])

/** axe over the page: no serious or critical finding, each named with its first nodes. */
export async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const blocking = result.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => `${violation.id} (${violation.impact ?? ''}): ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`)
  expect(blocking, `${label}: axe serious / critical`).toEqual([])
  expect(result.passes.length, `${label}: axe saw the page`).toBeGreaterThan(0)
}

/**
 * No sideways scroll: the page is no wider than the window, and the app's page scroller (Layout's `page-scroller`) has
 * not been scrolled sideways (a popover past the edge, focused, scrolls its container even when the page itself
 * cannot scroll). Strips meant to scroll sideways (the documents list on a phone, a wide table) are not this one.
 */
export async function expectNoSidewaysScrolling(page: Page, label: string): Promise<void> {
  expect(overflowsHorizontally(await widthMetrics(page)), `${label}: the page is wider than the window`).toBe(false)
  const scrolled = await page.getByTestId('page-scroller').evaluate((scroller) => scroller.scrollLeft)
  expect(scrolled, `${label}: the page scroller scrolled sideways`).toBe(0)
}

/** `target`'s box lies inside the window, left to right (a menu right-aligned to a button on the left can leave it). */
export async function expectInsideWindow(page: Page, target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox()
  const width = page.viewportSize()?.width ?? 0
  const edges = box === null ? null : { left: Math.round(box.x), right: Math.round(box.x + box.width) }
  expect(edges !== null && edges.left >= 0 && edges.right <= width, `${label}: ${JSON.stringify(edges)} inside 0..${width}`).toBe(true)
}
