/**
 * `/admin` showing `page` beside a "Home" link, and a `/` "Home page", in a DATA router
 * (so the unsaved-changes guard's `useBlocker` is live) with a fresh query client: the
 * mount the /admin guard-contract specs share, and their scenario scaffold (leave =
 * follow "Home"; stayed = still on /admin; left = the Home page shows).
 */
import { expect } from 'vitest'
import { screen } from '@testing-library/react'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import type { ReactNode } from 'react'
import type { GuardUser, GuardedEditorScenario } from '@test/unsavedGuardContract'

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

type AdminMount = ReturnType<typeof mountAtAdmin>

/** What a spec supplies: its page, when it is ready, the edit and how to see it, what lands meanwhile. */
interface AdminGuardParts {
  readonly page: () => ReactNode
  readonly ready: () => Promise<void>
  readonly edit: (user: GuardUser) => Promise<void>
  readonly expectDraft: () => void
  readonly whileDialogOpen?: (mounted: AdminMount) => Promise<void>
}

/** The guard contract's scenario for an editor on /admin; `mounted()` is the live mount. */
export function adminGuardScenario(parts: AdminGuardParts): { scenario: GuardedEditorScenario; mounted: () => AdminMount } {
  const slot: { current?: AdminMount } = {}
  const mounted = (): AdminMount => {
    if (slot.current === undefined) throw new Error('not mounted')
    return slot.current
  }
  const { whileDialogOpen } = parts
  return {
    mounted,
    scenario: {
      mount: async () => {
        slot.current = mountAtAdmin(parts.page())
        await parts.ready()
      },
      edit: parts.edit,
      expectDraft: parts.expectDraft,
      leave: async (user: GuardUser) => { await user.click(screen.getByRole('link', { name: 'Home' })) },
      expectStayed: () => expect(mounted().router.state.location.pathname).toBe('/admin'),
      expectLeft: async () => { expect(await screen.findByText('Home page')).toBeInTheDocument() },
      whileDialogOpen: whileDialogOpen === undefined ? undefined : () => whileDialogOpen(mounted()),
    },
  }
}
