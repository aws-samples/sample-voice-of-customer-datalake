/**
 * Browser contexts and pure page checks the P3 specs share. Whether a run drives
 * production or the local dev mock is `MOCK` in lib/env.ts (`E2E_MOCK=1`), and
 * `apiCall` (lib/api.ts) already sends no token to the mock; this module adds no
 * second switch.
 *
 * The page checks several specs make (horizontal overflow, raw i18n keys, the
 * theme attributes) are pure functions, so `unit/helpers.spec.ts` can pin them.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { Role } from './env'
import { isRecord } from './guards'
import { prepareContext } from './test'

/** A storage state with nothing in it: no session, no persisted UI. */
export const EMPTY_STATE = { cookies: [], origins: [] }

/**
 * A browser context with NO session at all (the public `/vote` page, a room's
 * phone). `storageState` is passed explicitly: the project's saved session would
 * otherwise apply to `browser.newContext()` too.
 */
export async function anonymousContext(browser: Browser, options: { width?: number; height?: number } = {}): Promise<BrowserContext> {
  return browser.newContext({ storageState: EMPTY_STATE, viewport: { width: options.width ?? 390, height: options.height ?? 844 } })
}

/** A second signed-in context for `role` (two tabs of one user), set up like the fixture contexts. */
export async function roleContext(browser: Browser, role: Role, storageState: string | typeof EMPTY_STATE): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } })
  return prepareContext(context, role)
}

// ── pure page checks (unit-tested) ────────────────────────────────────────────

/** A page overflows horizontally when its scroll width passes the viewport by more than a pixel. */
export function overflowsHorizontally(metrics: { scrollWidth: number; clientWidth: number }): boolean {
  return metrics.scrollWidth > metrics.clientWidth + 1
}

/** The document's scroll and client width (what `overflowsHorizontally` judges). */
export async function widthMetrics(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    clientWidth: document.documentElement.clientWidth,
  }))
}

/** Every dotted key path of a locale namespace object (`{a: {b: 'x'}}` → `['a.b']`). */
export function keyPaths(node: unknown, prefix = ''): string[] {
  if (!isRecord(node)) return []
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return typeof value === 'string' ? [path] : keyPaths(value, path)
  })
}

/**
 * The raw i18n keys visible in `text`. A missing key renders as its key path
 * without the namespace (`panel.stillGenerating`), so the check is exact: a token
 * of the text that equals a known key path of two or more segments, or a
 * `namespace:key` reference. Hostnames, versions and file names never match
 * because they are not key paths.
 */
export function rawKeysIn(text: string, knownKeys: ReadonlySet<string>, namespaces: readonly string[]): string[] {
  const found = new Set<string>()
  for (const token of text.split(/[\s"'“”‘’()[\]{}<>,;!?…]+/)) {
    const bare = token.replace(/[.:]+$/, '')
    if (bare.includes('.') && knownKeys.has(bare)) found.add(bare)
    const ns = bare.match(/^([a-zA-Z]+):([a-zA-Z0-9_.]+)$/)
    if (ns !== null && namespaces.includes(ns[1] ?? '')) found.add(bare)
  }
  return [...found]
}

/** What `pinTheme` asked for, as the SPA reflects it on `<html>` (themeStore.applyTheme). */
export function themeAttributesMatch(attrs: { dataMode: string | null; dataTheme: string | null }, theme: 'dark' | 'light'): boolean {
  return attrs.dataMode === theme && attrs.dataTheme === `kiro-${theme}`
}

/** The `<html>` theme attributes. */
export async function themeAttributes(page: Page): Promise<{ dataMode: string | null; dataTheme: string | null }> {
  return page.evaluate(() => ({
    dataMode: document.documentElement.getAttribute('data-mode'),
    dataTheme: document.documentElement.getAttribute('data-theme'),
  }))
}
