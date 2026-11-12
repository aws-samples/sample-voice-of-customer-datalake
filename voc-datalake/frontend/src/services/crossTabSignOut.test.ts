/**
 * Another tab's sign-out or expired session: an open tab forgets every workspace's saved records and, when it is
 * signed in, leaves for the plain sign-in page with a full page load, so its stores cannot write the last person's
 * records back. Only the explicit signal counts: a signed-out write of the session's record (a refresh that fails for
 * a moment, then succeeds), a sign-in elsewhere or another key changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'
import { withMemoryLocalStorage } from '../test/memoryLocalStorage'

/** The browser's localStorage, kept in a map for this file. */
const saved = withMemoryLocalStorage()

/** The sign-out of the tab that ends its session writes the session's record signed out, as authStore.logout() does. */
vi.mock('./auth', () => ({ authService: { signOut: () => { saved.set('voc-auth', SIGNED_OUT) } } }))

import { useAuthStore } from '../store/authStore'
import { useSignOut } from '../hooks/useSignOut'
import { refusedWorkspaceIds, rememberRefused } from '../workspace/refusedWorkspaces'
import { platformEntryFor, rememberPlatformEntry } from '../workspace/platformEntry'
import { endExpiredSession, resetSessionExpiryForTests } from './sessionExpiry'
// The listener installs itself when this module loads (main.tsx imports it for that; here the import does it).
import { SESSION_ENDED_KEY } from './crossTabSignOut'

/** The session's record as the auth store persists it. */
const authRecord = (isAuthenticated: boolean) => JSON.stringify({ state: { isAuthenticated }, version: 1 })
const SIGNED_IN = authRecord(true)
const SIGNED_OUT = authRecord(false)

const AUTH_KEY = useAuthStore.persist.getOptions().name ?? ''
const RECORDS = ['voc-assistant-ui:w/acme', 'voc-manual-import:w/acme', 'voc-config:w/acme', 'voc-config', 'voc-manual-import']
const sorted = (keys: Iterable<string>) => [...keys].sort((a, b) => a.localeCompare(b))
const savedRecords = () => sorted([...saved.keys()].filter((key) => key !== AUTH_KEY && key !== SESSION_ENDED_KEY))

/** `window.location` with its full page loads recorded. */
function stubLocation() {
  const replace = vi.fn<(url: string) => void>()
  const assign = vi.fn<(url: string) => void>()
  const { origin } = window.location
  Object.defineProperty(window, 'location', {
    value: { origin, href: `${origin}/w/acme/dashboard`, pathname: '/w/acme/dashboard', replace, assign },
    writable: true, configurable: true,
  })
  return { replace, assign }
}

/** This tab, signed in or not, with records of acme and outside workspaces saved. */
function thisTab(signedIn = true) {
  useAuthStore.setState({ isAuthenticated: signedIn })
  for (const key of RECORDS) saved.set(key, '{}')
  rememberRefused('ws-juniper')
  return stubLocation()
}

/** The browser tells this tab that another one wrote `key` (in localStorage unless `storageArea` says otherwise). */
function otherTabWrote(key: string, newValue: string | null, storageArea: Storage = window.localStorage): void {
  const event = new StorageEvent('storage', { key, newValue })
  // jsdom's StorageEvent takes only its own Storage; the suite's localStorage is a mock (test/setup.ts).
  Object.defineProperty(event, 'storageArea', { value: storageArea })
  window.dispatchEvent(event)
}

/** The signal another tab's `end` (its sign-out, its expired session) writes, as the browser hands it on. */
function signalOf(end: () => void): string {
  end()
  const value = saved.get(SESSION_ENDED_KEY)
  if (value === undefined) throw new Error('no signal written')
  return value
}

/**
 * Another tab runs `end`, then this tab is set up: one window plays both, so the other tab's own forgetting and page
 * load come first, and its signed-out write of the session's record is put back last, as the browser would hold it.
 */
function thisTabAfter(end: () => void, signedIn = true) {
  const value = signalOf(end)
  const { replace } = thisTab(signedIn)
  saved.set(AUTH_KEY, SIGNED_OUT)
  return { replace, value }
}

function signOutElsewhere(): void {
  const client = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useSignOut(), { wrapper })
  act(() => result.current())
}

function expireElsewhere(): void {
  resetSessionExpiryForTests()
  endExpiredSession()
}

beforeEach(() => window.sessionStorage.clear())

describe('another tab ending its session', () => {
  it.each([['signs out', signOutElsewhere], ['has its session expire', expireElsewhere]])(
    'when it %s, this tab forgets every workspace\'s records and leaves for /login',
    (_name, end) => {
      const { replace, value } = thisTabAfter(end)
      otherTabWrote(SESSION_ENDED_KEY, value)
      // The plain draft and filters are kept, as after this tab's own sign-out.
      expect(savedRecords()).toStrictEqual(['voc-config', 'voc-manual-import'])
      expect(refusedWorkspaceIds()).toStrictEqual([])
      expect(replace).toHaveBeenCalledExactlyOnceWith('/login')
    },
  )

  it("forgets a platform admin's console entries too, as this tab's own sign-out does", () => {
    const { value } = thisTabAfter(expireElsewhere)
    rememberPlatformEntry({ id: 'ws_01JCJNPR0000000000000000J1', slug: 'juniper' })
    otherTabWrote(SESSION_ENDED_KEY, value)
    expect(platformEntryFor('juniper')).toBeNull()
  })

  it('writes a new signal each time, so a second sign-out is heard too', () => {
    expect(signalOf(expireElsewhere)).not.toBe(signalOf(expireElsewhere))
  })

  it('forgets the records but stays on the page in a tab that is signed out already', () => {
    const { replace, value } = thisTabAfter(expireElsewhere, false)
    otherTabWrote(SESSION_ENDED_KEY, value)
    expect(savedRecords()).toStrictEqual(['voc-config', 'voc-manual-import'])
    expect(replace).not.toHaveBeenCalled()
  })

  it('neither wipes nor reloads on a late signal, once a person has signed in since', () => {
    const { replace, value } = thisTabAfter(expireElsewhere)
    saved.set(AUTH_KEY, SIGNED_IN)
    otherTabWrote(SESSION_ENDED_KEY, value)
    expectUntouched(replace)
  })
})

/** Every record and the refused list still there, and no reload. */
function expectUntouched(replace: ReturnType<typeof thisTab>['replace']): void {
  expect(savedRecords()).toStrictEqual(sorted(RECORDS))
  expect(refusedWorkspaceIds()).toStrictEqual(['ws-juniper'])
  expect(replace).not.toHaveBeenCalled()
}

describe('what does not end this tab\'s session', () => {
  it.each([
    // ProtectedRoute's first refresh fails for a moment (logout() writes the record), then its retry succeeds.
    ['a signed-out write of the session\'s record', AUTH_KEY, SIGNED_OUT],
    ['a sign-in', AUTH_KEY, SIGNED_IN],
    ['another key', 'voc-theme', 'dark'],
    ['the signal removed', SESSION_ENDED_KEY, null],
  ])('%s in another tab changes nothing', (_name, key, value) => {
    const { replace } = thisTab()
    otherTabWrote(key, value)
    expectUntouched(replace)
  })

  it('a storage event for the signal from sessionStorage (a same-origin frame) changes nothing', () => {
    const { replace } = thisTab()
    otherTabWrote(SESSION_ENDED_KEY, 'x', window.sessionStorage)
    expect(savedRecords()).toStrictEqual(sorted(RECORDS))
    expect(replace).not.toHaveBeenCalled()
  })
})
