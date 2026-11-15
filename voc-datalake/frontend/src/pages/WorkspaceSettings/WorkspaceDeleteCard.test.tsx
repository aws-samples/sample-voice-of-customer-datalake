/**
 * The workspace's delete: the card and its confirmation say it is permanent and what goes (the members' access and
 * their own assistant conversations and memories, which no export holds); Delete waits for the slug typed exactly, a
 * reason without personal data and "I understand"; the 202 ends in a last notice whose one button leaves with a full
 * page load to `/`, the workspace remembered as refused in this tab and its browser records forgotten; each refusal is
 * said in words, the dialog left open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { stubLocationAssign } from '../../test/location'
import { withMemoryLocalStorage } from '../../test/memoryLocalStorage'
import { createTestQueryClient } from '../../test/query-client'
import { ACME } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { refusedWorkspaceIds } from '../../workspace/refusedWorkspaces'
import WorkspaceDeleteCard from './WorkspaceDeleteCard'

const DELETE = '/me/workspaces/current/delete'
const REASON = 'Team closed, ticket #123'
const ACCEPTED = {
  delete: {
    job_id: ACME.id, workspace_id: ACME.id, status: 'waiting', phase: 'fence', requested_at: '2026-11-15T09:00:00Z',
    deleting_at: '2026-11-15T09:00:00Z', fence_at: '2026-11-15T09:21:00Z', progress_at: '2026-11-15T09:00:00Z', counts: {},
  },
}

const saved = withMemoryLocalStorage()

function renderCard(routes: Record<string, RouteHandler> = {}) {
  routeFetchApi(routes)
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      {/* The export card's place on the page, which "Go to Export" moves to. */}
      <section id="workspace-export" tabIndex={-1} aria-label="Export" />
      <WorkspaceDeleteCard workspace={ACME} />
    </QueryClientProvider>,
  )
}

async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: 'Delete workspace…' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete Acme Outfitters?' })
  return {
    dialog,
    slug: within(dialog).getByLabelText("Type the workspace's slug, acme, to confirm"),
    reason: within(dialog).getByRole('textbox', { name: 'Reason for deleting' }),
    understood: within(dialog).getByRole('checkbox', { name: 'I understand that deleting this workspace cannot be undone.' }),
    confirm: within(dialog).getByRole('button', { name: 'Delete workspace' }),
  }
}

/** Fill the dialog in full: the slug as typed, the reason, and the box ticked. */
async function fill(fields: Awaited<ReturnType<typeof openDialog>>, slug = 'acme') {
  await userEvent.type(fields.slug, slug)
  await userEvent.type(fields.reason, REASON)
  await userEvent.click(fields.understood)
}

/** Open the dialog, fill it in and press Delete; the request answers 202. */
async function deleteAcme() {
  const requested = vi.fn<RouteHandler>(() => ACCEPTED)
  renderCard({ [`POST ${DELETE}`]: requested })
  const fields = await openDialog()
  await fill(fields)
  await userEvent.click(fields.confirm)
  return { requested }
}

beforeEach(() => {
  resetFetchApi()
  window.sessionStorage.clear()
})

describe('WorkspaceDeleteCard', () => {
  it('says the delete is permanent, what it removes, and that the export holds no conversations or memories', () => {
    renderCard()
    const card = screen.getByRole('region', { name: 'Delete workspace' })
    expect(card).toHaveTextContent('Deleting this workspace is permanent and cannot be undone.')
    const items = within(card).getByRole('list', { name: 'Deleting it removes, for everyone:' })
    expect(within(items).getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual([
      'All its feedback and imports', 'Its projects, documents, prototypes and personas', 'Its agents and workflows',
      'Its settings, plugins and credentials', 'Its files', "All members' access to it",
      "Every member's assistant conversations and personal memories in this workspace", 'Its company memory',
    ])
    expect(within(card).getByRole('note')).toHaveTextContent("The export does not include members' assistant conversations or personal memories")
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('repeats it in the confirmation: permanent, and what it removes', async () => {
    renderCard()
    const { dialog } = await openDialog()
    expect(dialog).toHaveTextContent('This permanently deletes Acme Outfitters for every member. It cannot be undone.')
    expect(within(dialog).getByRole('list')).toHaveTextContent('assistant conversations and personal memories')
    expect(within(dialog).getByRole('note')).toHaveTextContent('The export does not include')
  })

  it('keeps Delete off until the slug is typed exactly, a reason given and "I understand" ticked', async () => {
    renderCard()
    const fields = await openDialog()
    await userEvent.type(fields.slug, 'acm')
    await userEvent.type(fields.reason, REASON)
    await userEvent.click(fields.understood)
    // The slug typed wrong: still off.
    expect(fields.confirm).toBeDisabled()
    await userEvent.type(fields.slug, 'e')
    expect(fields.confirm).toBeEnabled()
    await userEvent.click(fields.understood)
    expect(fields.confirm).toBeDisabled()
  })

  it('keeps Delete off for a reason that holds personal data, and says why', async () => {
    renderCard()
    const fields = await openDialog()
    await userEvent.type(fields.slug, 'acme')
    await userEvent.type(fields.reason, 'Asked by someone@example.com')
    await userEvent.click(fields.understood)
    expect(fields.confirm).toBeDisabled()
    expect(within(fields.dialog).getByRole('alert')).toHaveTextContent('Remove the email address or phone number')
  })

  it('sends the slug and the reason, then says the workspace is gone for everyone and its data goes in the background', async () => {
    stubLocationAssign('/w/acme/workspace-settings')
    const { requested } = await deleteAcme()
    const done = await screen.findByRole('dialog', { name: 'Acme Outfitters is being deleted' })
    expect(requested).toHaveBeenCalledExactlyOnceWith({ confirm_slug: 'acme', legal_basis: REASON })
    expect(done).toHaveTextContent('It is gone for every member now: nobody can open it any more.')
    expect(done).toHaveTextContent(/Its data is deleted in the background, starting at about .+ \(some 20 minutes from now\)\./)
    expect(screen.queryByRole('dialog', { name: 'Delete Acme Outfitters?' })).not.toBeInTheDocument()
  })

  it("forgets the workspace's browser records at once, and leaves with a full page load, refused in this tab", async () => {
    const assign = stubLocationAssign('/w/acme/workspace-settings')
    saved.set('voc-config:w/acme', '{}')
    saved.set('voc-config:w/juniper', '{}')
    await deleteAcme()
    const done = await screen.findByRole('dialog', { name: 'Acme Outfitters is being deleted' })
    // This browser's records of the workspace go at once (a tab closed now leaves none); the others' stay.
    expect({ acme: saved.has('voc-config:w/acme'), juniper: saved.has('voc-config:w/juniper'), left: assign.mock.calls.length })
      .toStrictEqual({ acme: false, juniper: true, left: 0 })
    await userEvent.click(within(done).getByRole('button', { name: 'Go to my workspaces' }))
    expect(assign).toHaveBeenCalledExactlyOnceWith('/')
    // The list still names it until the job removes its rows: the gate leaves it out in this tab.
    expect(refusedWorkspaceIds()).toStrictEqual([ACME.id])
  })

  it('says the background delete without a time when the answer does not give one', async () => {
    stubLocationAssign('/w/acme/workspace-settings')
    renderCard({ [`POST ${DELETE}`]: () => ({ delete: {} }) })
    const fields = await openDialog()
    await fill(fields)
    await userEvent.click(fields.confirm)
    expect(await screen.findByRole('dialog', { name: 'Acme Outfitters is being deleted' }))
      .toHaveTextContent('Its data is deleted in the background, starting about 20 minutes from now.')
  })

  it.each([
    [400, "Type the workspace's slug exactly to confirm the delete", "That is not this workspace's slug. Type it exactly to confirm the delete."],
    [409, 'An export of this workspace is running: wait for it to finish, then delete the workspace',
      'An export of this workspace is running. Wait for it to finish, then delete the workspace.'],
    [409, 'An erasure is running in this workspace: delete the workspace when it ends',
      'An erasure is running in this workspace. Delete the workspace when it ends.'],
    [403, 'Deleting a workspace is not available in this deployment', 'Deleting a workspace is not available in this deployment.'],
    [403, 'Workspace admin access required', "Only the workspace's admins can do that."],
    [400, 'legal_basis must be at most 300 characters', 'That did not work: legal_basis must be at most 300 characters'],
  ])('says a %i refusal in words and keeps the dialog open', async (status, reason, shown) => {
    const assign = stubLocationAssign('/w/acme/workspace-settings')
    renderCard({ [`POST ${DELETE}`]: () => { throw new ApiError(status, reason) } })
    const fields = await openDialog()
    await fill(fields)
    await userEvent.click(fields.confirm)
    expect(await within(fields.dialog).findByRole('alert')).toHaveTextContent(shown)
    expect(screen.getByRole('dialog', { name: 'Delete Acme Outfitters?' })).toBeInTheDocument()
    expect({ enabled: !fields.confirm.hasAttribute('disabled'), refused: refusedWorkspaceIds(), left: assign.mock.calls.length })
      .toStrictEqual({ enabled: true, refused: [], left: 0 })
  })

  it('closes the confirmation and moves to the export card from "Go to Export"', async () => {
    renderCard()
    const fields = await openDialog()
    await userEvent.click(within(fields.dialog).getByRole('button', { name: 'Go to Export' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Export' })).toHaveFocus())
  })
})
