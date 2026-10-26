/**
 * P3 — assistant desktop notifications (2.11; E2E-COVERAGE-GAPS "NO-E2E").
 *
 * The browser's `Notification` is replaced (before the SPA boots) by a recorder
 * whose permission is granted, and in production the context is granted the
 * real `notifications` permission too. Then, on /chat:
 * - the bell ("Notify me when a conversation needs me") turns notifications on;
 * - a reply that ends while the conversation is ON SCREEN (tab visible and
 *   focused) notifies nobody;
 * - a reply that ends while the tab is HIDDEN raises exactly one notification,
 *   with the generic words ("The assistant replied" / "A conversation has a new
 *   reply." — never the answer itself), tagged per conversation.
 * Admin only; two assistant messages (ledger-recorded by lib/test.ts).
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { MOCK } from '../lib/env'
import { composer } from '../lib/assistant'
import { isRecord } from '../lib/guards'
import { roleOf, settle, site } from '../lib/fixtures'

interface Shown { title: string; body: string; tag: string }

/** Records every `new Notification(...)`; `window.__e2eHidden = true` makes the tab look hidden and unfocused. */
async function installNotificationRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shown: Array<{ title: string; body: string; tag: string }> = []
    Object.defineProperty(window, '__e2eNotifications', { value: shown })
    Object.defineProperty(window, '__e2eHidden', { value: false, writable: true })
    class RecordingNotification {
      static permission = 'granted'
      static requestPermission(): Promise<string> { return Promise.resolve('granted') }
      onclick: unknown = null
      constructor(title: string, options?: { body?: string; tag?: string }) {
        shown.push({ title, body: options?.body ?? '', tag: options?.tag ?? '' })
      }
      close(): void { /* nothing to close */ }
      addEventListener(): void { /* not needed */ }
    }
    Object.defineProperty(window, 'Notification', { value: RecordingNotification, configurable: true, writable: true })
    const hidden = (): boolean => Reflect.get(window, '__e2eHidden') === true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden() ? 'hidden' : 'visible') })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden() })
    const realHasFocus = document.hasFocus.bind(document)
    document.hasFocus = () => !hidden() && realHasFocus()
  })
}

async function shownNotifications(page: Page): Promise<Shown[]> {
  const raw: unknown = await page.evaluate(() => Reflect.get(window, '__e2eNotifications'))
  return Array.isArray(raw) ? raw.filter(isShown) : []
}

function isShown(value: unknown): value is Shown {
  return isRecord(value) && typeof value['title'] === 'string' && typeof value['body'] === 'string' && typeof value['tag'] === 'string'
}

/** After a run the user watched: long enough for a (wrong) notification to have been raised. */
const NO_NOTIFICATION_SETTLE_MS = 1_000

/** Sends `text` and waits until that run's stream has finished (Send is back, Stop gone). */
async function askAndWait(page: Page, text: string): Promise<void> {
  const finished = page.waitForEvent('requestfinished', { predicate: (r) => /\/chat\/stream$/.test(new URL(r.url()).pathname), timeout: 180_000 })
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first().click()
  await finished
  await expect(page.getByRole('button', { name: 'Stop', exact: true }).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 })
}

test('assistant: a reply notifies only when the tab is hidden, with generic words', async ({ page, context }, testInfo) => {
  test.skip(roleOf(testInfo) !== 'admin', 'one role is enough (two Bedrock calls)')
  test.setTimeout(420_000)
  if (!MOCK) await context.grantPermissions(['notifications'], { origin: new URL(site('/')).origin })
  await installNotificationRecorder(page)
  await page.goto(site('/chat'), { waitUntil: 'domcontentloaded' })
  await settle(page, 600)

  const bell = page.getByRole('button', { name: 'Notify me when a conversation needs me' }).filter({ visible: true }).first()
  await bell.click()
  await expect(page.getByRole('button', { name: 'Turn off notifications' }).filter({ visible: true }).first()).toHaveAttribute('aria-pressed', 'true')

  // On screen, visible and focused: nobody needs telling.
  await askAndWait(page, 'e2e notifications one: reply with the single word "ok".')
  await page.waitForTimeout(NO_NOTIFICATION_SETTLE_MS)
  expect(await shownNotifications(page), 'no notification for a reply the user is looking at').toEqual([])

  // Hidden tab: one notification, generic text, per-conversation tag.
  await page.evaluate(() => Reflect.set(window, '__e2eHidden', true))
  await askAndWait(page, 'e2e notifications two: reply with the single word "done".')
  await expect.poll(() => shownNotifications(page), { timeout: 15_000 }).toHaveLength(1)
  const [notification] = await shownNotifications(page)
  expect(notification?.title).toBe('The assistant replied')
  expect(notification?.body).toBe('A conversation has a new reply.')
  expect(notification?.tag ?? '').toMatch(/^voc-assistant:.+:reply$/)
})
