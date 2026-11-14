/**
 * Which paths are public pages: each root and what is under it, not a path that only starts with the same letters.
 * The list itself is held to routes.tsx by routes.publicBallot.test.tsx.
 */
import { describe, expect, it } from 'vitest'
import { isPublicPath } from './publicRoutes'
import { appPathname } from './workspace/workspacePath'

describe('isPublicPath', () => {
  it.each(['/login', '/vote/s-123', '/board', '/board/login', '/board/roadmap', '/review/r-9', '/unsubscribe'])(
    '%s is a public page', (path) => {
      expect(isPublicPath(path)).toBe(true)
    },
  )

  it.each(['/', '/dashboard', '/feedback/f-1', '/boards', '/loginx', '/admin', '/w/acme/vote/s-123'])(
    '%s is not', (path) => {
      expect(isPublicPath(path)).toBe(false)
    },
  )

  it("reads a workspace's page once its base path is stripped", () => {
    expect(isPublicPath(appPathname('/w/acme/login', '/w/acme'))).toBe(true)
    expect(isPublicPath(appPathname('/w/acme/dashboard', '/w/acme'))).toBe(false)
  })
})
