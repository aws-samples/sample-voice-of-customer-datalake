/**
 * The platform console: every workspace (name, slug, status, secret), create with the server's slug rule checked
 * first and a taken slug said in words, Enter as a full page load that records the workspace for the gate, and a
 * 403 said as such.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { stubLocationAssign } from '../../test/location'
import { defined } from '../../test/defined'
import { PLATFORM_ACME as ACME } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { platformEntryFor } from '../../workspace/platformEntry'
import { myWorkspacesKey } from '../../api/workspacesApi'
import PlatformWorkspacesSection from './PlatformWorkspacesSection'
import { workspaceDraftProblems } from './workspaceDraft'

const JUNIPER = { ...ACME, id: 'ws_01JCJNPR0000000000000000J1', name: 'Juniper Trail Co.', slug: 'juniper', secret_status: 'pending' }

function renderSection(routes: Record<string, RouteHandler> = {}, client = createTestQueryClient()) {
  routeFetchApi({ 'GET /platform/workspaces': () => ({ workspaces: [ACME, JUNIPER], next_cursor: null }), ...routes })
  return render(<QueryClientProvider client={client}><PlatformWorkspacesSection /></QueryClientProvider>)
}

const FIELD = { id: 'ws_01JCFLDT0000000000000000F1', name: 'Field', slug: 'field', role: 'admin', secret_status: 'ready' }

/** Whether the caller's own list is marked to be read again after creating a workspace, given what it held. */
async function ownListReReadAfterCreate(mine: unknown[]): Promise<boolean> {
  const client = createTestQueryClient()
  // The test client collects unobserved queries at once, so the read is spied on rather than the cache's state.
  const getQueryData = vi.spyOn(client, 'getQueryData').mockImplementation(() => mine)
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  renderSection({ 'POST /platform/workspaces': () => ({ workspace: FIELD }) }, client)
  await create('Field', 'field')
  await screen.findByRole('status')
  getQueryData.mockRestore()
  return invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(myWorkspacesKey()))
}

const listItem = (name: string) => defined(screen.getAllByRole('listitem').find((item) => item.textContent.includes(name)), name)

async function create(name: string, slug: string) {
  await userEvent.type(screen.getByLabelText('Name'), name)
  await userEvent.type(screen.getByLabelText('Address (slug)'), slug)
  await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
}

beforeEach(() => {
  resetFetchApi()
  window.sessionStorage.clear()
})

describe('PlatformWorkspacesSection list', () => {
  it('lists every workspace with its address, status and secret', async () => {
    renderSection()
    expect(await screen.findByText('/w/acme/')).toBeInTheDocument()
    expect(within(listItem('Acme Outfitters')).getByText('Secret ready')).toBeInTheDocument()
    expect(within(listItem('Juniper Trail Co.')).getByText('Secret pending')).toBeInTheDocument()
    expect(within(listItem('Juniper Trail Co.')).getByText('Active')).toBeInTheDocument()
  })

  it('enters a workspace with a full page load, recording it for the gate first', async () => {
    const assign = stubLocationAssign('/admin')
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: 'Enter Juniper Trail Co.' }))
    expect(assign).toHaveBeenCalledExactlyOnceWith('/w/juniper/')
    expect(platformEntryFor('juniper')).toStrictEqual({ id: JUNIPER.id, slug: 'juniper' })
  })

  it('says so when the caller is no longer a platform admin', async () => {
    renderSection({ 'GET /platform/workspaces': () => { throw new ApiError(403, 'Platform admin access required') } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Only platform admins can do that.')
  })

  it('says so when a later page is refused because the caller is no longer a platform admin', async () => {
    renderSection({
      'GET /platform/workspaces': () => ({ workspaces: [ACME], next_cursor: 'k' }),
      'GET /platform/workspaces?cursor=k': () => { throw new ApiError(403, 'Platform admin access required') },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only platform admins can do that.')
  })

  it('offers no Enter for a slug that could not be an address', async () => {
    // The client's schema leaves such a row out, so the console never builds an address from one.
    renderSection({ 'GET /platform/workspaces': () => ({ workspaces: [ACME, { ...ACME, id: 'ws_x', name: 'Bad', slug: 'Bad Slug' }], next_cursor: null }) })
    expect(await screen.findByRole('button', { name: 'Enter Acme Outfitters' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enter Bad' })).not.toBeInTheDocument()
  })

  it('says there is none yet', async () => {
    renderSection({ 'GET /platform/workspaces': () => ({ workspaces: [], next_cursor: null }) })
    expect(await screen.findByText('No workspaces yet. Create the first one above.')).toBeInTheDocument()
  })
})

describe('PlatformWorkspacesSection create', () => {
  it("leaves a caller's empty list alone, so the gate does not reload the page and lose the result", async () => {
    expect(await ownListReReadAfterCreate([])).toBe(false)
    expect(screen.getByRole('button', { name: 'Enter Field' })).toBeInTheDocument()
  })

  it("re-reads the caller's own list when it already held a workspace", async () => {
    expect(await ownListReReadAfterCreate([ACME])).toBe(true)
  })

  it('creates a workspace and offers to enter it', async () => {
    const created = vi.fn<RouteHandler>(() => ({ workspace: { id: 'ws_01JCFLDT0000000000000000F1', name: 'Acme Outfitters Field Team', slug: 'acme-field', role: 'admin', secret_status: 'ready' } }))
    renderSection({ 'POST /platform/workspaces': created })
    await create('  Acme Outfitters Field Team ', ' acme-field ')
    expect(await screen.findByRole('status')).toHaveTextContent('Created Acme Outfitters Field Team. You are its admin.')
    expect(created).toHaveBeenCalledWith({ name: 'Acme Outfitters Field Team', slug: 'acme-field' })
    expect(screen.getByRole('button', { name: 'Enter Acme Outfitters Field Team' })).toBeInTheDocument()
  })

  it('says when the credentials secret is still pending', async () => {
    renderSection({ 'POST /platform/workspaces': () => ({ workspace: { id: 'ws_01JCFLDT0000000000000000F1', name: 'Field', slug: 'field', role: 'admin', secret_status: 'pending' } }) })
    await create('Field', 'field')
    expect(await screen.findByRole('status')).toHaveTextContent('Its credentials secret could not be created yet')
  })

  it('checks the slug by the server\'s rule before sending', async () => {
    renderSection()
    await create('Acme Outfitters Field Team', 'Acme Field')
    // Focus moves to the first invalid field, described by its error.
    expect(screen.getByLabelText('Address (slug)')).toHaveFocus()
    expect(screen.getByLabelText('Address (slug)')).toHaveAccessibleDescription(/^Use 3 to 40 lowercase letters/)
    expect(fetchApi).not.toHaveBeenCalledWith('/platform/workspaces', expect.objectContaining({ method: 'POST' }))
  })

  it('moves focus to the name first when both fields are wrong', async () => {
    renderSection()
    await create('   ', 'ab')
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })

  it('says a slug is taken (409) and keeps the draft', async () => {
    renderSection({ 'POST /platform/workspaces': () => { throw new ApiError(409, 'That slug is taken: choose another') } })
    await create('Acme again', 'acme')
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is taken: choose another slug.')
    expect(screen.getByLabelText('Address (slug)')).toHaveValue('acme')
  })
})

describe('workspaceDraftProblems', () => {
  it.each([
    ['Acme', 'acme', []],
    ['   ', 'acme', ['name']],
    ['x'.repeat(81), 'acme', ['name']],
    ['Acme', 'www', ['slug']],
    ['Acme', '-acme', ['slug']],
    ['', 'ab', ['name', 'slug']],
  ])('%j / %j → %j', (name, slug, problems) => {
    expect(workspaceDraftProblems(name, slug)).toStrictEqual(problems)
  })
})
