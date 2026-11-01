/**
 * `/feature-requests`: the feedback boards as cards (name, template, audience, request count, Copy
 * link with its toast, Open), the admin-only Edit / Pause / Archive (Restore / Delete once archived) / gear, and a pre-boards
 * `?request=<id>` link opening that request on its board.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { ApiError } from '../../lib/errors'
import { SearchProbe } from './search-probe-fixtures'
import { ADMIN, APP_USER, BOARD_USER, fakeBoard, fixtureBoard, fixtureRequest } from './feature-board-fixtures'
import type { BoardViewer, FeatureRequestsApi } from '../../api/featureRequestsApi'

const app: { api: FeatureRequestsApi | null } = vi.hoisted(() => ({ api: null }))
vi.mock('./boardContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('./boardContext')>()
  return { ...original, get APP_BOARD_HOST() { return { api: app.api, basePath: '/feature-requests', session: 'app' } } }
})
import Page from './FeatureRequests'

const SALES = fixtureBoard('sales', { board_id: 'brd_sales', slug: 'sales-feature-requests', name: 'Sales feature requests', request_count: 3 })
const SERVICE = fixtureBoard('service', {
  name: 'Customer service issues', request_count: 1,
  audience: { mode: 'list', domains: ['acme.example'], emails: ['pat.lee@example.org', 'kim@example.org'] },
})
const BETA = fixtureBoard('beta', { name: 'Beta feedback', audience: { mode: 'anyone', domains: undefined, emails: undefined } })

/** The page as `viewer` at `entry`; `arrange` adjusts the fake API before anything is fetched. */
function renderPage(viewer: BoardViewer, entry = '/feature-requests', arrange?: (api: FeatureRequestsApi) => void) {
  const board = fakeBoard(viewer, [fixtureRequest('fr_9', { board_id: 'brd_service' })], {}, { boards: [SALES, SERVICE, BETA] })
  arrange?.(board.api)
  app.api = board.api
  renderWithQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/feature-requests" element={<Page />} />
        <Route path="/feature-requests/:slug" element={<p>Board page</p>} />
      </Routes>
      <SearchProbe />
    </MemoryRouter>,
  )
  return board
}

const card = async (name: string) => within(await screen.findByTestId(`board-card-${name}`))

/** The boards listing answers every board archived (Delete is offered only then). */
function archivedBoards(api: FeatureRequestsApi): void {
  vi.mocked(api.listBoards).mockResolvedValue({
    boards: [SALES, SERVICE, BETA].map((entry) => ({ ...entry, archived: true })), viewer: ADMIN,
  })
}

beforeEach(() => {
  app.api = null
})

describe('the board cards', () => {
  it('shows each board with its template, audience in words and request count', async () => {
    renderPage(ADMIN)
    const sales = await card('brd_sales')
    expect(sales.getByRole('heading', { name: 'Sales feature requests' })).toBeInTheDocument()
    expect(sales.getByText('People at your company')).toBeInTheDocument()
    expect(sales.getByText('3')).toBeInTheDocument()
  })

  it('names a list audience by its counts for an admin (singular for one), and an open one in words', async () => {
    renderPage(ADMIN)
    const service = await card('brd_service')
    expect(service.getByText('Customer service issues', { selector: '.badge' })).toBeInTheDocument()
    expect(service.getByText('1 domain, 2 people')).toBeInTheDocument()
    expect((await card('brd_beta')).getByText('Anyone with a verified email')).toBeInTheDocument()
  })

  it('names a list audience in words when the API sends only its mode (non-admins)', async () => {
    renderPage(APP_USER, '/feature-requests', (api) => {
      vi.mocked(api.listBoards).mockResolvedValue({
        boards: [{ ...SERVICE, audience: { mode: 'list', domains: undefined, emails: undefined } }], viewer: APP_USER,
      })
    })
    expect((await card('brd_service')).getByText('Invited domains and people')).toBeInTheDocument()
  })

  it('copies the share link and says so in a toast', async () => {
    const user = userEvent.setup()
    renderPage(APP_USER)
    await user.click((await card('brd_service')).getByRole('button', { name: 'Copy link to Customer service issues' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('https://voc.example.com/board/service-board')
    expect(await screen.findByText('Link copied')).toBeInTheDocument()
  })

  it('opens a board on its own page', async () => {
    renderPage(APP_USER)
    expect((await card('brd_beta')).getByRole('link', { name: 'Open Beta feedback' })).toHaveAttribute('href', '/feature-requests/beta-board')
  })
})

describe('admin-only controls', () => {
  it('give an admin Edit (the board editor) and the gear to Boards', async () => {
    renderPage(ADMIN)
    const service = await card('brd_service')
    expect(service.getByRole('link', { name: 'Edit Customer service issues' }))
      .toHaveAttribute('href', '/admin?tab=access&section=boards&board=brd_service')
    expect(screen.getByRole('link', { name: 'Configure boards' })).toHaveAttribute('href', '/admin?tab=access&section=boards')
  })

  it('give an admin Pause and Archive on a board in use, but no Delete', async () => {
    renderPage(ADMIN)
    const service = await card('brd_service')
    expect(service.getByRole('button', { name: 'Pause Customer service issues' })).toBeInTheDocument()
    expect(service.getByRole('button', { name: 'Archive Customer service issues' })).toBeInTheDocument()
    expect(service.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument()
  })

  it('offers Restore and Delete only once a board is archived', async () => {
    renderPage(ADMIN, '/feature-requests', archivedBoards)
    const sales = await card('brd_sales')
    expect(sales.getByText('Archived')).toBeInTheDocument()
    expect(sales.getByRole('button', { name: 'Delete Sales feature requests' })).toBeInTheDocument()
    expect(sales.getByRole('button', { name: 'Restore Sales feature requests' })).toBeInTheDocument()
    expect(sales.queryByRole('button', { name: /^(Pause|Archive)/ })).not.toBeInTheDocument()
  })

  it.each([
    ['an app user', APP_USER],
    ['a board-pool user', BOARD_USER],
    ['a board-pool viewer the API calls admin', { ...BOARD_USER, is_admin: true }],
  ] as const)('are hidden from %s', async (_who, viewer) => {
    renderPage(viewer)
    const service = await card('brd_service')
    expect(service.queryByRole('link', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(service.queryByRole('button', { name: /^(Delete|Pause|Archive)/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Configure boards' })).not.toBeInTheDocument()
  })

  it('deletes a board with requests from its card after the name is typed, then refetches the boards', async () => {
    const user = userEvent.setup()
    const board = renderPage(ADMIN, '/feature-requests', archivedBoards)
    vi.mocked(board.api.deleteBoard)
      .mockResolvedValueOnce({ done: false, deleted: 2, remaining: 1 })
      .mockResolvedValueOnce({ done: true, deleted: 1, remaining: 0 })
    await user.click((await card('brd_sales')).getByRole('button', { name: 'Delete Sales feature requests' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled()
    await user.type(dialog.getByRole('textbox', { name: 'Type the board name to confirm' }), 'Sales feature requests')
    await user.click(dialog.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(vi.mocked(board.api.deleteBoard).mock.calls).toStrictEqual([['brd_sales', { withRequests: true }], ['brd_sales', { withRequests: true }]])
    await waitFor(() => expect(board.api.listBoards).toHaveBeenCalledTimes(2))
  })

  it('switches the card dialog to type-the-name when an empty-looking board has requests (409)', async () => {
    const user = userEvent.setup()
    const board = renderPage(ADMIN, '/feature-requests', archivedBoards)
    vi.mocked(board.api.deleteBoard).mockRejectedValueOnce(new ApiError(409, 'board_not_empty'))
    await user.click((await card('brd_beta')).getByRole('button', { name: 'Delete Beta feedback' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('textbox', { name: 'Type the board name to confirm' })).toBeInTheDocument()
    expect(board.api.deleteBoard).toHaveBeenCalledExactlyOnceWith('brd_beta')
  })

  it('links an admin with no boards yet to Administration → Boards', async () => {
    renderPage(ADMIN, '/feature-requests', (api) => {
      vi.mocked(api.listBoards).mockResolvedValue({ boards: [], viewer: ADMIN })
    })
    expect(await screen.findByRole('link', { name: 'Administration, Privacy & access, Boards' }))
      .toHaveAttribute('href', '/admin?tab=access&section=boards')
  })
})

describe('a pre-boards request link', () => {
  it('opens the request on its board', async () => {
    renderPage(APP_USER, '/feature-requests?request=fr_9')
    expect(await screen.findByText('Board page')).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_9')
  })

  it('reads a request without a board as the seeded board', async () => {
    renderPage(APP_USER, '/feature-requests?request=fr_9', (api) => {
      vi.mocked(api.getRequest).mockResolvedValue({ request: fixtureRequest('fr_9'), supports: [] })
    })
    expect(await screen.findByText('Board page')).toBeInTheDocument()
  })

  it('says the request no longer exists when it is gone', async () => {
    renderPage(APP_USER, '/feature-requests?request=fr_gone', (api) => {
      vi.mocked(api.getRequest).mockRejectedValue(new ApiError(404))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('This request no longer exists.')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Back to the boards' })).toHaveAttribute('href', '/feature-requests'))
  })
})
