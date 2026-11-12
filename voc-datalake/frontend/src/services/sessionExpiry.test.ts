/**
 * @fileoverview Tests for the shared session-expiry seam.
 *
 * The point of these is the *reason*: signing out was never the missing
 * behaviour, telling the user why was.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./auth', () => ({
  authService: { signOut: vi.fn() },
}))

import { authService } from './auth'
import {
  endExpiredSession,
  isSessionExpiredRedirect,
  resetSessionExpiryForTests,
  SESSION_EXPIRED_PATH,
} from './sessionExpiry'
import { refusedWorkspaceIds, rememberRefused } from '../workspace/refusedWorkspaces'

describe('sessionExpiry', () => {
  const originalLocation = window.location
  const replace = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // The redirect is idempotent by design, and production resets it with a
    // full document load. Without this reset here, the first case to end a
    // session would silently disarm every later one.
    resetSessionExpiryForTests()
    Object.defineProperty(window, 'location', {
      value: { replace },
      writable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    })
  })

  describe('endExpiredSession', () => {
    it('clears auth state before navigating', () => {
      endExpiredSession()

      expect(authService.signOut).toHaveBeenCalledWith()
      expect(replace).toHaveBeenCalledWith(SESSION_EXPIRED_PATH)
    })

    it("forgets the tab's refused workspaces, so whoever signs in next asks the server afresh", () => {
      rememberRefused('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
      endExpiredSession()

      expect(refusedWorkspaceIds()).toStrictEqual([])
    })

    it("forgets every workspace's saved assistant, draft and filter records for whoever signs in next", () => {
      window.sessionStorage.setItem('voc-assistant-ui:w/juniper', '{"state":{"open":true}}')
      endExpiredSession()

      expect(window.sessionStorage.getItem('voc-assistant-ui:w/juniper')).toBeNull()
    })

    it('navigates once however many callers discover the dead session', () => {
      // Concurrent requests 401 together, and all three callers share this
      // seam, so this is the normal case rather than an edge one.
      endExpiredSession()
      endExpiredSession()
      endExpiredSession()

      expect(replace).toHaveBeenCalledTimes(1)
      expect(authService.signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('isSessionExpiredRedirect', () => {
    it('recognizes the path endExpiredSession navigates to', () => {
      const search = SESSION_EXPIRED_PATH.slice(SESSION_EXPIRED_PATH.indexOf('?'))

      expect(isSessionExpiredRedirect(search)).toBe(true)
    })

    it('is false for a plain visit to the login page', () => {
      expect(isSessionExpiredRedirect('')).toBe(false)
      expect(isSessionExpiredRedirect('?next=/dashboard')).toBe(false)
    })

    it('is false for a flag that is present but not set', () => {
      expect(isSessionExpiredRedirect('?expired=0')).toBe(false)
      expect(isSessionExpiredRedirect('?expired')).toBe(false)
    })
  })
})
