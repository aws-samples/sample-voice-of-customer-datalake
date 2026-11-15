/**
 * The workspace's name: every member reads it and its address; an admin renames it, the name checked by the server's
 * rules before it is sent (1 to 80 characters once trimmed, no control character), the answer written into the
 * caller's caches (the header's menu and the gate read them) without reading them again, and each refusal in words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { ACME, JUNIPER } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { currentWorkspaceKey, myWorkspacesKey } from '../../api/workspacesApi'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { useMyWorkspaces } from '../../workspace/useMyWorkspaces'
import WorkspaceNameCard from './WorkspaceNameCard'

const CURRENT = '/me/workspaces/current'

/** The caller's list, read as the header's workspace menu reads it (already loaded, as under the gate). */
function MyWorkspacesReader() {
  useMyWorkspaces()
  return null
}

function renderCard(workspace: CurrentWorkspace, routes: Record<string, RouteHandler> = {}): QueryClient {
  routeFetchApi({
    'GET /me/workspaces': () => ({ workspaces: [ACME, JUNIPER] }),
    [`GET ${CURRENT}`]: () => ({ workspace: { ...workspace, platform_admin: false } }),
    ...routes,
  })
  // The `config` family the caller's workspaces belong to: read once, never stale on its own.
  const client = createTestQueryClient({ staleTime: Infinity })
  client.setQueryData(myWorkspacesKey(), [ACME, JUNIPER])
  render(
    <QueryClientProvider client={client}>
      <MyWorkspacesReader />
      <WorkspaceNameCard workspace={workspace} isAdmin={workspace.role === 'admin'} />
    </QueryClientProvider>,
  )
  return client
}

/** How many times `path` was read (a GET: no request options). */
const reads = (path: string) => vi.mocked(fetchApi).mock.calls.filter(([called, init]) => called === path && init === undefined).length
const currentReads = () => reads(CURRENT)

async function openRename() {
  await userEvent.click(await screen.findByRole('button', { name: 'Rename' }))
  const dialog = await screen.findByRole('dialog', { name: 'Rename the workspace' })
  return { dialog, field: within(dialog).getByLabelText('Name'), save: within(dialog).getByRole('button', { name: 'Save' }) }
}

beforeEach(() => resetFetchApi())

/** Rename Acme to `typed` through the dialog; the PUT's handler answers it renamed to the trimmed name. */
async function renameAcme(typed: string) {
  const renamed = vi.fn<RouteHandler>(() => ({ workspace: { ...ACME, name: typed.trim(), platform_admin: false } }))
  const client = renderCard(ACME, { [`PUT ${CURRENT}`]: renamed })
  await waitFor(() => expect(currentReads()).toBe(1))
  const { field, save } = await openRename()
  await userEvent.clear(field)
  await userEvent.type(field, typed)
  await userEvent.click(save)
  return { renamed, client }
}

describe('WorkspaceNameCard', () => {
  it('shows a member who is not an admin the name and the address, and who can rename it', () => {
    renderCard(JUNIPER)
    const card = screen.getByRole('region', { name: 'Workspace name' })
    expect(within(card).getByText('Juniper Trail Co.')).toBeInTheDocument()
    expect(within(card).getByText('/w/juniper')).toBeInTheDocument()
    expect(within(card).getByText("Only this workspace's admins can rename it.")).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
  })

  it('opens the rename for an admin with the name filled in, capped at 80 characters, the address said to stay', async () => {
    renderCard(ACME)
    const { dialog, field } = await openRename()
    // The slug is not editable: the dialog says the address stays.
    expect(dialog).toHaveTextContent('Its address, /w/acme, stays the same')
    expect(field).toHaveValue('Acme Outfitters')
    expect(field).toHaveAttribute('maxLength', '80')
  })

  it('renames it, trimmed, says so and shows the new name', async () => {
    const { renamed } = await renameAcme('  Acme Trail Gear  ')
    expect(await screen.findByRole('status')).toHaveTextContent('The workspace is now called Acme Trail Gear.')
    expect(renamed).toHaveBeenCalledExactlyOnceWith({ name: 'Acme Trail Gear' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Workspace name' })).getByText('Acme Trail Gear')).toBeInTheDocument()
  })

  it("writes the answer into the caller's caches (the header's menu, the gate) and reads neither again", async () => {
    const { client } = await renameAcme('Acme Trail Gear')
    await screen.findByRole('status')
    // Another warm API container may still answer the old name for a while: nothing is read again.
    expect({
      list: client.getQueryData<CurrentWorkspace[]>(myWorkspacesKey())?.map((row) => row.name),
      current: client.getQueryData<CurrentWorkspace>(currentWorkspaceKey(ACME.id))?.name,
      reads: { current: currentReads(), list: reads('/me/workspaces') },
    }).toStrictEqual({ list: ['Acme Trail Gear', 'Juniper Trail Co.'], current: 'Acme Trail Gear', reads: { current: 1, list: 0 } })
  })

  it('refuses an empty name and one with a control character before sending anything', async () => {
    const renamed = vi.fn<RouteHandler>(() => ({ workspace: { ...ACME, platform_admin: false } }))
    renderCard(ACME, { [`PUT ${CURRENT}`]: renamed })
    const { dialog, field, save } = await openRename()
    await userEvent.clear(field)
    await userEvent.type(field, '   ')
    expect(save).toBeDisabled()
    fireEvent.change(field, { target: { value: 'Acme\tOutfitters' } })
    await userEvent.click(save)
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The name cannot contain control characters, such as tabs or line breaks.')
    expect(renamed).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'The workspace changed meanwhile: reload and try again', 'The workspace changed meanwhile. Reload the page and try again.'],
    [403, 'You are no longer an admin of this workspace', 'You are no longer an admin of this workspace. Reload the page.'],
    [400, 'name must be at most 80 characters', 'That did not work: name must be at most 80 characters'],
  ])('says a %i refusal in words, keeps the dialog open and reads the workspace again', async (status, reason, shown) => {
    renderCard(ACME, { [`PUT ${CURRENT}`]: () => { throw new ApiError(status, reason) } })
    await waitFor(() => expect(currentReads()).toBe(1))
    const { dialog, save } = await openRename()
    await userEvent.click(save)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(shown)
    expect(screen.getByRole('dialog', { name: 'Rename the workspace' })).toBeInTheDocument()
    await waitFor(() => expect({ current: currentReads(), list: reads('/me/workspaces') }).toStrictEqual({ current: 2, list: 1 }))
  })
})
