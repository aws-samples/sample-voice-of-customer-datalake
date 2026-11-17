/**
 * @fileoverview Shared test support for the `src/pages/Scrapers` specs.
 *
 * Deliberately imports NO component from this directory: several specs feed the
 * exports below into `vi.mock` factories, and a module that both feeds those
 * factories and imports a consumer of the mocked module cannot finish evaluating.
 * Specs must import this module BEFORE the component under test.
 */
import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'
// Fixture files compile under the app tsconfig (test files and `src/test/setup.ts`
// are excluded from it), so the jest-dom matcher types must be brought in here for
// the `expect*` helpers below. The runtime registration this also performs is the
// same one `src/test/setup.ts` already did.
import '@testing-library/jest-dom/vitest'
import { screen, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { ADMIN_ONLY } from '@test/adminOnly'
import { DEFAULT_SCRAPER } from './constants'
import type { PluginManifest } from '../../plugins/types'
import type { ScraperConfig } from '../../api/types'

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

/** Fully-typed synthetic-source manifest (issue #146) — satisfies PluginManifestSchema without assertions. */
export const SYNTHETIC_PLUGIN_MANIFEST: PluginManifest = {
  id: 'synthetic_reviews',
  name: 'Synthetic Data Review Generator',
  icon: 'Synthetic',
  description: 'Generate realistic synthetic customer reviews with AI.',
  category: 'synthetic',
  config: [],
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  enabled: true,
}

/** A saved scraper config on top of `DEFAULT_SCRAPER`, with the given overrides. */
export function makeScraper(overrides: Partial<ScraperConfig>): ScraperConfig {
  return {
    ...DEFAULT_SCRAPER,
    id: 's-1',
    name: 'Test scraper',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Module factories for `vi.mock`
// ---------------------------------------------------------------------------

interface ScrapersApiModule {
  scrapersApi: Record<string, unknown>
}

/**
 * Stub the WHOLE real `scrapersApi` surface: a future call from the component hits
 * an assertable `vi.fn()` instead of an opaque "x is not a function", and newly added
 * methods are covered automatically. Each stub resolves to `resolvedValue` when one
 * is given.
 *
 * Usage: `vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal))`.
 */
export async function scrapersApiStubModule(
  importOriginal: () => Promise<ScrapersApiModule>,
  resolvedValue?: unknown,
) {
  const actual = await importOriginal()
  const makeStub = () => (resolvedValue === undefined ? vi.fn() : vi.fn().mockResolvedValue(resolvedValue))
  const stubs = Object.fromEntries(
    Object.keys(actual.scrapersApi).map((name) => [name, makeStub()]),
  )
  return { scrapersApi: stubs }
}


// ---------------------------------------------------------------------------
// Admin-gate assertions
// ---------------------------------------------------------------------------

/**
 * The button carrying *iconClass*, e.g. `lucide-play`. Located by icon rather than
 * by `title`, because `title` is part of what the admin-gate assertions are about:
 * Run and Delete carry the same admin-only value, so selecting on it would find the
 * wrong button and could pass with one of the two gates removed.
 */
export function buttonWithIcon(iconClass: string): HTMLElement {
  const found = screen.getAllByRole('button').find(
    (el) => el.querySelector(`svg.${iconClass}`) !== null
  )
  if (found == null) throw new Error(`no button carrying svg.${iconClass}`)
  return found
}

/**
 * The gated control is off but focusable (`aria-disabled`), is described by the
 * admin-only reason (its tooltip), and clicking it does NOT invoke `callback` — the
 * request not being issued is the observable; an off look is easy to render and
 * easy to bypass.
 */
export async function expectAdminGatedButton(iconClass: string, callback: Mock) {
  const user = userEvent.setup()
  const button = buttonWithIcon(iconClass)
  expect(button).toHaveAttribute('aria-disabled', 'true')
  expect(button).toHaveAccessibleDescription(ADMIN_ONLY)
  await user.click(button)
  expect(callback).not.toHaveBeenCalled()
}

/**
 * Positive control for `expectAdminGatedButton`: the control is enabled, not off, not
 * described by the admin-only reason (and, when `name` is given, named so), and one
 * click invokes `callback` once.
 */
export async function expectEnabledButtonFires(iconClass: string, callback: Mock, name?: string) {
  const user = userEvent.setup()
  const button = buttonWithIcon(iconClass)
  expect(button).toBeEnabled()
  expect(button).not.toHaveAttribute('aria-disabled')
  if (name !== undefined) expect(button).toHaveAccessibleName(name)
  await user.click(button)
  expect(callback).toHaveBeenCalledTimes(1)
}

/**
 * "Run now" asks first (it contacts the site and adds reviews): the click opens the
 * confirmation and nothing runs; "Fetch reviews" in it runs exactly once.
 */
export async function expectRunAsksFirst(callback: Mock) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Run now' }))
  expect(callback).not.toHaveBeenCalled()
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fetch reviews' }))
  expect(callback).toHaveBeenCalledTimes(1)
}

// ---------------------------------------------------------------------------
// Source schedule toggle (PluginConfigModal and Settings/SourceCard specs)
// ---------------------------------------------------------------------------

/**
 * The `enableSource` / `disableSource` API mocks. A spec's `vi.mock('../../api/client')`
 * factory forwards to these, and `vi.clearAllMocks()` in its `beforeEach` resets them.
 */
export const sourceScheduleMocks = {
  enableSource: vi.fn<(source: string) => unknown>(),
  disableSource: vi.fn<(source: string) => unknown>(),
}

/**
 * The schedule toggle is off (`disabled`, or `aria-disabled` where its tooltip says
 * why) and clicking it issues neither request — the request not being sent (no 403
 * provoked) is the observable, not the attribute.
 */
export async function expectScheduleToggleLocked(user: UserEvent) {
  const toggle = screen.getByRole('checkbox')
  expect(toggle.matches(':disabled, [aria-disabled="true"]')).toBe(true)
  await user.click(toggle)
  expect(sourceScheduleMocks.enableSource).not.toHaveBeenCalled()
  expect(sourceScheduleMocks.disableSource).not.toHaveBeenCalled()
}
