/**
 * The suite's `test`: Playwright's, plus the per-context setup of `lib/context.ts`
 * for the built-in `context` / `page` fixtures. Every spec imports `test` from
 * here (types and `expect` still come from `@playwright/test`); a spec that opens
 * its own `browser.newContext` calls `prepareContext` on it.
 *
 * The UI reset runs before the context is created: `storageState` (the saved
 * session the context starts from) depends on it.
 */
import { test as base, type BrowserContext } from '@playwright/test'
import { resetPersistedUiOnce, trackBrowserCreates, trackStreamConversations } from './context'
import { roleOf } from './fixtures'
import type { Role } from './env'

/**
 * Set up a context a spec created itself (the fixture contexts get this automatically):
 * every conversation it starts and every entity a browser POST creates go in the ledger.
 */
export function prepareContext(context: BrowserContext, role: Role): BrowserContext {
  trackStreamConversations(context, role)
  trackBrowserCreates(context, role)
  return context
}

export const test = base.extend<{ persistedUiReset: undefined }>({
  persistedUiReset: [async ({}, use, testInfo) => {
    resetPersistedUiOnce(testInfo.file)
    await use(undefined)
  }, { auto: true }],
  storageState: async ({ storageState, persistedUiReset }, use) => {
    void persistedUiReset
    await use(storageState)
  },
  context: async ({ context }, use, testInfo) => {
    await use(prepareContext(context, roleOf(testInfo)))
  },
})
