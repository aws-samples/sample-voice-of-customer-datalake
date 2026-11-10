/**
 * One board driven by its template: the new-request form shows only the board's enabled fields with
 * their required marks and validation, statuses come from the board (badges, filter, admin select,
 * an admin's renamed status), and totals are the template's figures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ADMIN, APP_USER, fakeBoard, fixtureBoard, fixtureRequest, renderBoard } from './feature-board-fixtures'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import type { FeatureRequest } from '../../api/featureRequestsApi'

const SERVICE = fixtureBoard('service', { name: 'Customer service issues' })
const BETA = fixtureBoard('beta', { name: 'Beta feedback' })

const REFUND = fixtureRequest('fr_s1', {
  title: 'Refund email never arrives', status: 'confirmed', board_id: SERVICE.board_id,
  fields: { kind: 'bug', severity: 'high', reference: 'BK-10442', affected_count: 12 },
  totals: { supporters: 2, affected: 13 },
})
const CHECKOUT = fixtureRequest('fr_b1', {
  title: 'Promo code field is hidden', board_id: BETA.board_id,
  fields: { area: 'Checkout', outcome: 'confusing', rating: 3, link: 'https://beta.example.com/checkout' },
  totals: { supporters: 1, avg_rating: 3 },
})

function show(board: FeatureBoard, requests: FeatureRequest[], viewer = APP_USER, entry = `/feature-requests/${board.slug}`) {
  const fake = fakeBoard(viewer, requests, {}, { board })
  renderBoard(fake.api, entry, 'app', board.slug)
  return fake
}

async function openNewRequest(board: FeatureBoard) {
  const user = userEvent.setup()
  const fake = show(board, [])
  await user.click(await screen.findByRole('button', { name: 'New request' }))
  return { user, fake, dialog: within(screen.getByRole('dialog')) }
}

beforeEach(() => {
  vi.mocked(window.localStorage.getItem).mockReturnValue(null)
})

describe('a service board', () => {
  it('asks only for its own fields, saying which are required', async () => {
    const { dialog } = await openNewRequest(SERVICE)
    expect(dialog.getByLabelText('Type (required)')).toBeInTheDocument()
    expect(dialog.getByLabelText('Severity (required)')).toBeInTheDocument()
    expect(dialog.getByLabelText('People affected (optional)')).toBeInTheDocument()
    expect(dialog.queryByLabelText(/^Customer/)).not.toBeInTheDocument()
  })

  it('refuses to send until the required fields are filled', async () => {
    const { user, fake, dialog } = await openNewRequest(SERVICE)
    await user.type(dialog.getByLabelText('Title'), 'Invoice PDF is blank')
    await user.type(dialog.getByLabelText('Description'), 'The emailed invoice opens empty.')
    await user.type(dialog.getByLabelText('People affected (optional)'), '0')
    await user.click(dialog.getByRole('button', { name: 'Add request' }))
    expect(dialog.getAllByText('This field is required.')).toHaveLength(2)
    expect(dialog.getByText('That number is outside the allowed range.')).toBeInTheDocument()
    expect(fake.api.createRequest).not.toHaveBeenCalled()
  })

  it('requires a description in its own words, with a hint about what happened', async () => {
    const { user, fake, dialog } = await openNewRequest(SERVICE)
    expect(dialog.getByText('What happened, and what the customer saw.')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Add request' }))
    expect(dialog.getByText('Describe what happened and what the customer saw.')).toBeInTheDocument()
    expect(dialog.queryByText('Describe what the customer needs.')).not.toBeInTheDocument()
    expect(fake.api.createRequest).not.toHaveBeenCalled()
  })

  it('sends the board and its field values', async () => {
    const { user, fake, dialog } = await openNewRequest(SERVICE)
    await user.type(dialog.getByLabelText('Title'), 'Invoice PDF is blank')
    await user.type(dialog.getByLabelText('Description'), 'The emailed invoice opens empty.')
    await user.selectOptions(dialog.getByLabelText('Type (required)'), 'bug')
    await user.selectOptions(dialog.getByLabelText('Severity (required)'), 'medium')
    await user.type(dialog.getByLabelText('People affected (optional)'), '4')
    await user.click(dialog.getByRole('button', { name: 'Add request' }))
    await waitFor(() => expect(fake.api.createRequest).toHaveBeenCalledWith({
      title: 'Invoice PDF is blank', description: 'The emailed invoice opens empty.', name: 'Rui Costa', board: SERVICE.board_id,
      fields: { kind: 'bug', severity: 'medium', affected_count: 4 },
    }))
  })

  it('shows its statuses, field values and people affected', async () => {
    show(SERVICE, [REFUND])
    const card = within(await screen.findByTestId('fr-card-fr_s1'))
    expect(card.getByTestId('fr-status-badge')).toHaveTextContent('Confirmed')
    expect(card.getByText('Bug')).toBeInTheDocument()
    expect(card.getByText('People affected').nextSibling).toHaveTextContent('13')
    const filter = screen.getByLabelText('Status')
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['All statuses', 'New', 'Confirmed', 'Fixed', "Won't fix"])
  })

  it('lets an admin move a request to one of the board statuses', async () => {
    const user = userEvent.setup()
    const fake = show(SERVICE, [REFUND], ADMIN, `/feature-requests/${SERVICE.slug}?request=fr_s1`)
    const admin = within(await screen.findByRole('region', { name: 'Admin' }))
    await user.selectOptions(admin.getByLabelText('Status'), 'wont_fix')
    await waitFor(() => expect(fake.api.setStatus).toHaveBeenCalledWith('fr_s1', 'wont_fix'))
  })

  it('says "I am affected too" for a +1, with only a note to add', async () => {
    const user = userEvent.setup()
    const fake = show(SERVICE, [REFUND], APP_USER, `/feature-requests/${SERVICE.slug}?request=fr_s1`)
    const dialog = within(await screen.findByRole('dialog', { name: 'Refund email never arrives' }))
    await user.click(await dialog.findByRole('button', { name: 'I am affected too' }))
    const form = within(dialog.getByRole('form', { name: 'I am affected too' }))
    expect(form.queryByLabelText(/^Customer/)).not.toBeInTheDocument()
    await user.type(form.getByLabelText('Note (optional)'), 'Two more calls today')
    await user.click(form.getByRole('button', { name: 'Add my +1' }))
    await waitFor(() => expect(fake.api.addSupport).toHaveBeenCalledWith('fr_s1', { name: 'Rui Costa', fields: { note: 'Two more calls today' } }))
  })
})

describe('a beta board', () => {
  it('shows the rating, its average and an https link as a safe link', async () => {
    show(BETA, [CHECKOUT], APP_USER, `/feature-requests/${BETA.slug}?request=fr_b1`)
    const dialog = within(await screen.findByRole('dialog', { name: 'Promo code field is hidden' }))
    const link = await dialog.findByRole('link', { name: 'https://beta.example.com/checkout' })
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    expect(dialog.getByText('Average rating').nextSibling).toHaveTextContent('3 / 5')
    expect(screen.getByRole('region', { name: 'Board totals' })).toHaveTextContent('3 / 5')
  })

  it('shows a link that is not https as plain text', async () => {
    show(BETA, [{ ...CHECKOUT, fields: { ...CHECKOUT.fields, link: 'javascript:alert(1)' } }], APP_USER, `/feature-requests/${BETA.slug}?request=fr_b1`)
    const dialog = within(await screen.findByRole('dialog', { name: 'Promo code field is hidden' }))
    expect(await dialog.findByText('javascript:alert(1)')).toBeInTheDocument()
    expect(dialog.queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument()
  })

  it('takes feedback without a description (optional on beta and blank boards)', async () => {
    const { user, fake, dialog } = await openNewRequest(BETA)
    expect(dialog.getByText('What you tried, and what happened.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Description (optional)')).toHaveValue('')
    await user.type(dialog.getByLabelText('Title'), 'Seat map is slow')
    await user.type(dialog.getByLabelText('Area (required)'), 'Seat map')
    await user.selectOptions(dialog.getByLabelText('What happened (required)'), 'broken')
    await user.click(dialog.getByRole('button', { name: 'Add request' }))
    await waitFor(() => expect(fake.api.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Seat map is slow', description: '', board: BETA.board_id,
    })))
  })

  it('names the neutral hint on a blank board', async () => {
    const { dialog } = await openNewRequest(fixtureBoard('blank', { name: 'Ideas' }))
    expect(dialog.getByLabelText('Description (optional)')).toBeInTheDocument()
    expect(dialog.getByText('Anything that helps others understand it.')).toBeInTheDocument()
  })

  it('offers the rating as a choice of 1 to 5', async () => {
    const { dialog } = await openNewRequest(BETA)
    const rating = dialog.getByLabelText('Rating (1-5) (optional)')
    expect(within(rating).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['Not set', '1', '2', '3', '4', '5'])
    expect(dialog.getByLabelText('Area (required)')).toBeInTheDocument()
  })
})

describe('board statuses', () => {
  it("shows an admin's renamed status in their words, and an unknown one as the initial status", async () => {
    const renamed = fixtureBoard('blank', { statuses: [{ key: 'new', label: 'Inbox' }, { key: 'done', label: 'Shipped it' }] })
    show(renamed, [fixtureRequest('fr_1', { status: 'done' }), fixtureRequest('fr_2', { status: 'archived' })])
    expect(within(await screen.findByTestId('fr-card-fr_1')).getByTestId('fr-status-badge')).toHaveTextContent('Shipped it')
    expect(within(screen.getByTestId('fr-card-fr_2')).getByTestId('fr-status-badge')).toHaveTextContent('Inbox')
  })

  it('drops a status filter the board does not have', async () => {
    show(SERVICE, [REFUND], APP_USER, `/feature-requests/${SERVICE.slug}?status=planned`)
    expect(await screen.findByTestId('fr-card-fr_s1')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toHaveValue('all')
  })
})
