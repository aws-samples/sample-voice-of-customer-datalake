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
import RouteErrorBoundary from './index'
import { describeRouteError } from './describeRouteError'

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
  // Component under test console.errors deliberately (observability), and
  // react-router/React report the caught error too; silence the noise while
  // keeping the spy available for the reporting assertion.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('replaces only the failing route content — the layout survives', () => {
    renderRouterAt('/broken')

    // Fallback rendered; error detail is shown too since vitest runs in DEV
    // (production hides it and keeps it in the log path only).
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('boom from page render')).toBeInTheDocument()

    // The app did NOT unmount: layout content is still there.
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
  })

  it('reports the full error object so caught crashes stay observable', () => {
    renderRouterAt('/broken')

    const reported = vi
      .mocked(console.error)
      .mock.calls.some(
        (args) =>
          args[0] === 'Route render error caught by RouteErrorBoundary:' &&
          args[1] instanceof Error &&
          args[1].message === 'boom from page render',
      )
    expect(reported).toBe(true)
  })

  it('offers a working path back home', async () => {
    const user = userEvent.setup()
    renderRouterAt('/broken')

    await user.click(screen.getByRole('link', { name: /go to home/i }))

    expect(screen.getByTestId('home-page')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reload action triggers window.location.reload', async () => {
    const reload = vi.fn()
    // jsdom's Location is non-configurable; stubGlobal swaps the whole
    // object (cast-free) so the component's reload call lands on the spy.
    vi.stubGlobal('location', { ...window.location, reload })

    const user = userEvent.setup()
    renderRouterAt('/broken')

    await user.click(screen.getByRole('button', { name: /reload page/i }))

    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('describeRouteError', () => {
  it('summarizes route error responses as status + statusText + data detail', () => {
    // isRouteErrorResponse is shape-based; this mirrors what the router
    // delivers for thrown Responses (e.g. 404s from loaders).
    const routeError = { status: 404, statusText: 'Not Found', internal: false, data: 'No route matches' }

    expect(describeRouteError(routeError)).toBe('404 Not Found — No route matches')
  })

  it('omits the data suffix when data is not a useful string', () => {
    const routeError = { status: 500, statusText: 'Server Error', internal: false, data: null }

    expect(describeRouteError(routeError)).toBe('500 Server Error')
  })

  it('uses the message of thrown Errors', () => {
    expect(describeRouteError(new Error('kaput'))).toBe('kaput')
  })

  it('stringifies anything else', () => {
    expect(describeRouteError('plain string failure')).toBe('plain string failure')
    expect(describeRouteError(42)).toBe('42')
  })
})
