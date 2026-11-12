/**
 * The members page: not a page outside a workspace; the list for every member; add, role change and removal for a
 * workspace admin, each refusal said in words; leave for a member, then a full page load to `/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
import { stubLocationAssign } from '../../test/location'
import { defined } from '../../test/defined'
import { ACME, JUNIPER } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import Members from './Members'

const MEMBERS = '/me/workspaces/current/members'
const ADA = { sub: 'sub-ada', role: 'admin', email: 'ada@example.com', name: 'Ada Admin', invited_by: '', joined_at: '2026-10-13T09:00:00Z' }
const VIC = { sub: 'sub-vic', role: 'viewer', email: 'vic@example.com', name: '', invited_by: 'sub-ada', joined_at: '' }

function renderPage(workspace: CurrentWorkspace | null, routes: Record<string, RouteHandler> = {}, client = createTestQueryClient()) {
  routeFetchApi({
    'GET /me/workspaces': () => ({ workspaces: [ACME, JUNIPER] }),
    // The role the server applies: the membership's, unless a spec routes its own.
    'GET /me/workspaces/current': () => ({ workspace }),
    [`GET ${MEMBERS}`]: () => ({ members: [ADA, VIC], next_cursor: null }),
    ...routes,
  })
  act(() => setCurrentWorkspace(workspace))
  return render(
    <QueryClientProvider client={client}>
      <TestRouter initialEntries={['/members']}><Members /></TestRouter>
    </QueryClientProvider>,
  )
}

/** The list item of a member, by the text that names them. */
const row = (who: string) => defined(screen.getAllByRole('listitem').find((item) => item.textContent.includes(who)), who)

beforeEach(() => {
  resetFetchApi()
  useAuthStore.setState({ user: { username: 'ada', email: 'ada@example.com', groups: ['admins'], sub: 'sub-ada' } })
})
afterEach(() => {
  setCurrentWorkspace(null)
  useAuthStore.setState({ user: null })
})

describe('Members outside a workspace', () => {
  it('is not a page', () => {
    renderPage(null)
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalledWith(MEMBERS, undefined)
  })
})

describe('Members for a workspace admin', () => {
  it('lists the members with their role and when they joined, the caller marked', async () => {
    renderPage(ACME)
    expect(await screen.findByText('vic@example.com')).toBeInTheDocument()
    expect(within(row('Ada Admin')).getByText('You')).toBeInTheDocument()
    expect(within(row('Ada Admin')).getByText(/^Joined /)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Role of vic@example.com' })).toHaveValue('viewer')
  })

  it('offers Remove for others, never for the caller\'s own row', async () => {
    renderPage(ACME)
    expect(await screen.findByRole('button', { name: 'Remove vic@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Ada Admin' })).not.toBeInTheDocument()
  })

  it('adds a member by email and role, and says no email was sent to an existing account', async () => {
    const added = vi.fn<RouteHandler>(() => ({ member: { ...VIC, sub: 'sub-eve', email: 'eve@example.com', role: 'editor', account: 'existing' } }))
    renderPage(ACME, { [`POST ${MEMBERS}`]: added })
    await userEvent.type(await screen.findByLabelText('Email'), ' eve@example.com ')
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'editor')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    expect(await screen.findByRole('status')).toHaveTextContent('eve@example.com is now a member (Editor). No email was sent: let them know.')
    expect(added).toHaveBeenCalledWith({ email: 'eve@example.com', role: 'editor' })
  })

  it('checks the address before sending it', async () => {
    renderPage(ACME)
    await userEvent.type(await screen.findByLabelText('Email'), 'not-an-address')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    // Focus moves to the field, whose description now starts with the error: a screen reader reads it there.
    expect(screen.getByLabelText('Email')).toHaveFocus()
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(/^Enter a valid email address, like name@example\.com\./)
    expect(fetchApi).not.toHaveBeenCalledWith(MEMBERS, expect.objectContaining({ method: 'POST' }))
  })

  it('says why a new email was refused to a workspace admin outside the deployment\'s administrators', async () => {
    const refusal = 'This email has no account yet: only a deployment administrator can create one while the data is shared across workspaces'
    renderPage(ACME, { [`POST ${MEMBERS}`]: () => { throw new ApiError(403, refusal) } })
    await userEvent.type(await screen.findByLabelText('Email'), 'new@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This email has no account yet. Only a deployment administrator can create one while workspaces share their data.')
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com')
  })

  it('changes a role, says so, and shows the role the list reads back', async () => {
    const server = { members: [ADA, VIC] }
    const changed = vi.fn<RouteHandler>(() => {
      server.members = [ADA, { ...VIC, role: 'editor' }]
      return { member: { sub: 'sub-vic', role: 'editor' } }
    })
    renderPage(ACME, { [`GET ${MEMBERS}`]: () => ({ members: server.members, next_cursor: null }), [`PUT ${MEMBERS}/sub-vic`]: changed })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Role of vic@example.com' }), 'editor')
    expect(await screen.findByRole('status')).toHaveTextContent("vic@example.com's role is now Editor.")
    expect(changed).toHaveBeenCalledWith({ role: 'editor' })
    // The menu follows the list (controlled by the member's role), so this holds only once the list was read again.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role of vic@example.com' })).toHaveValue('editor'))
  })

  it('asks before an admin lowers their own role, and sends nothing on Cancel', async () => {
    const changed = vi.fn<RouteHandler>(() => ({ member: { sub: 'sub-ada', role: 'viewer' } }))
    renderPage(ACME, { [`PUT ${MEMBERS}/sub-ada`]: changed })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Role of Ada Admin' }), 'viewer')
    const dialog = screen.getByRole('dialog', { name: 'Lower your own role?' })
    expect(dialog).toHaveTextContent('You will be Viewer in Acme Outfitters')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(changed).not.toHaveBeenCalled()
  })

  it('shows the last-admin refusal when the only admin confirms demoting themselves', async () => {
    renderPage(ACME, { [`PUT ${MEMBERS}/sub-ada`]: () => { throw new ApiError(409, 'A workspace needs an admin: make another member an admin first') } })
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Role of Ada Admin' }), 'viewer')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Make me Viewer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A workspace needs an admin: make another member an admin first.')
  })

  it('removes a member only after the confirmation, and the list reads back without them', async () => {
    const server = { members: [ADA, VIC] }
    const removed = vi.fn<RouteHandler>(() => {
      server.members = [ADA]
      return { removed: 'sub-vic' }
    })
    renderPage(ACME, { [`GET ${MEMBERS}`]: () => ({ members: server.members, next_cursor: null }), [`DELETE ${MEMBERS}/sub-vic`]: removed })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove vic@example.com' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove this member?' })).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Removed vic@example.com.')
    expect(removed).toHaveBeenCalledExactlyOnceWith(undefined)
    await waitFor(() => expect(screen.queryByText('vic@example.com')).not.toBeInTheDocument())
  })

  it('says a membership changed meanwhile', async () => {
    renderPage(ACME, { [`DELETE ${MEMBERS}/sub-vic`]: () => { throw new ApiError(409, 'The membership changed meanwhile: reload the members and try again') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove vic@example.com' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The membership changed meanwhile. Reload the page and try again.')
  })

  it('reads the next page on Show more', async () => {
    renderPage(ACME, {
      [`GET ${MEMBERS}`]: () => ({ members: [ADA], next_cursor: 'next' }),
      [`GET ${MEMBERS}?cursor=next`]: () => ({ members: [VIC], next_cursor: null }),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('vic@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })

  it('says so when the next page cannot be read, keeping Show more to try again', async () => {
    renderPage(ACME, { [`GET ${MEMBERS}`]: () => ({ members: [ADA], next_cursor: 'next' }) }) // the next page: unrouted, 404
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The next page could not be loaded. Choose Show more to try again.')
    expect(screen.getByRole('button', { name: 'Show more' })).toBeEnabled()
  })
})

describe('Members for a platform admin who is also an editor here', () => {
  const READ_ONLY = 'Only the workspace\'s admins can add members, change roles or remove members.'

  it('shows the loading state, never the read-only page, until /current gives the role the server applies', async () => {
    const server: { answer?: (body: unknown) => void } = {}
    const current = new Promise<unknown>((resolve) => { server.answer = resolve })
    renderPage(JUNIPER, { 'GET /me/workspaces/current': () => current })
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.queryByText(READ_ONLY)).not.toBeInTheDocument()
    act(() => server.answer?.({ workspace: { ...JUNIPER, role: 'admin' } }))
    expect(await screen.findByRole('button', { name: 'Add member' })).toBeInTheDocument()
    expect(screen.queryByText(READ_ONLY)).not.toBeInTheDocument()
  })

  it('keeps the membership\'s role at the first failure of /current other than a 404, even where the client retries', async () => {
    const failed = vi.fn<RouteHandler>(() => { throw new ApiError(500, 'Internal server error') })
    // Retries on, as the app's own client has them: the page must not spin through them.
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 10_000 } } })
    renderPage(JUNIPER, { 'GET /me/workspaces/current': failed }, client)
    expect(await screen.findByText(READ_ONLY)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument()
    expect(failed).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})

describe('Members for an editor or a viewer', () => {
  it('shows the list read-only', async () => {
    renderPage(JUNIPER)
    expect(await screen.findByText('vic@example.com')).toBeInTheDocument()
    expect(screen.getByText('Only the workspace\'s admins can add members, change roles or remove members.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('leaves after the confirmation, then loads the start page', async () => {
    const assign = stubLocationAssign('/w/juniper/members')
    const left = vi.fn<RouteHandler>(() => ({ removed: 'sub-ada' }))
    renderPage(JUNIPER, { [`DELETE ${MEMBERS}/sub-ada`]: left })
    await userEvent.click(await screen.findByRole('button', { name: 'Leave workspace' }))
    const dialog = screen.getByRole('dialog', { name: 'Leave this workspace?' })
    expect(dialog).toHaveTextContent('You will no longer be able to open Juniper Trail Co.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave workspace' }))
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/'))
  })

  it('offers no Leave to a platform admin who entered without a membership, once their own list has been read', async () => {
    const client = createTestQueryClient()
    renderPage({ id: 'ws_01JCFLDT0000000000000000F1', slug: 'acme-field', name: 'Acme Outfitters Field Team', role: 'admin' }, {}, client)
    expect(await screen.findByText('vic@example.com')).toBeInTheDocument()
    // The list that decides it has answered (naming acme and juniper, not this one), so the absence is its verdict.
    await waitFor(() => expect(client.getQueryState(['my-workspaces'])?.status).toBe('success'))
    expect(screen.queryByRole('button', { name: 'Leave workspace' })).not.toBeInTheDocument()
  })
})
