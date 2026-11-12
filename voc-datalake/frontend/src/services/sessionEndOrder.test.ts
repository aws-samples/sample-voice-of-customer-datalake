/**
 * A tab that ends its session writes the session's record (`voc-auth`) signed out before it announces the end: the
 * other tabs act on the signal only while the stored session says signed out (services/crossTabSignOut.ts), so an
 * announcement first would leave every one of them holding the last person's records.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubLocationAssign } from '../test/location'
import { withMemoryLocalStorage } from '../test/memoryLocalStorage'

/** The browser's localStorage, kept in a map for this file. */
const saved = withMemoryLocalStorage()

/** The stored session's record each time a session end was announced. */
const recordsAtSignal = vi.hoisted((): (string | undefined)[] => [])

vi.mock('./crossTabSignOut', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crossTabSignOut')>()
  return {
    ...actual,
    announceSessionEnded: () => {
      recordsAtSignal.push(saved.get(AUTH_KEY))
      actual.announceSessionEnded()
    },
  }
})

/** The sign-out's first step as in auth.ts: the store's logout(), which persists the record signed out. */
vi.mock('./auth', async () => {
  const { useAuthStore: store } = await import('../store/authStore')
  return { authService: { signOut: () => { store.getState().logout() } } }
})

import { useAuthStore } from '../store/authStore'
import { runSignOut } from '../test/signOut'
import { endExpiredSession, resetSessionExpiryForTests } from './sessionExpiry'

const AUTH_KEY = useAuthStore.persist.getOptions().name ?? ''

/** Whether a stored record of the session says signed in. */
function signedIn(record: string | undefined): unknown {
  const parsed: unknown = JSON.parse(record ?? 'null')
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return undefined
  const { state } = parsed
  return typeof state === 'object' && state !== null && 'isAuthenticated' in state ? state.isAuthenticated : undefined
}

function signOut(): void {
  stubLocationAssign('/w/acme/dashboard')
  runSignOut()
}

function expire(): void {
  Object.defineProperty(window, 'location', { value: { replace: vi.fn() }, writable: true, configurable: true })
  resetSessionExpiryForTests()
  endExpiredSession()
}

beforeEach(() => {
  recordsAtSignal.length = 0
  useAuthStore.setState({ isAuthenticated: true })
})

describe('ending a session in this tab', () => {
  it.each([['the sign-out', signOut], ['an expired session', expire]])(
    '%s writes the session\'s record signed out before it tells the other tabs',
    (_name, end) => {
      expect(signedIn(saved.get(AUTH_KEY))).toBe(true)
      end()
      expect(recordsAtSignal.map(signedIn)).toStrictEqual([false])
    },
  )
})
