/**
 * Regression tests for issue #173: without a route-level errorElement, a
 * render error in any single page unmounted the entire app (the amplifier
 * behind the #159/#167/#171 crashes). These pin that a throwing route
 * renders the fallback while the surrounding layout stays mounted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom'
import RouteErrorBoundary, { describeRouteError } from './index'

function TestLayout() {
  return (
    <div>
      <nav data-testid="sidebar">sidebar stays alive</nav>
      <Outlet />
    </div>
  )
}

function BrokenPage(): never {
  throw new Error('boom from page render')
}

function renderRouterAt(initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <TestLayout />,
        children: [
          { index: true, element: <div data-testid="home-page">healthy home</div> },
          { path: 'broken', element: <BrokenPage />, errorElement: <RouteErrorBoundary /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
  return render(<RouterProvider router={router} />)
}

describe('RouteErrorBoundary (issue #173)', () => {
  beforeEach(() => {
    // react-router and React both report the caught render error; keep the
    // test output clean without hiding unrelated failures from assertions.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces only the failing route content — the layout survives', () => {
    renderRouterAt('/broken')

    // Fallback rendered with the actual error surfaced.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('boom from page render')).toBeInTheDocument()

    // The app did NOT unmount: layout content is still there.
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
  })

  it('offers a working path back home', async () => {
    const user = userEvent.setup()
    renderRouterAt('/broken')

    await user.click(screen.getByRole('link', { name: /go to home/i }))

    expect(screen.getByTestId('home-page')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers a reload action', () => {
    renderRouterAt('/broken')

    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument()
  })
})

describe('describeRouteError', () => {
  it('summarizes route error responses as status + statusText', () => {
    // isRouteErrorResponse is shape-based; this mirrors what the router
    // delivers for thrown Responses (e.g. 404s from loaders).
    const routeError = { status: 404, statusText: 'Not Found', internal: false, data: 'No route matches' }

    expect(describeRouteError(routeError)).toBe('404 Not Found')
  })

  it('uses the message of thrown Errors', () => {
    expect(describeRouteError(new Error('kaput'))).toBe('kaput')
  })

  it('stringifies anything else', () => {
    expect(describeRouteError('plain string failure')).toBe('plain string failure')
    expect(describeRouteError(42)).toBe('42')
  })
})
