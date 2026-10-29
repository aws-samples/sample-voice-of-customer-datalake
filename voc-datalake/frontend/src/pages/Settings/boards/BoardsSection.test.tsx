/**
 * @fileoverview Privacy & access → Boards: the company domains (moved here), the board list,
 * "New board" (templates, slug preview, 409 slug_taken) and `&board=<id>` opening the editor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { asRecord } from '../../../api/wireRecord'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { SALES_BOARD, boardRoutes, refusal } from './board-fixtures'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: BoardsSection } = await import('./BoardsSection')

function Search() {
  return <output data-testid="search">{useLocation().search}</output>
}

const renderSection = (entry = '/admin?tab=access&section=boards', client = createTestQueryClient()) => renderWithQueryClient(
  <TestRouter initialEntries={[entry]}><BoardsSection /><Search /></TestRouter>, client,
)

const calls = (method: string, path: string) =>
  fetchApi.mock.calls.filter(([url, options]) => url === path && (options?.method ?? 'GET') === method)

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  routeFetchApi(boardRoutes())
})

describe('the company domains card', () => {
  it('edits the company domains and saves only them', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ 'PUT /participants/settings': (body) => ({ settings: asRecord(body) }) }))
    renderSection()
    expect(await screen.findByRole('button', { name: 'Remove example.com' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Company email domains' }), 'acme.example{Enter}')
    await user.click(screen.getByRole('button', { name: 'Save domains' }))
    await waitFor(() => expect(calls('PUT', '/participants/settings')).toHaveLength(1))
    expect(JSON.parse(String(calls('PUT', '/participants/settings')[0]?.[1]?.body))).toStrictEqual({
      company_domains: ['example.com', 'acme.example'],
    })
  })

  it('is read-only for a non-admin', async () => {
    adminFlag.isAdmin = false
    renderSection()
    expect(await screen.findByRole('textbox', { name: 'Company email domains' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save domains' })).not.toBeInTheDocument()
  })
})

describe('the board list', () => {
  it('lists every board with its template, audience, request count and archived flag', async () => {
    renderSection()
    const list = within(await screen.findByRole('region', { name: 'Feedback boards' }))
    expect(await list.findByText('Sales feature requests · Company · 2 requests', { exact: false })).toBeInTheDocument()
    expect(list.getByText('Beta feedback · Specific people · 0 requests', { exact: false })).toBeInTheDocument()
    expect(list.getByText('Archived')).toBeInTheDocument()
  })

  it('opens the editor with &board=<id> (other params kept)', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(await screen.findByRole('button', { name: 'Edit Beta feedback' }))
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=access&section=boards&board=brd_00000001')
    expect(await screen.findByRole('button', { name: 'Back to boards' })).toBeInTheDocument()
  })

  it('opens the editor from a deep link and goes back to the list', async () => {
    const user = userEvent.setup()
    renderSection('/admin?tab=access&section=boards&board=brd_sales')
    expect(await screen.findByRole('heading', { name: 'Sales feature requests' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to boards' }))
    expect(screen.getByTestId('search')).toHaveTextContent(/^\?tab=access&section=boards$/)
  })
})

describe('New board', () => {
  it('offers the four templates with a line each and previews the slug', async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(await screen.findByRole('button', { name: 'New board' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New board' }))
    expect(dialog.getAllByRole('radio')).toHaveLength(4)
    expect(dialog.getByRole('radio', { name: /Sales feature requests/ })).toBeChecked()
    expect(dialog.getByText('Title and description only; add fields later.')).toBeInTheDocument()
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Support & Ops 2026')
    expect(dialog.getByText('Share link: /board/support-ops-2026')).toBeInTheDocument()
  })

  it('creates the board from the chosen template and opens it', async () => {
    const user = userEvent.setup()
    const created = { ...SALES_BOARD, board_id: 'brd_0000abcd', name: 'Support issues', template: 'service' }
    routeFetchApi(boardRoutes({
      'POST /feature-requests/boards': () => ({ board: created }),
      'GET /feature-requests/boards/brd_0000abcd': () => ({ board: created }),
    }))
    renderSection()
    await user.click(await screen.findByRole('button', { name: 'New board' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New board' }))
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Support issues')
    await user.click(dialog.getByRole('radio', { name: /Customer service issues/ }))
    await user.click(dialog.getByRole('button', { name: 'Create board' }))
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('board=brd_0000abcd'))
    expect(JSON.parse(String(calls('POST', '/feature-requests/boards')[0]?.[1]?.body))).toStrictEqual({
      name: 'Support issues', template: 'service', slug: 'support-issues',
    })
  })

  it('explains a slug another board already uses', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ 'POST /feature-requests/boards': refusal(409, 'slug_taken') }))
    renderSection()
    await user.click(await screen.findByRole('button', { name: 'New board' }))
    const dialog = within(screen.getByRole('dialog', { name: 'New board' }))
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Beta feedback')
    await user.click(dialog.getByRole('button', { name: 'Create board' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Another board already uses this link name.')
  })
})

describe('deleting a board from its editor', () => {
  it('goes back to the list and never asks for the deleted board again', async () => {
    const user = userEvent.setup()
    const BETA = '/feature-requests/boards/brd_00000001'
    routeFetchApi(boardRoutes({ [`DELETE ${BETA}`]: () => ({ success: true }) }))
    renderSection('/admin?tab=access&section=boards&board=brd_00000001')
    await user.click(await screen.findByRole('button', { name: 'Delete board' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^\?tab=access&section=boards$/))
    expect(await screen.findByRole('button', { name: 'Edit Sales feature requests' })).toBeInTheDocument()
    await waitFor(() => expect(calls('GET', '/feature-requests/boards').length).toBeGreaterThan(0))
    // The deleted board's own GET happened once, when the editor opened; nothing asked for it again.
    expect(calls('GET', BETA)).toHaveLength(1)
  })
})

describe('saving a board in its editor', () => {
  it('shows the saved audience in the list at once, before the list has refetched', async () => {
    const user = userEvent.setup()
    const listed = { calls: 0 }
    routeFetchApi(boardRoutes({
      // The first read answers; the refetch after the save never does (a slow network), so only the cache can tell.
      'GET /feature-requests/boards': () => {
        listed.calls += 1
        return listed.calls === 1 ? { boards: [SALES_BOARD] } : new Promise(() => undefined)
      },
      'PUT /feature-requests/boards/brd_sales': (body) => ({ board: { ...SALES_BOARD, ...asRecord(body) } }),
    }))
    // The app's cache keeps an unmounted list for minutes (queryPolicies `standard`), not the test default 0.
    renderSection(undefined, createTestQueryClient({ gcTime: 5 * 60_000 }))
    await user.click(await screen.findByRole('button', { name: 'Edit Sales feature requests' }))
    await user.click(await screen.findByRole('radio', { name: /Anyone/ }))
    await user.click(screen.getByRole('button', { name: 'Save board' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to boards' }))
    const list = within(await screen.findByRole('region', { name: 'Feedback boards' }))
    expect(list.getByText('Sales feature requests · Anyone · 2 requests', { exact: false })).toBeInTheDocument()
  })
})
