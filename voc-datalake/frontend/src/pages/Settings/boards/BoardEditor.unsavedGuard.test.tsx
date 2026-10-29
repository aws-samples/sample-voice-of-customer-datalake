/**
 * @fileoverview BoardEditor under the shared unsaved-changes guard, in a DATA router
 * (`useBlocker` live): leaving with edits (Back to boards, which is a URL change) asks; the shared
 * Cancel contract holds even when another admin's save refetches the board while the dialog is
 * open; Discard leaves, Save saves and leaves. A clean editor leaves at once.
 * Plus: the Boards section is admin-only content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { asRecord } from '../../../api/wireRecord'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { SALES_BOARD, boardRoutes } from './board-fixtures'
import { boardAdminKeys } from './boardAdminQueries'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: BoardsSection } = await import('./BoardsSection')
const { default: AdminSectionContent } = await import('../AdminSectionContent')

const EDITOR_SEARCH = '?tab=access&section=boards&board=brd_sales'
const EDITOR = `/admin${EDITOR_SEARCH}`

function mountEditor(client = createTestQueryClient()) {
  const router = createMemoryRouter([{ path: '/admin', element: <BoardsSection /> }], { initialEntries: [EDITOR] })
  renderWithQueryClient(<RouterProvider router={router} />, client)
  return router
}

const description = () => screen.getByRole('textbox', { name: 'Description' })
const guardDialog = () => within(screen.getByRole('dialog', { name: 'Unsaved changes' }))
const puts = () => fetchApi.mock.calls.filter(([, options]) => options?.method === 'PUT')

async function editAndLeave() {
  const user = userEvent.setup()
  const router = mountEditor()
  await user.type(await screen.findByRole('textbox', { name: 'Description' }), 'Draft text')
  await user.click(screen.getByRole('button', { name: 'Back to boards' }))
  return { user, router }
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  routeFetchApi(boardRoutes({
    'PUT /feature-requests/boards/brd_sales': (body) => ({ board: { ...SALES_BOARD, ...asRecord(body), updated_at: '2026-10-27T00:00:00Z' } }),
  }))
})

describe('the board editor guard', () => {
  it('runs the shared Cancel contract while another admin\'s save refetches the board', async () => {
    const client = createTestQueryClient()
    const server = { board: SALES_BOARD }
    routeFetchApi(boardRoutes({ 'GET /feature-requests/boards/brd_sales': () => ({ board: server.board }) }))
    const state: { router?: ReturnType<typeof mountEditor> } = {}
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        state.router = mountEditor(client)
        await screen.findByRole('textbox', { name: 'Description' })
      },
      edit: async (user) => { await user.type(description(), 'Draft text') },
      expectDraft: () => expect(description()).toHaveDisplayValue('Draft text'),
      leave: async (user) => { await user.click(screen.getByRole('button', { name: 'Back to boards' })) },
      expectStayed: () => expect(state.router?.state.location.search).toBe(EDITOR_SEARCH),
      expectLeft: async () => {
        await waitFor(() => expect(state.router?.state.location.search).toBe('?tab=access&section=boards'))
      },
      whileDialogOpen: async () => {
        server.board = { ...SALES_BOARD, name: 'Renamed elsewhere', updated_at: '2026-10-28T00:00:00Z' }
        await client.invalidateQueries({ queryKey: boardAdminKeys.board('brd_sales') })
      },
    })
  })

  it('leaves a clean editor at once', async () => {
    const user = userEvent.setup()
    const router = mountEditor()
    await user.click(await screen.findByRole('button', { name: 'Back to boards' }))
    expect(router.state.location.search).toBe('?tab=access&section=boards')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Cancel keeps the draft and the editor open', async () => {
    const { user, router } = await editAndLeave()
    await user.click(guardDialog().getByRole('button', { name: 'Cancel' }))
    expect(router.state.location.search).toBe(EDITOR_SEARCH)
    expect(description()).toHaveDisplayValue('Draft text')
  })

  it('Discard leaves without saving', async () => {
    const { user, router } = await editAndLeave()
    await user.click(guardDialog().getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(router.state.location.search).toBe('?tab=access&section=boards'))
    expect(puts()).toHaveLength(0)
  })

  it('Save saves the draft, then leaves', async () => {
    const { user, router } = await editAndLeave()
    await user.click(guardDialog().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(router.state.location.search).toBe('?tab=access&section=boards'))
    expect(asRecord(JSON.parse(String(puts()[0]?.[1]?.body)))?.description).toBe('Draft text')
  })
})

describe('the Boards section', () => {
  it('renders nothing for a non-admin, even from a deep link', () => {
    const router = createMemoryRouter([{
      path: '/admin',
      element: <AdminSectionContent tab="access" section="boards" apiEndpoint="https://api.example.com" isAdmin={false} />,
    }], { initialEntries: [EDITOR] })
    const { container } = renderWithQueryClient(<RouterProvider router={router} />)
    expect(container).toBeEmptyDOMElement()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
