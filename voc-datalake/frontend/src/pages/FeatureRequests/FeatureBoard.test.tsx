/**
 * The shared feature-request board: the list and its controls, the new-request form, +1, the
 * deep-linked detail, and who sees the admin controls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../lib/errors'
import { ADMIN, APP_USER, BOARD_USER, fakeBoard, fixtureRequest, fixtureSupport, renderBoard } from './feature-board-fixtures'

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProjects: vi.fn(() => Promise.resolve({ projects: [{ project_id: 'proj_1', name: 'Identity roadmap' }] })),
    createProject: vi.fn(() => Promise.resolve({ success: true, project: { project_id: 'proj_new', name: 'SSO' } })),
  },
}))
import { projectsApi } from '../../api/projectsApi'

const SSO = fixtureRequest('fr_1', {
  title: 'Single sign-on', status: 'under_review', created_at: '2026-10-02T00:00:00Z',
  totals: { supporters: 2, customers: 2, committed_usd: 85000, at_risk_usd: 240000 },
})
const PDF = fixtureRequest('fr_2', {
  title: 'Export to PDF', status: 'planned', created_at: '2026-10-05T00:00:00Z',
  totals: { supporters: 1, customers: 1, committed_usd: 0, at_risk_usd: 0 },
})
const SSO_SUPPORTS = [
  fixtureSupport('sup_1', { is_reporter: true, impact: 'at_risk', amount_usd: 240000, deal: 'Acme renewal', contact_email: 'it-lead@acme.example' }),
  fixtureSupport('sup_2', { email: 'rui.costa@example.com', name: 'Rui Costa', customer: 'Example Air', amount_usd: 85000 }),
]

const titles = () => screen.getAllByRole('listitem').map((item) => within(item).queryByRole('button', { name: /Single sign-on|Export to PDF/ })?.textContent).filter(Boolean)

/** The board as an app user, with the "New request" dialog open. */
async function openNewRequest() {
  const user = userEvent.setup()
  const board = fakeBoard(APP_USER, [])
  renderBoard(board.api)
  await user.click(await screen.findByRole('button', { name: 'New request' }))
  return { user, board }
}

/** The SSO request open for an admin, and its promote panel. */
async function openPromotePanel() {
  const user = userEvent.setup()
  const board = fakeBoard(ADMIN, [SSO], { fr_1: SSO_SUPPORTS })
  renderBoard(board.api, '/feature-requests?request=fr_1')
  const panel = within(await screen.findByRole('region', { name: 'Promote to project' }))
  return { user, board, panel }
}

beforeEach(() => {
  vi.mocked(window.localStorage.getItem).mockReturnValue(null)
  vi.mocked(projectsApi.createProject).mockClear()
})

describe('the request list', () => {
  it('says a refused sign-in is not accepted, with no retry (a 403 cannot heal)', async () => {
    const board = fakeBoard(BOARD_USER, [])
    vi.mocked(board.api.listRequests).mockRejectedValue(new ApiError(403, 'Your email address is not verified'))
    renderBoard(board.api)
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted on the board/)
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('shows each request with its status, supporters and money in USD', async () => {
    renderBoard(fakeBoard(APP_USER, [SSO, PDF]).api)
    const card = (await screen.findByRole('button', { name: 'Single sign-on' })).closest('li')
    expect(card).not.toBeNull()
    const scope = within(card ?? document.body)
    expect(scope.getByText('Under review')).toBeInTheDocument()
    expect(scope.getByText('$85,000')).toBeInTheDocument()
    expect(scope.getByText('$240,000')).toBeInTheDocument()
  })

  it('sorts by revenue at risk and filters by status and search', async () => {
    const user = userEvent.setup()
    renderBoard(fakeBoard(APP_USER, [SSO, PDF]).api)
    await screen.findByRole('button', { name: 'Single sign-on' })
    expect(titles()).toStrictEqual(['Export to PDF', 'Single sign-on'])

    await user.selectOptions(screen.getByLabelText('Sort by'), 'at_risk')
    expect(titles()).toStrictEqual(['Single sign-on', 'Export to PDF'])

    await user.selectOptions(screen.getByLabelText('Status'), 'planned')
    expect(titles()).toStrictEqual(['Export to PDF'])

    await user.selectOptions(screen.getByLabelText('Status'), 'all')
    await user.type(screen.getByLabelText('Search'), 'sign-on')
    expect(titles()).toStrictEqual(['Single sign-on'])
  })
})

/** 5.34.00 live finding: a filtered or sorted board could not be shared — the controls were not in the URL. */
describe('the list controls in the URL', () => {
  it('writes search, status and sort into the URL, keeping the open request', async () => {
    const user = userEvent.setup()
    renderBoard(fakeBoard(APP_USER, [SSO, PDF]).api)
    await screen.findByRole('button', { name: 'Single sign-on' })
    await user.selectOptions(screen.getByLabelText('Sort by'), 'at_risk')
    await user.selectOptions(screen.getByLabelText('Status'), 'under_review')
    await user.type(screen.getByLabelText('Search'), 'sign')
    expect(new URLSearchParams(screen.getByTestId('search').textContent).toString()).toBe('sort=at_risk&status=under_review&q=sign')
  })

  it('opens a deep link with its filters applied, and drops a default from the URL', async () => {
    const user = userEvent.setup()
    renderBoard(fakeBoard(APP_USER, [SSO, PDF]).api, '/feature-requests?status=planned&sort=bogus')
    await screen.findByRole('button', { name: 'Export to PDF' })
    expect(titles()).toStrictEqual(['Export to PDF'])
    expect(screen.getByLabelText('Sort by')).toHaveValue('newest')
    await user.selectOptions(screen.getByLabelText('Status'), 'all')
    expect(screen.getByTestId('search')).not.toHaveTextContent('status=')
  })
})

describe('a new request', () => {
  it('names the missing fields and sends nothing until they are filled', async () => {
    const { user, board } = await openNewRequest()
    await user.click(screen.getByRole('button', { name: 'Add request' }))

    const shown = ['Give the request a title.', 'Describe what the customer needs.', 'What the customer needs, and why.',
      'Name the customer.', 'Enter the amount in US dollars.']
    expect(shown.filter((text) => screen.queryByText(text) === null)).toStrictEqual([])
    expect(board.api.createRequest).not.toHaveBeenCalled()
  })

  it('prefills the viewer name, sends whole dollars and opens the created request', async () => {
    const { user, board } = await openNewRequest()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Your name')).toHaveValue('Rui Costa')

    await user.type(within(dialog).getByLabelText('Title'), 'Audit log export')
    await user.type(within(dialog).getByLabelText('Description'), 'Download the audit log as CSV.')
    await user.type(within(dialog).getByLabelText('Customer (required)'), 'Example Air')
    await user.type(within(dialog).getByLabelText('Amount (USD)'), '$12,500')
    await user.click(within(dialog).getByRole('button', { name: 'Add request' }))

    expect(window.localStorage.setItem).toHaveBeenCalledWith('voc-board-name', 'Rui Costa')
    await waitFor(() => expect(board.api.createRequest).toHaveBeenCalledWith({
      title: 'Audit log export', description: 'Download the audit log as CSV.', name: 'Rui Costa', board: 'brd_sales',
      fields: { customer: 'Example Air', impact: 'committed', amount_usd: 12500 },
    }))
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_new'))
  })

  it('groups the typed amount as the locale writes it', async () => {
    const { user } = await openNewRequest()
    await user.type(screen.getByLabelText('Amount (USD)'), '$12500')
    expect(screen.getByLabelText('Amount (USD)')).toHaveValue('12,500')
    expect(screen.getByText('$12,500')).toBeInTheDocument()
  })

  it('remembers the name a board user typed for the next time', async () => {
    // The setup's localStorage is a stub: answer the remembered name for its key.
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => (key === 'voc-board-name' ? 'Sam Seller' : null))
    const user = userEvent.setup()
    renderBoard(fakeBoard(BOARD_USER, []).api, '/board', 'board')
    await user.click(await screen.findByRole('button', { name: 'New request' }))
    expect(screen.getByLabelText('Your name')).toHaveValue('Sam Seller')
  })
})

describe('the request detail', () => {
  it('opens from the ?request deep link with every support row', async () => {
    renderBoard(fakeBoard(APP_USER, [SSO], { fr_1: SSO_SUPPORTS }).api, '/feature-requests?request=fr_1')
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    expect(await within(dialog).findByText('Acme')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'rui.costa@example.com' })).toHaveAttribute('href', 'mailto:rui.costa@example.com')
    expect(within(dialog).getByText('Contact: it-lead@acme.example')).toBeInTheDocument()
  })

  it('keeps a space between the reporter\'s email and the Reporter badge', async () => {
    renderBoard(fakeBoard(APP_USER, [SSO], { fr_1: SSO_SUPPORTS }).api, '/feature-requests?request=fr_1')
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    const badge = await within(dialog).findByText('Reporter')
    expect(badge.parentElement?.textContent.endsWith('.com Reporter')).toBe(true)
  })

  it('copies the in-app share link of the request on its board', async () => {
    const user = userEvent.setup()
    renderBoard(fakeBoard(APP_USER, [SSO], { fr_1: SSO_SUPPORTS }).api, '/feature-requests?request=fr_1')
    await user.click(await screen.findByRole('button', { name: 'Copy link' }))
    // userEvent installs its own clipboard; read back what was written.
    await expect(navigator.clipboard.readText()).resolves.toBe(`${window.location.origin}/feature-requests/sales-feature-requests?request=fr_1`)
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument()
  })

  it('adds a +1 with my customer', async () => {
    const user = userEvent.setup()
    // Only the reporter supports it yet: Rui may add his +1.
    const board = fakeBoard(APP_USER, [SSO], { fr_1: SSO_SUPPORTS.slice(0, 1) })
    renderBoard(board.api, '/feature-requests?request=fr_1')
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    await user.click(await within(dialog).findByRole('button', { name: '+1 with my customer' }))
    const form = within(dialog).getByRole('form', { name: '+1 with my customer' })
    await user.type(within(form).getByLabelText('Customer (required)'), 'Globex Example')
    await user.selectOptions(within(form).getByLabelText('Revenue impact (required)'), 'none')
    await user.click(within(form).getByRole('button', { name: 'Add my +1' }))

    await waitFor(() => expect(board.api.addSupport).toHaveBeenCalledWith('fr_1', {
      name: 'Rui Costa', fields: { customer: 'Globex Example', impact: 'none', amount_usd: 0 },
    }))
  })

  it.each([
    ['a supporter', APP_USER, 'Example Air'],
    ['the reporter (their +1 is filed with the request)', { ...BOARD_USER, email: 'Dana.Lee@example.com' }, 'Acme'],
  ] as const)('offers %s "Edit my +1" instead of a second +1', async (_who, viewer, customer) => {
    const user = userEvent.setup()
    renderBoard(fakeBoard(viewer, [SSO], { fr_1: SSO_SUPPORTS }).api, '/x?request=fr_1', viewer.pool)
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    expect(await within(dialog).findByText('You support this request.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '+1 with my customer' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Edit my +1' }))
    expect(within(dialog).getByLabelText('Customer (required)')).toHaveValue(customer)
    expect(within(dialog).queryByRole('button', { name: 'Edit my +1' })).not.toBeInTheDocument()
  })

  it('lets a supporter change only their own support', async () => {
    renderBoard(fakeBoard(APP_USER, [SSO], { fr_1: SSO_SUPPORTS }).api, '/feature-requests?request=fr_1')
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    expect(await within(dialog).findByRole('button', { name: 'Edit the support for Example Air' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Edit the support for Acme' })).not.toBeInTheDocument()
  })

  it.each([
    ['an app user who is not an admin', APP_USER, 'app'],
    ['a board user', BOARD_USER, 'board'],
  ] as const)('hides the admin controls from %s', async (_who, viewer, session) => {
    renderBoard(fakeBoard(viewer, [SSO], { fr_1: SSO_SUPPORTS }).api, '/x?request=fr_1', session)
    const dialog = await screen.findByRole('dialog', { name: 'Single sign-on' })
    await within(dialog).findByText('Acme')
    expect(within(dialog).queryByRole('region', { name: 'Admin' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Delete request' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument()
  })

  it('lets an admin change the status', async () => {
    const user = userEvent.setup()
    const board = fakeBoard(ADMIN, [SSO], { fr_1: SSO_SUPPORTS })
    renderBoard(board.api, '/feature-requests?request=fr_1')
    const admin = await screen.findByRole('region', { name: 'Admin' })
    await user.selectOptions(within(admin).getByLabelText('Status'), 'shipped')
    await waitFor(() => expect(board.api.setStatus).toHaveBeenCalledWith('fr_1', 'shipped'))
  })

  it('closes a deleted request, clears its link and never asks for it again', async () => {
    const user = userEvent.setup()
    const board = fakeBoard(ADMIN, [SSO, fixtureRequest('fr_2')], { fr_1: SSO_SUPPORTS })
    renderBoard(board.api, '/feature-requests?request=fr_1')
    const admin = await screen.findByRole('region', { name: 'Admin' })
    await user.click(within(admin).getByRole('button', { name: 'Delete request' }))
    const reads = vi.mocked(board.api.getRequest).mock.calls.length
    const lists = vi.mocked(board.api.listRequests).mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(board.api.deleteRequest).toHaveBeenCalledWith('fr_1'))
    await waitFor(() => expect(vi.mocked(board.api.listRequests).mock.calls.length).toBeGreaterThan(lists))
    // The dialog is driven by `?request=`: an empty search means it closed (awaited: under load the URL
    // commit can render after the list refetch has started).
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement())
    expect(vi.mocked(board.api.getRequest).mock.calls.slice(reads)).toStrictEqual([])
  })
})

describe('promoting a request to a project', () => {
  it('promotes into an existing project and reports who was added and skipped', async () => {
    const { user, board, panel } = await openPromotePanel()
    await panel.findByRole('option', { name: 'Identity roadmap' })
    await user.selectOptions(panel.getByLabelText('Project'), 'proj_1')
    await user.click(panel.getByRole('button', { name: 'Promote' }))

    await waitFor(() => expect(board.api.promote).toHaveBeenCalledWith('fr_1', 'proj_1'))
    expect(await panel.findByText('2 people added to “Requests: Single sign-on”.')).toBeInTheDocument()
    expect(panel.getByText(/it-lead@acme\.example: outside the company domains/)).toBeInTheDocument()
    expect(projectsApi.createProject).not.toHaveBeenCalled()
  })

  it('creates a new project first when asked to', async () => {
    const { user, board, panel } = await openPromotePanel()
    await user.selectOptions(panel.getByLabelText('Project'), '__new__')
    expect(panel.getByLabelText('New project name')).toHaveValue('Single sign-on')
    await user.click(panel.getByRole('button', { name: 'Promote' }))

    await waitFor(() => expect(board.api.promote).toHaveBeenCalledWith('fr_1', 'proj_new'))
    expect(projectsApi.createProject).toHaveBeenCalledWith({ name: 'Single sign-on' })
  })
})
