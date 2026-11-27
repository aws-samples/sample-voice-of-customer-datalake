/**
 * The gate's Create a workspace (7.104.00): offered on the picker and on the page of a caller with no workspace yet, to
 * whoever the platform console is shown to (an administrator in `platform-admins`), never on the other gate pages; the
 * console's own form, its slug and name checked before sending, a taken slug said in words, and a create that opens
 * the new workspace with a full page load recorded for the gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'
import { stubLocationAssign } from '../test/location'
import { submitCreateWorkspace } from '../test/createWorkspaceForm'

/** The token's groups: `admins` and `platform-admins` (the client's hint; the server live-checks every create). */
const groups = vi.hoisted(() => ({ admin: true, platform: true }))

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../hooks/useSignOut', () => ({ useSignOut: () => () => {} }))
vi.mock('../store/authStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../store/authStore')>(),
  useIsAdmin: () => groups.admin,
  useIsPlatformAdmin: () => groups.platform,
}))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../lib/errors'
import { ACME, JUNIPER } from '../test/workspaceFixtures'
import { platformEntryFor } from './platformEntry'
import WorkspaceChoice, { WorkspaceUnavailable } from './WorkspaceChoice'

const OFFER = 'Create a workspace'
const FIELD = { id: 'ws_01JCFLDT0000000000000000F1', name: 'Field Team', slug: 'field', role: 'admin' }

/** The gate's pages WorkspaceChoice draws, as WorkspaceGate.tsx passes them. */
const PAGES = {
  picker: { workspaces: [ACME, JUNIPER], notFound: false, refused: false },
  none: { workspaces: [], notFound: true, refused: false },
  notAvailable: { workspaces: [], notFound: true, refused: true },
  notFound: { workspaces: [ACME], notFound: true, refused: false },
} as const

function renderChoice(page: keyof typeof PAGES = 'picker') {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <WorkspaceChoice path="/" {...PAGES[page]} />
    </QueryClientProvider>,
  )
}

/** Open the offer, then fill in and send the console's form. */
async function create(name: string, slug: string) {
  await userEvent.click(screen.getByRole('button', { name: OFFER }))
  await submitCreateWorkspace(name, slug)
}

beforeEach(() => {
  resetFetchApi()
  window.sessionStorage.clear()
  groups.admin = true
  groups.platform = true
})

describe('Create a workspace: who and where', () => {
  it.each([
    ['the picker', 'picker'],
    ['the page of a caller with no workspace yet', 'none'],
  ] as const)('is offered to a platform admin on %s, the console\'s form shown once asked for', async (_label, page) => {
    renderChoice(page)
    const offer = screen.getByRole('button', { name: OFFER })
    expect(offer).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(offer)
    expect(offer).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('form', { name: 'Create a workspace' })).toBeInTheDocument()
  })

  it.each([
    ['a workspace admin who is no platform admin', { admin: true, platform: false }],
    ['a platform-admins member outside admins (the console is not shown to them either)', { admin: false, platform: true }],
  ])('is not offered to %s', (_label, who) => {
    Object.assign(groups, who)
    renderChoice('picker')
    expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: OFFER })).not.toBeInTheDocument()
  })

  it.each([
    ['a workspace the server refused in this tab', 'notAvailable'],
    ['a not-found page that lists the caller\'s workspaces', 'notFound'],
  ] as const)('is not offered on %s', (_label, page) => {
    renderChoice(page)
    expect(screen.getByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: OFFER })).not.toBeInTheDocument()
  })

  it('is not offered on "could not load your workspaces"', () => {
    render(<WorkspaceUnavailable onRetry={() => {}} retrying={false} />)
    expect(screen.getByRole('heading', { name: 'Could not load your workspaces' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: OFFER })).not.toBeInTheDocument()
  })
})

describe('Create a workspace: the form', () => {
  it('creates the workspace and opens it with a full page load, recorded for the gate first', async () => {
    const assign = stubLocationAssign('/')
    const created = vi.fn<RouteHandler>(() => ({ workspace: FIELD }))
    routeFetchApi({ 'POST /platform/workspaces': created })
    renderChoice('picker')
    await create('  Field Team ', ' field ')
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/workspace/field/'))
    expect(created).toHaveBeenCalledExactlyOnceWith({ name: 'Field Team', slug: 'field' })
    // The caller's own list may not name it yet: the gate asks the server about this id (a member admin: let in).
    expect(platformEntryFor('field')).toStrictEqual({ id: FIELD.id, slug: 'field' })
  })

  it('says a taken slug (409) in words, keeps the draft and stays on the page', async () => {
    const assign = stubLocationAssign('/')
    routeFetchApi({ 'POST /platform/workspaces': () => { throw new ApiError(409, 'That slug is taken: choose another') } })
    renderChoice('none')
    await create('Acme again', 'acme')
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is taken: choose another slug.')
    expect(screen.getByLabelText('Address (slug)')).toHaveValue('acme')
    expect(assign).not.toHaveBeenCalled()
  })

  it('checks the slug by the server\'s rule before sending, focus on it and its error read', async () => {
    renderChoice('picker')
    await create('Field Team', 'Field Team')
    expect(screen.getByLabelText('Address (slug)')).toHaveFocus()
    expect(screen.getByLabelText('Address (slug)')).toHaveAccessibleDescription(/^Use 3 to 40 lowercase letters/)
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('checks the name before sending: a blank one is refused with its limit', async () => {
    renderChoice('picker')
    await create('   ', 'field')
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Enter a name of 1 to 80 characters.')
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
