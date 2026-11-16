/**
 * The workspace gate: the picker, the not-found page, the one-workspace redirect, entering a workspace (the
 * store set before any page renders), the app as before workspaces for none or a failed list without a slug, and
 * the error page for a failed list on a workspace address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../test/TestRouter'
import { createTestQueryClient } from '../test/query-client'
import { stubLocationAssign } from '../test/location'
import type { PathWorkspace } from './workspacePath'

const page = vi.hoisted(() => {
  const state: { workspace: PathWorkspace } = { workspace: { kind: 'none' } }
  return state
})
const signOut = vi.hoisted(() => vi.fn<() => void>())
/** Whether the caller's token names a platform admin (the client's hint; the server live-checks every entry). */
const platform = vi.hoisted(() => ({ admin: false }))

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../hooks/useSignOut', () => ({ useSignOut: () => signOut }))
vi.mock('../store/authStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../store/authStore')>(),
  useIsPlatformAdmin: () => platform.admin,
}))
vi.mock('./workspacePath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspacePath')>()
  return { ...actual, get PAGE_WORKSPACE() { return page.workspace } }
})

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { setCurrentWorkspace, useCurrentWorkspace, workspaceHeader } from './currentWorkspace'
import WorkspaceGate from './WorkspaceGate'
import { platformEntryFor, rememberPlatformEntry } from './platformEntry'
import { rememberReturnWorkspace } from './returnWorkspace'
import { ACME, JUNIPER } from '../test/workspaceFixtures'
import { ApiError } from '../lib/errors'

/** Every workspace the page behind the gate rendered with, in order: its first is what its first API call sends. */
const rendered: string[] = []

function AppPage() {
  const current = useCurrentWorkspace()
  rendered.push(current?.name ?? 'none')
  return <p title={current?.role}>App page in {current?.name ?? 'no workspace'}</p>
}

function renderGate(initialPath = '/', client = createTestQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <TestRouter initialEntries={[initialPath]}>
        <WorkspaceGate><AppPage /></WorkspaceGate>
      </TestRouter>
    </QueryClientProvider>,
  )
}

function serve(workspaces: readonly object[], current: Record<string, () => unknown> = {}) {
  routeFetchApi({ 'GET /me/workspaces': () => ({ workspaces }), ...current })
}

/** The "could not load" page shows; Try again, with `routes` served then, opens the Field Team workspace. */
async function expectTryAgainOpens(routes: Record<string, () => unknown>): Promise<void> {
  expect(await screen.findByRole('heading', { name: 'Could not load your workspaces' })).toBeInTheDocument()
  serve([ACME], routes)
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('App page in Acme Outfitters Field Team')).toBeInTheDocument()
}

/** The gate at `/` with `routes` (the caller's list is Acme): the plain not-found shows, `/current` never asked. */
async function expectNotFoundUnasked(routes: Record<string, () => unknown> = {}): Promise<void> {
  const current = vi.fn(() => ({ workspace: { id: 'ws_01JCFLDT0000000000000000F9', slug: 'elsewhere', name: 'Elsewhere', role: 'admin' } }))
  serve([ACME], { ...routes, 'GET /me/workspaces/current': current })
  renderGate('/')
  expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
  expect(current).not.toHaveBeenCalled()
}

beforeEach(() => {
  resetFetchApi()
  rendered.length = 0
  page.workspace = { kind: 'none' }
  // setup.ts stubs localStorage: nothing stored unless a test says so.
  vi.mocked(window.localStorage.getItem).mockReturnValue(null)
  vi.mocked(window.localStorage.setItem).mockClear()
  window.sessionStorage.clear()
  platform.admin = false
})
afterEach(() => setCurrentWorkspace(null))

describe('WorkspaceGate without a slug', () => {
  it('opens the app as before workspaces for a caller with none', async () => {
    serve([])
    renderGate()
    expect(await screen.findByText('App page in no workspace')).toBeInTheDocument()
  })

  it('opens the app without a workspace, and warns, when the list cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    routeFetchApi({}, { missStatus: 500 })
    renderGate()
    expect(await screen.findByText('App page in no workspace')).toBeInTheDocument()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read your workspaces'), expect.any(Error))
  })

  it('moves a caller with one workspace into it with a full page load, keeping the path', async () => {
    const assign = stubLocationAssign('/projects/p1')
    serve([ACME])
    renderGate('/projects/p1?tab=docs')
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/workspace/acme/projects/p1?tab=docs'))
    expect(screen.queryByText(/App page/)).not.toBeInTheDocument()
  })

  it('takes GitHub\'s return into the flow\'s workspace in place of the address, never the picker', async () => {
    const path = '/agents/connections/github/installed?installation_id=7&setup_action=install&state=s'
    const assign = stubLocationAssign('/agents/connections/github/installed')
    const replace = vi.fn<(url: string) => void>()
    Object.assign(window.location, { replace })
    rememberReturnWorkspace('juniper')
    serve([ACME, JUNIPER])
    renderGate(path)
    await waitFor(() => expect(replace).toHaveBeenCalledExactlyOnceWith(`/workspace/juniper${path}`))
    expect([assign.mock.calls, screen.queryByRole('heading', { name: /Choose a workspace/i })]).toStrictEqual([[], null])
  })

  it('offers the picker for two, linking each to its own address and highlighting the last used', async () => {
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => (key === 'voc-last-workspace' ? 'juniper' : null))
    serve([ACME, JUNIPER])
    renderGate()
    const juniper = await screen.findByRole('link', { name: /Juniper Trail Co./ })
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeInTheDocument()
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toStrictEqual(['/workspace/acme/', '/workspace/juniper/'])
    expect(juniper).toHaveTextContent(/Juniper Trail Co..*Last used.*Editor/)
  })

  it('opens the path asked for inside the workspace chosen', async () => {
    serve([ACME, JUNIPER])
    renderGate('/dashboard?tab=x')
    expect(await screen.findByRole('link', { name: /Acme Outfitters/ })).toHaveAttribute('href', '/workspace/acme/dashboard?tab=x')
  })
})

describe('WorkspaceGate with a slug', () => {
  it('enters the workspace before the page renders, then takes the server\'s role', async () => {
    page.workspace = { kind: 'slug', slug: 'juniper' }
    // What the real client would send with /current, read when the call is made: the store must already hold
    // the workspace (getAuthHeaders builds X-Workspace-Id from workspaceHeader at that moment).
    const sent: Array<Record<string, string>> = []
    serve([ACME, JUNIPER], {
      'GET /me/workspaces/current': () => {
        sent.push(workspaceHeader('/api/me/workspaces/current'))
        return { workspace: { ...JUNIPER, role: 'admin', platform_admin: true } }
      },
    })
    renderGate('/dashboard')
    const appPage = await screen.findByText('App page in Juniper Trail Co.')
    // The list says editor; the server's answer (a platform admin entering) says admin, and wins.
    await waitFor(() => expect(appPage).toHaveAttribute('title', 'admin'))
    expect(sent).toStrictEqual([{ 'X-Workspace-Id': JUNIPER.id }])
    expect(rendered[0]).toBe('Juniper Trail Co.')
    expect(window.localStorage.setItem).toHaveBeenCalledWith('voc-last-workspace', 'juniper')
  })

  it('stays in the workspace when a later refresh of the list fails', async () => {
    page.workspace = { kind: 'slug', slug: 'juniper' }
    serve([ACME, JUNIPER], { 'GET /me/workspaces/current': () => ({ workspace: JUNIPER }) })
    const client = createTestQueryClient()
    renderGate('/dashboard', client)
    await screen.findByText('App page in Juniper Trail Co.')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    routeFetchApi({}, { missStatus: 500 })
    await act(() => client.refetchQueries({ queryKey: ['my-workspaces'], exact: true }))
    expect(client.getQueryState(['my-workspaces'])?.status).toBe('error')
    expect(screen.getByText('App page in Juniper Trail Co.')).toBeInTheDocument()
  })

  it('shows an error with Try again and Sign out, never the app, when the list cannot be read', async () => {
    page.workspace = { kind: 'slug', slug: 'acme' }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    routeFetchApi({}, { missStatus: 500 })
    renderGate('/dashboard')
    expect(await screen.findByRole('heading', { name: 'Could not load your workspaces' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    serve([ACME], { 'GET /me/workspaces/current': () => ({ workspace: ACME }) })
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('App page in Acme Outfitters')).toBeInTheDocument()
    expect(rendered).not.toContain('none')
  })

  it('keeps the list\'s role and warns when /current fails for another reason than 404', async () => {
    page.workspace = { kind: 'slug', slug: 'acme' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve([ACME], { 'GET /me/workspaces/current': () => { throw new Error('API Error: 500') } })
    renderGate()
    expect(await screen.findByText('App page in Acme Outfitters')).toHaveAttribute('title', 'admin')
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Could not confirm the current workspace', expect.any(Error)))
    expect(window.localStorage.setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['a slug that is not one of theirs', { kind: 'slug', slug: 'globex' } as const],
    ['an address no workspace can have', { kind: 'invalid' } as const],
  ])('shows not-found with the caller\'s own workspaces for %s', async (_label, workspace) => {
    page.workspace = workspace
    serve([ACME])
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Acme Outfitters/ })).toHaveAttribute('href', '/workspace/acme/')
    expect(screen.queryByText(/App page/)).not.toBeInTheDocument()
  })

  it('shows not-found, and remembers nothing, when the server no longer counts the caller a member (404 from /current)', async () => {
    page.workspace = { kind: 'slug', slug: 'acme' }
    serve([ACME, JUNIPER])
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    // The refused workspace is not offered again (its list row is stale); the others are.
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toStrictEqual(['/workspace/juniper/'])
    expect(screen.queryByRole('link', { name: /Acme Outfitters/ })).not.toBeInTheDocument()
    expect(window.localStorage.setItem).not.toHaveBeenCalled()
  })

  it('does not loop when the only listed workspace is refused: the start page opens the app without it', async () => {
    const assign = stubLocationAssign('/workspace/acme/')
    page.workspace = { kind: 'slug', slug: 'acme' }
    serve([ACME]) // /current is not routed: 404, as for a workspace being deleted
    const first = renderGate()
    expect(await screen.findByText('This workspace is not available.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/')
    first.unmount()
    // The start link: a full page load of `/`, which reads the list (still naming acme) again.
    page.workspace = { kind: 'none' }
    renderGate('/')
    expect(await screen.findByText('App page in no workspace')).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('leaves the workspace when the gate unmounts (an in-app move to /login)', async () => {
    page.workspace = { kind: 'slug', slug: 'acme' }
    serve([ACME], { 'GET /me/workspaces/current': () => ({ workspace: ACME }) })
    const { unmount } = renderGate()
    await screen.findByText('App page in Acme Outfitters')
    expect(workspaceHeader('/api/feedback')).toStrictEqual({ 'X-Workspace-Id': ACME.id })
    unmount()
    expect(workspaceHeader('/api/feedback')).toStrictEqual({})
  })

  it('offers the start page and sign-out to a caller with no workspace at all', async () => {
    page.workspace = { kind: 'slug', slug: 'acme' }
    serve([])
    renderGate()
    expect(await screen.findByText('You are not a member of any workspace yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(signOut).toHaveBeenCalledExactlyOnceWith()
  })
})

describe('WorkspaceGate for a platform admin entering from the console (a workspace outside their list)', () => {
  const FIELD_TEAM = { id: 'ws_01JCFLDT0000000000000000F1', slug: 'acme-field', name: 'Acme Outfitters Field Team' }

  it('opens it as the server answers it, sending the recorded id, and renders nothing before', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    rememberPlatformEntry(FIELD_TEAM)
    const sent: Array<Record<string, string>> = []
    serve([ACME], {
      'GET /me/workspaces/current': () => {
        sent.push(workspaceHeader('/api/me/workspaces/current'))
        return { workspace: { ...FIELD_TEAM, role: 'admin', platform_admin: true } }
      },
    })
    renderGate('/')
    expect(await screen.findByText('App page in Acme Outfitters Field Team')).toHaveAttribute('title', 'admin')
    expect(sent).toStrictEqual([{ 'X-Workspace-Id': FIELD_TEAM.id }])
    // Every render of the page already had the workspace confirmed.
    expect(rendered.every((name) => name === FIELD_TEAM.name)).toBe(true)
  })

  it('shows the plain not-found page, and drops the record, when the server answers 404', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    rememberPlatformEntry(FIELD_TEAM)
    serve([ACME]) // /current is not routed: the one 404 a non-member gets
    renderGate('/')
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Acme Outfitters/ })).toHaveAttribute('href', '/workspace/acme/')
    expect(platformEntryFor(FIELD_TEAM.slug)).toBeNull()
    expect(rendered).toStrictEqual([])
  })

  it('refuses an answer that names another workspace than the address', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    rememberPlatformEntry(FIELD_TEAM)
    serve([ACME], { 'GET /me/workspaces/current': () => ({ workspace: { ...FIELD_TEAM, slug: 'juniper', role: 'admin' } }) })
    renderGate('/')
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect(rendered).toStrictEqual([])
  })

  it('offers Try again, never the app, when the confirmation fails for another reason', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    rememberPlatformEntry(FIELD_TEAM)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve([ACME], { 'GET /me/workspaces/current': () => { throw new Error('API Error: 500') } })
    renderGate('/')
    await expectTryAgainOpens({ 'GET /me/workspaces/current': () => ({ workspace: { ...FIELD_TEAM, role: 'admin' } }) })
  })

  it('without a record, the slug is a plain not-found as for anyone', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    await expectNotFoundUnasked()
  })
})

describe('WorkspaceGate for a platform admin opening a workspace by a direct link (7.49.00)', () => {
  const FIELD_TEAM = { id: 'ws_01JCFLDT0000000000000000F1', slug: 'acme-field', name: 'Acme Outfitters Field Team' }
  const OTHER = { id: 'ws_01JCFLDT0000000000000000F2', slug: 'beta-labs', name: 'Beta Labs' }
  /** The console's list, two pages of the lookup's 100: the slug is on the second. */
  const consolePages = {
    'GET /platform/workspaces?limit=100': () => ({ workspaces: [{ ...OTHER, status: 'active', created_at: '' }], next_cursor: 'page-2' }),
    'GET /platform/workspaces?cursor=page-2&limit=100': () => ({ workspaces: [{ ...FIELD_TEAM, status: 'active', created_at: '' }], next_cursor: null }),
  }

  it('takes the console\'s entry: the id from its list, recorded, then the server\'s check of /current with it', async () => {
    platform.admin = true
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    const sent: Array<Record<string, string>> = []
    serve([ACME], {
      ...consolePages,
      'GET /me/workspaces/current': () => {
        sent.push(workspaceHeader('/api/me/workspaces/current'))
        return { workspace: { ...FIELD_TEAM, role: 'admin', platform_admin: true } }
      },
    })
    renderGate('/agents/connections')
    expect(await screen.findByText('App page in Acme Outfitters Field Team')).toHaveAttribute('title', 'admin')
    // The same request the console's Enter leads to: the server live-checks the platform admin and audits the entry.
    expect([sent, platformEntryFor(FIELD_TEAM.slug)]).toStrictEqual([[{ 'X-Workspace-Id': FIELD_TEAM.id }], { id: FIELD_TEAM.id, slug: FIELD_TEAM.slug }])
    expect(rendered.every((name) => name === FIELD_TEAM.name)).toBe(true)
  })

  it('is the plain not-found when the server refuses the entry (no longer a platform admin), and drops the record', async () => {
    platform.admin = true
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    serve([ACME], consolePages) // /current is not routed: the server's one 404
    renderGate('/')
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect([platformEntryFor(FIELD_TEAM.slug), rendered]).toStrictEqual([null, []])
  })

  it('is the plain not-found for a slug the console does not list', async () => {
    platform.admin = true
    page.workspace = { kind: 'slug', slug: 'nowhere' }
    await expectNotFoundUnasked(consolePages)
  })

  it('is the plain not-found when the console list refuses the caller (403: no longer a platform admin)', async () => {
    platform.admin = true
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    await expectNotFoundUnasked({ 'GET /platform/workspaces?limit=100': () => { throw new ApiError(403) } })
  })

  it('says it could not load, with Try again, when the console list fails otherwise, never not-found', async () => {
    platform.admin = true
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve([ACME], { 'GET /platform/workspaces?limit=100': () => { throw new ApiError(503) } })
    renderGate('/')
    await expectTryAgainOpens({ ...consolePages, 'GET /me/workspaces/current': () => ({ workspace: { ...FIELD_TEAM, role: 'admin', platform_admin: true } }) })
    expect(warn).toHaveBeenCalledWith('Could not look the workspace up in the platform console')
  })

  it('never asks the console\'s list for a caller who is no platform admin: the one not-found', async () => {
    page.workspace = { kind: 'slug', slug: FIELD_TEAM.slug }
    const list = vi.fn(consolePages['GET /platform/workspaces?limit=100'])
    const current = vi.fn(() => ({ workspace: { ...FIELD_TEAM, role: 'admin' } }))
    serve([ACME], { 'GET /platform/workspaces?limit=100': list, 'GET /me/workspaces/current': current })
    renderGate('/')
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect([list.mock.calls, current.mock.calls, platformEntryFor(FIELD_TEAM.slug)]).toStrictEqual([[], [], null])
  })
})
