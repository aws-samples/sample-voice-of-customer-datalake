/**
 * @fileoverview Participants page: deep-linked tabs, list cards with admin-only delete, a list's
 * members with add / remove and the AI-assistant draft, the people table and person modal with
 * erasure, the asks list and its recipients.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { asRecord } from '../../api/wireRecord'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ANA, LIST_STAFF, participantRoutes } from './participants-fixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
const openAssistant = vi.fn()
vi.mock('../../assistant/store/openAssistant', () => ({ openAssistant: (...args: unknown[]) => { openAssistant(...args) } }))

const { default: Participants } = await import('./Participants')

function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>
}

function renderPage(entry = '/participants') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Participants />
      <SearchProbe />
    </TestRouter>,
  )
}

/** The first list card's Open button. */
async function firstOpenButton(): Promise<HTMLElement> {
  const [first] = await screen.findAllByRole('button', { name: /^open$/i })
  if (first === undefined) throw new Error('no list card')
  return first
}

/** The calls made with `method` to `endpoint`, as parsed bodies. */
function bodiesOf(method: string, endpoint: string): unknown[] {
  return fetchApi.mock.calls
    .filter(([path, options]) => path === endpoint && (options?.method ?? 'GET') === method)
    .map(([, options]): unknown => (typeof options?.body === 'string' ? JSON.parse(options.body) : undefined))
}

const ERASE_ANA = 'DELETE /participants/people/per_ana'

/** Every call (`METHOD path`, query stripped) made after the first `marker` call. */
function callsAfter(marker: string): string[] {
  const log = fetchApi.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path.split('?')[0] ?? ''}`)
  return log.slice(log.indexOf(marker) + 1)
}

/** The People tab with Ana's dialog open and her erasure answered by the API. */
async function openErasableAna() {
  const user = userEvent.setup()
  routeFetchApi(participantRoutes({ [ERASE_ANA]: () => ({ success: true }) }), { ignoreQuery: true })
  renderPage('/participants?tab=people')
  await user.click(await screen.findByRole('button', { name: ANA.email }))
  return { user, dialog: await screen.findByRole('dialog') }
}

beforeEach(() => {
  resetFetchApi()
  openAssistant.mockReset()
  adminFlag.isAdmin = true
  routeFetchApi(participantRoutes(), { ignoreQuery: true })
})

describe('Participants page', () => {
  it('opens on Lists and deep-links the other tabs', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.getByRole('tab', { name: /lists/i })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Example Air employees')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /people/i }))
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=people')
  })

  it('shows the asks tab straight from ?tab=asks', async () => {
    renderPage('/participants?tab=asks')
    expect(await screen.findByText('Tell us about the booking flow')).toBeInTheDocument()
    expect(screen.getByText(/1 sent · 1 failed · 1 skipped · 1 responded, of 3/)).toBeInTheDocument()
  })

  it('shows each list with its kind and member count', async () => {
    renderPage()
    const card = (await screen.findByText('Example Air employees')).closest('li')
    expect(card).not.toBeNull()
    const scope = within(card ?? document.body)
    expect(scope.getByText('Employees')).toBeInTheDocument()
    expect(scope.getByText('2 members')).toBeInTheDocument()
  })

  it('offers delete to admins only', async () => {
    adminFlag.isAdmin = false
    renderPage()
    await screen.findByText('Example Air employees')
    expect(screen.queryByRole('button', { name: /delete example air employees/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit example air employees/i })).toBeInTheDocument()
  })

  it('deletes a list after the confirmation that says its people stay', async () => {
    const user = userEvent.setup()
    routeFetchApi(participantRoutes({ 'DELETE /participants/lists/lst_staff': () => ({ success: true }) }), { ignoreQuery: true })
    renderPage()
    await user.click(await screen.findByRole('button', { name: /delete example air employees/i }))
    expect(screen.getByText(/the people on it are kept/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(bodiesOf('DELETE', '/participants/lists/lst_staff')).toHaveLength(1))
  })

  it('creates a list with its name and kind', async () => {
    const user = userEvent.setup()
    routeFetchApi(participantRoutes({ 'POST /participants/lists': (body) => ({ list: { ...LIST_STAFF, list_id: 'lst_new', ...asRecord(body) } }) }), { ignoreQuery: true })
    renderPage()
    await screen.findByText('Example Air employees')
    await user.click(screen.getByRole('button', { name: /new list/i }))
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Paid panel')
    await user.selectOptions(screen.getByRole('combobox', { name: /kind/i }), 'paid')
    await user.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(bodiesOf('POST', '/participants/lists')).toStrictEqual([{ name: 'Paid panel', kind: 'paid', description: '' }]))
  })

  it('adds one person to an opened list and reports a refused address', async () => {
    const user = userEvent.setup()
    routeFetchApi(participantRoutes({
      'POST /participants/lists/lst_staff/members': () => ({ added: 0, already: 0, created: 0, rejected: [{ email: 'x@other.example', reason: 'external_not_allowed' }] }),
    }), { ignoreQuery: true })
    renderPage()
    await user.click(await firstOpenButton())
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Ana Lopez')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: /email/i }), 'x@other.example')
    await user.click(within(dialog).getByRole('button', { name: /add to list/i }))
    expect(await within(dialog).findByText(/only addresses at the company's domains/i)).toBeInTheDocument()
    expect(bodiesOf('POST', '/participants/lists/lst_staff/members')).toStrictEqual([{ people: [{ email: 'x@other.example' }] }])
  })

  it('removes a member from an opened list', async () => {
    const user = userEvent.setup()
    routeFetchApi(participantRoutes({ 'DELETE /participants/lists/lst_staff/members/per_ana': () => ({ success: true }) }), { ignoreQuery: true })
    renderPage()
    await user.click(await firstOpenButton())
    await user.click(await screen.findByRole('button', { name: /remove ana lopez from this list/i }))
    await waitFor(() => expect(bodiesOf('DELETE', '/participants/lists/lst_staff/members/per_ana')).toHaveLength(1))
  })

  it('opens the AI assistant with a draft naming the list', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await firstOpenButton())
    await user.click(await screen.findByRole('button', { name: /add many with the ai assistant/i }))
    expect(openAssistant).toHaveBeenCalledWith({ prompt: 'Add these people to the list Example Air employees:' })
  })

  it('lists people with their lists and status, and searches on the server', async () => {
    const user = userEvent.setup()
    renderPage('/participants?tab=people')
    const row = (await screen.findByRole('button', { name: ANA.email })).closest('tr')
    expect(within(row ?? document.body).getByText('Example Air employees')).toBeInTheDocument()
    expect(screen.getByText('Unsubscribed')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: /search people/i }), 'acme')
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/participants/people?q=acme', undefined))
  })

  it('opens a person with their lists and ask history, and erases only after a confirmation that explains it', async () => {
    const { user, dialog } = await openErasableAna()
    expect(await within(dialog).findByText('Tell us about the booking flow')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /delete person/i }))
    expect(screen.getByText(/every list membership and project link/i)).toBeInTheDocument()
    expect(bodiesOf('DELETE', '/participants/people/per_ana')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: /delete for good/i }))
    await waitFor(() => expect(bodiesOf('DELETE', '/participants/people/per_ana')).toHaveLength(1))
  })

  it('closes an erased person and never asks for them again', async () => {
    const { user, dialog } = await openErasableAna()
    await within(dialog).findByText('Tell us about the booking flow')
    await user.click(within(dialog).getByRole('button', { name: /delete person/i }))
    await user.click(screen.getByRole('button', { name: /delete for good/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The lists refetch proves the invalidation ran; the erased person must not be part of it.
    await waitFor(() => expect(callsAfter(ERASE_ANA)).toContain('GET /participants/lists'))
    expect(callsAfter(ERASE_ANA)).not.toContain('GET /participants/people/per_ana')
  })

  it('hides erasure from non-admins', async () => {
    adminFlag.isAdmin = false
    const user = userEvent.setup()
    renderPage('/participants?tab=people')
    await user.click(await screen.findByRole('button', { name: ANA.email }))
    await screen.findByText('Tell us about the booking flow')
    expect(screen.queryByRole('button', { name: /delete person/i })).not.toBeInTheDocument()
  })

  it('shows an ask with each recipient status, an erased person included', async () => {
    const user = userEvent.setup()
    renderPage('/participants?tab=asks')
    await user.click(await screen.findByRole('button', { name: 'Tell us about the booking flow' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Skipped (unsubscribed)')
    const recipients = within(within(dialog).getByRole('region', { name: 'Recipients' })).getAllByRole('listitem')
    expect(recipients.map((row) => row.textContent)).toStrictEqual([
      expect.stringMatching(/^Ana Lopez.*Responded$/),
      expect.stringMatching(/^Dev Shah.*Skipped \(unsubscribed\)$/),
      expect.stringMatching(/^Deleted personError: bouncedFailed$/),
    ])
  })
})
