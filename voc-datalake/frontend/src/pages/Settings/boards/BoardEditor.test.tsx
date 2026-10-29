/**
 * @fileoverview The board editor: basics + share link, audience validation and the `anyone`
 * warning, field switches, status limits / reorder, the 409 explanations, archive / delete, and
 * read-only for a non-admin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { asRecord } from '../../../api/wireRecord'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { boardSchema } from '../../../api/featureBoardsSchema'
import { BETA_BOARD, SALES_BOARD, boardRoutes, refusal } from './board-fixtures'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: BoardEditor } = await import('./BoardEditor')

const onClose = vi.fn<() => void>()
const SALES_PATH = '/feature-requests/boards/brd_sales'
/** The Sales fixture's fields as the client reads them: every catalogue key of both levels. */
const STORED_FIELDS = boardSchema.parse(SALES_BOARD).fields

const renderEditor = (boardId = 'brd_sales') =>
  renderWithQueryClient(<TestRouter><BoardEditor boardId={boardId} onClose={onClose} /></TestRouter>)

const puts = () => fetchApi.mock.calls.filter(([, options]) => options?.method === 'PUT')
const lastPutBody = () => asRecord(JSON.parse(String(puts().at(-1)?.[1]?.body))) ?? {}
const saveButton = () => screen.getByRole('button', { name: 'Save board' })

/** A PUT that answers the stored board with the body applied (and a new updated_at). */
const echoPut = (base: object) => (body: unknown) => ({ board: { ...base, ...asRecord(body), updated_at: '2026-10-27T00:00:00Z' } })

beforeEach(() => {
  resetFetchApi()
  onClose.mockReset()
  adminFlag.isAdmin = true
  routeFetchApi(boardRoutes({ [`PUT ${SALES_PATH}`]: echoPut(SALES_BOARD) }))
})

describe('basics', () => {
  it('previews the share link of an edited slug and copies the saved one', async () => {
    const user = userEvent.setup()
    renderEditor()
    const slug = await screen.findByRole('textbox', { name: 'Link name' })
    await user.clear(slug)
    await user.type(slug, 'sales')
    expect(screen.getByText('https://voc.example.com/board/sales')).toBeInTheDocument()
    expect(screen.getByText('(after saving)')).toBeInTheDocument()
    // user-event installs its own clipboard; spy on that one.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith(SALES_BOARD.share_url)
    expect(await screen.findByText('Copied.')).toBeInTheDocument()
  })

  it('refuses to save an invalid slug or an empty name', async () => {
    const user = userEvent.setup()
    renderEditor()
    const slug = await screen.findByRole('textbox', { name: 'Link name' })
    await user.type(slug, '--')
    expect(slug).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText('The link name may use only lower-case letters, digits and single dashes.')).toBeInTheDocument()
  })

  it('saves the whole configuration and says Saved.', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.type(await screen.findByRole('textbox', { name: 'Description' }), 'For the sales team.')
    await user.click(saveButton())
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(lastPutBody()).toStrictEqual({
      name: 'Sales feature requests', slug: 'sales-feature-requests', description: 'For the sales team.',
      fields: STORED_FIELDS, statuses: SALES_BOARD.statuses, audience: { mode: 'company', domains: [], emails: [] },
    })
  })
})

describe('audience', () => {
  it('says which company domains a company board uses', async () => {
    renderEditor()
    expect(await screen.findByText('Uses the company domains: example.com.')).toBeInTheDocument()
  })

  it('needs a list audience to name a domain or an address, and refuses invalid addresses', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('radio', { name: /Specific people/ }))
    expect(screen.getByText('Add at least one allowed domain or email address.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Allowed email addresses' }), 'Pat@Acme.example{Enter}not-an-email')
    expect(screen.getByText('Not valid email addresses: not-an-email')).toBeInTheDocument()
    expect(screen.getByText('1 address (at most 500).')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('saves a list audience with its addresses lower-cased', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('radio', { name: /Specific people/ }))
    await user.type(screen.getByRole('textbox', { name: 'Allowed email addresses' }), 'Pat@Acme.example')
    await user.click(saveButton())
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(lastPutBody().audience).toStrictEqual({ mode: 'list', domains: [], emails: ['pat@acme.example'] })
  })

  it('warns plainly that anyone can sign in and post, with the daily limits', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('radio', { name: /Anyone/ }))
    expect(screen.getByRole('note')).toHaveTextContent('Any email address can sign in and post on this board.')
    expect(screen.getByRole('note')).toHaveTextContent('20 requests and 100 +1s a day')
  })
})

describe('fields', () => {
  it('switches a catalogue field on and off; Required needs the field on', async () => {
    const user = userEvent.setup()
    renderEditor()
    const request = within(await screen.findByRole('group', { name: 'On a new request' }))
    const severity = request.getByRole('switch', { name: 'Severity' })
    const severityRequired = request.getByRole('checkbox', { name: 'Severity required' })
    expect(severity).not.toBeChecked()
    expect(severityRequired).toBeDisabled()
    await user.click(severity)
    await user.click(severityRequired)
    const support = within(screen.getByRole('group', { name: 'On a +1' }))
    await user.click(support.getByRole('switch', { name: 'Customer' }))
    await user.click(saveButton())
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(lastPutBody().fields).toStrictEqual({
      request: { ...STORED_FIELDS.request, severity: { enabled: true, required: true } },
      support: { ...STORED_FIELDS.support, customer: { enabled: false, required: false } },
    })
  })
})

describe('statuses', () => {
  it('marks the first status as initial and reorders, renames and removes', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(await screen.findByRole('button', { name: 'Move Planned up' }))
    expect(screen.getByRole('button', { name: 'Move Planned up' })).toBeDisabled()
    const first = screen.getByRole('textbox', { name: 'Status 1 name' })
    expect(first).toHaveDisplayValue('Planned')
    await user.clear(first)
    await user.type(first, 'Next up')
    await user.click(screen.getByRole('button', { name: 'Remove Shipped' }))
    await user.click(saveButton())
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(lastPutBody().statuses).toStrictEqual([{ key: 'planned', label: 'Next up' }, { key: 'new', label: 'New' }])
  })

  it('adds statuses up to eight, with keys from their labels', async () => {
    const user = userEvent.setup()
    renderEditor()
    const add = await screen.findByRole('textbox', { name: 'New status' })
    for (const label of ['In progress', 'Blocked', 'Done', 'Later', 'Archived']) await user.type(add, `${label}{Enter}`)
    expect(screen.getByText('in_progress')).toBeInTheDocument()
    expect(screen.getByText('A board has at most 8 statuses.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add status' })).toBeDisabled()
  })

  it('explains a removed status that requests still use (409 status_in_use)', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ [`PUT ${SALES_PATH}`]: refusal(409, 'status_in_use') }))
    renderEditor()
    await user.click(await screen.findByRole('button', { name: 'Remove Planned' }))
    await user.click(saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('A status you removed is still used by requests on this board.')
    expect(screen.getByRole('button', { name: 'Remove Shipped' })).toBeInTheDocument()
  })

  it('explains a link name another board took meanwhile (409 slug_taken)', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ [`PUT ${SALES_PATH}`]: refusal(409, 'slug_taken') }))
    renderEditor()
    await user.type(await screen.findByRole('textbox', { name: 'Link name' }), '-x')
    await user.click(saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Another board already uses this link name.')
  })
})

describe('archive and delete', () => {
  it('waits for a saved draft before archiving', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.type(await screen.findByRole('textbox', { name: 'Description' }), 'x')
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    expect(screen.getByText(/Save or discard your changes first\./)).toBeInTheDocument()
  })

  it('archives a board and restores an archived one', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ 'PUT /feature-requests/boards/brd_00000001': echoPut(BETA_BOARD) }))
    renderEditor('brd_00000001')
    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(lastPutBody()).toStrictEqual({ archived: false }))
    expect(await screen.findByRole('button', { name: 'Archive' })).toBeInTheDocument()
  })

  it('says deleting removes the board and its requests', async () => {
    renderEditor()
    expect(await screen.findByText(/deleting removes the board and its requests\./)).toBeInTheDocument()
    expect(screen.queryByText(/only an empty board/i)).not.toBeInTheDocument()
  })

  it('deletes a board with its requests once its name is typed, and leaves the editor', async () => {
    const user = userEvent.setup()
    const steps = [{ success: true, done: false, deleted: 1, remaining: 1 }, { success: true, done: true, deleted: 1, remaining: 0 }]
    routeFetchApi(boardRoutes({ [`DELETE ${SALES_PATH}?with_requests=true`]: () => steps.shift() }))
    renderEditor()
    await user.click(await screen.findByRole('button', { name: 'Delete board' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/its 2 requests and every \+1 on them are deleted permanently/)).toBeInTheDocument()
    await user.type(dialog.getByRole('textbox', { name: 'Type the board name to confirm' }), 'Sales feature requests')
    await user.click(dialog.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(fetchApi.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(2)
  })

  it('deletes an empty board and leaves the editor', async () => {
    const user = userEvent.setup()
    routeFetchApi(boardRoutes({ 'DELETE /feature-requests/boards/brd_00000001': () => ({ success: true }) }))
    renderEditor('brd_00000001')
    await user.click(await screen.findByRole('button', { name: 'Delete board' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})

describe('a non-admin', () => {
  it('sees the configuration read-only, with no save, archive or delete', async () => {
    adminFlag.isAdmin = false
    renderEditor()
    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save board' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete board' })).not.toBeInTheDocument()
  })
})
