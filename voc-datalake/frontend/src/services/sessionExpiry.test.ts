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
import { endExpiredSession, isSessionExpiredRedirect, SESSION_EXPIRED_PATH } from './sessionExpiry'

describe('sessionExpiry', () => {
  const originalLocation = window.location
  const replace = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
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

      // eslint-disable-next-line vitest/prefer-called-with
      expect(authService.signOut).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith(SESSION_EXPIRED_PATH)
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
