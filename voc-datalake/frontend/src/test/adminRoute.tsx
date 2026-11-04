/**
 * `/admin` showing `page` beside a "Home" link, and a `/` "Home page", in a DATA router
 * (so the unsaved-changes guard's `useBlocker` is live) with a fresh query client: the
 * mount the /admin guard-contract specs share.
 */
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import type { ReactNode } from 'react'

export function mountAtAdmin(page: ReactNode) {
  const client = createTestQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>Home page</p> },
      { path: '/admin', element: <><Link to="/">Home</Link>{page}</> },
    ],
    { initialEntries: ['/admin'] },
  )
  renderWithQueryClient(<RouterProvider router={router} />, client)
  return { client, router }
}
