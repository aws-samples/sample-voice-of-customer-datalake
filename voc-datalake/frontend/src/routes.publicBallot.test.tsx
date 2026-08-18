/**
 * The anonymous ballot route is DELIBERATELY unauthenticated, and this pins it.
 *
 * Every other route in this app is a child of the protected layout, so `/vote/:id`
 * is the exception — and an exception that lives only in a comment is one a later
 * "tidy the routes into the layout" removes without anything going red. Two ways
 * that tidy-up breaks the feature, and both are asserted here:
 *
 *  * the route ends up INSIDE `ProtectedRoute`, so a room holding a QR is bounced
 *    to the login page; or
 *  * the route's PATH drifts from `BALLOT_PAGE_PATH_PREFIX`, which is what the QR
 *    encodes. That failure is invisible on screen — the code scans perfectly and
 *    lands on the SPA's not-found state.
 *
 * The route table is read as data rather than rendered, because what is being
 * asserted is its SHAPE: which element wraps which path. Rendering could only
 * show that some page appeared for some URL.
 */
import { describe, it, expect } from 'vitest'
import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'

import { routes } from './routes'
import { BALLOT_PAGE_PATH_PREFIX } from './api/ballotPageUrl'
import ProtectedRoute from './components/ProtectedRoute'

/** The ballot route as `routes.tsx` declares it — a TOP-LEVEL entry, which is
 *  half of what makes it reachable without an account. */
const ballotRoute = routes.find((route) => route.path === `${BALLOT_PAGE_PATH_PREFIX}:sessionId`)

/** Every element type in one route's element tree, so "is `ProtectedRoute`
 *  anywhere above this page" is answerable rather than assumed from the top node. */
function elementTypes(node: ReactNode): unknown[] {
  if (!isValidElement(node)) return []
  const element: ReactElement<{ children?: ReactNode }> = node
  return [element.type, ...elementTypes(element.props.children)]
}

function guardsChildren(route: RouteObject): boolean {
  return elementTypes(route.element).includes(ProtectedRoute)
}

describe('the public ballot route', () => {
  it('is declared, at the path the QR encodes', () => {
    // One spelling, checked against the other. `ballotPageUrl` builds the address
    // from the prefix and this is the only thing that says the router answers it.
    expect(ballotRoute, `no top-level route at ${BALLOT_PAGE_PATH_PREFIX}:sessionId`).toBeDefined()
  })

  it('sits outside the authentication guard', () => {
    expect(ballotRoute && guardsChildren(ballotRoute)).toBe(false)
  })

  it('is not also declared inside the protected tree', () => {
    // The other half of the trap: a copy left behind under the layout would make
    // the feature look present while only signed-in users could reach it.
    const nested = routes
      .filter(guardsChildren)
      .flatMap((route) => route.children ?? [])
      .map((child) => child.path)
      .filter((path) => path?.startsWith(BALLOT_PAGE_PATH_PREFIX.replace(/^\//, '')))

    expect(nested).toEqual([])
  })

  it('is the only unguarded route besides login', () => {
    // Stated as an exact list, so the next public page is a deliberate edit here
    // rather than an unremarked one. `/` is the protected layout itself.
    const unguarded = routes
      .filter((route) => !guardsChildren(route))
      .map((route) => route.path)
      .sort()

    expect(unguarded).toEqual(['/login', `${BALLOT_PAGE_PATH_PREFIX}:sessionId`])
  })
})
