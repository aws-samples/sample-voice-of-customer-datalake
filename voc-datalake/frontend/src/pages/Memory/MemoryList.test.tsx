/**
 * @fileoverview Live findings on the Memory list:
 * - after "Remember" the new memory did not appear (the list refetch can still
 *   answer the old page) — it shows at once now;
 * - the saved text silently changed (digits → "[redacted]") — the dialog names
 *   what will be hidden before saving, and the card says so after;
 * - a nonsense search said "Nothing remembered here yet." and offered "Load more";
 * - typing sent one request per keystroke (now one per typed query, 300 ms);
 * - raw ids (`technical_support`) inside a statement;
 * - a personal memory offered "+1" to yourself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: MemoryList } = await import('./MemoryList')

const memory = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
  memory_id: id, scope: 'company', status: 'active', kind: 'product', statement, supporters: 2,
  source_kind: 'extracted', created_at: '2026-01-01T00:00:00Z', retention: 'decay', ...extra,
})

const route = (routes: Record<string, RouteHandler>) => routeFetchApi(routes, { missStatus: 403, ignoreQuery: true })
const listCalls = () => fetchApi.mock.calls.filter(([endpoint, options]) => endpoint.startsWith('/memory?') && options?.method === undefined)

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Add memory', () => {
  it('opens a dialog, and the new memory shows at once even when the refetch still has the old page', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Older')] }), 'POST /memory': () => ({ memory: memory('m2', 'Shoppers compare prices') }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const dialog = screen.getByRole('dialog', { name: 'Remember for the whole company' })
    await user.type(within(dialog).getByRole('textbox'), 'Shoppers compare prices')
    await user.click(within(dialog).getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Shoppers compare prices')).toBeInTheDocument()
    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names what will be hidden before saving, and the saved card says so', async () => {
    route({ 'GET /memory': () => ({ items: [] }), 'POST /memory': () => ({ memory: memory('m2', 'Call [redacted] for refunds') }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'Call +34 600 123 456 for refunds')
    expect(screen.getByRole('status')).toHaveTextContent(/hidden when it is saved.*\+34 600 123 456/)
    await user.click(screen.getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Some details were hidden for privacy.')).toBeInTheDocument()
  })

  it('explains the chosen lifetime in one sentence', async () => {
    route({ 'GET /memory': () => ({ items: [] }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Retention/ }), 'decay')
    expect(screen.getByRole('combobox', { name: /Retention/ })).toHaveAccessibleDescription(/after 90 days with no use/)
  })
})

describe('Memory search', () => {
  it('says no memory matches and offers no "Load more" when the search finds nothing', async () => {
    route({ 'GET /memory': () => ({ items: [], next_cursor: 'more' }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.type(await screen.findByRole('searchbox'), 'zzqx')
    expect(await screen.findByText('No memories match "zzqx".', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([endpoint]) => endpoint.includes('q=zzqx'))).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing remembered here yet.')).not.toBeInTheDocument()
  })

  it('sends one request per typed query, not one per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    route({ 'GET /memory': () => ({ items: [] }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await waitFor(() => expect(listCalls()).toHaveLength(1))
    await user.type(screen.getByRole('searchbox'), 'refund')
    await act(() => vi.advanceTimersByTimeAsync(350))
    await waitFor(() => expect(listCalls().map(([endpoint]) => endpoint)).toStrictEqual(['/memory?scope=personal', '/memory?scope=personal&q=refund']))
    vi.useRealTimers()
  })
})

describe('Memory card', () => {
  it('reads a raw category id inside the statement as words', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Most complaints are about technical_support delays')] }) })
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    expect(await screen.findByText('Most complaints are about Technical support delays')).toBeInTheDocument()
  })

  it('never offers "+1" or a supporter count on your own personal memory', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'I like short answers', { scope: 'personal' })] }) })
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    expect(await screen.findByText('I like short answers')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /supporter/ })).not.toBeInTheDocument()
    expect(screen.queryByText('People who said or confirmed this')).not.toBeInTheDocument()
  })
})

/** Wave 4 live findings: "Any status" never listed a forgotten memory; +1 on your own memory did nothing visible. */
describe('Memory status filter and +1 feedback', () => {
  const listByStatus = (endpoint: string) => {
    const status = new URLSearchParams(endpoint.split('?')[1] ?? '').get('status') ?? 'active'
    return Promise.resolve({ items: [memory(`m-${status}`, `A ${status} memory`, { status })] })
  }

  it('"All statuses" reads every status, archived (forgotten) included; the default is Active', async () => {
    fetchApi.mockImplementation((endpoint) => (endpoint.startsWith('/memory?') ? listByStatus(endpoint) : Promise.reject(new Error('API Error: 403'))))
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    expect(await screen.findByText('A active memory')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status filter' }), 'All statuses')
    expect(await screen.findByText('A archived memory')).toBeInTheDocument()
    expect(screen.getByText('A proposed memory')).toBeInTheDocument()
  })

  it('says so when the server did not count the +1 (you already back it)', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Mine')] }), 'POST /memory/m1/confirm': () => ({ ...memory('m1', 'Mine'), counted: false }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: '+1: Mine' }))
    expect(await screen.findByRole('status')).toHaveTextContent('You already back this memory')
    expect(screen.getByRole('button', { name: '+1' })).toBeDisabled()
  })
})

/** 5.34.00 live finding: a personal memory offered only Forget / Restore — no way to correct it or keep it. */
describe('Editing and confirming your own memory', () => {
  const mine = memory('m1', 'I like short answers', { scope: 'personal', supporters: 1 })

  it('edits a personal memory inline and shows the saved statement', async () => {
    route({
      'GET /memory': () => ({ items: [mine] }),
      'PUT /memory/m1': () => ({ memory: { ...mine, statement: 'I like short answers with links' } }),
    })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Edit memory: I like short answers' }))
    const field = screen.getByRole('textbox', { name: 'Memory statement' })
    await user.clear(field)
    await user.type(field, 'I like short answers with links')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('I like short answers with links')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Memory statement' })).not.toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith('/memory/m1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ statement: 'I like short answers with links' }) }))
  })

  it('Cancel discards the draft and keeps the saved statement', async () => {
    route({ 'GET /memory': () => ({ items: [mine] }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Edit memory: I like short answers' }))
    await user.type(screen.getByRole('textbox', { name: 'Memory statement' }), ' draft')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('I like short answers')).toBeInTheDocument()
    expect(fetchApi.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })

  it('says when the edit could not be saved, and keeps the draft', async () => {
    route({ 'GET /memory': () => ({ items: [mine] }), 'PUT /memory/m1': () => Promise.reject(new Error('API Error: 400')) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Edit memory: I like short answers' }))
    await user.type(screen.getByRole('textbox', { name: 'Memory statement' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the memory')
    expect(screen.getByRole('textbox', { name: 'Memory statement' })).toHaveValue('I like short answers!')
  })

  it('confirms a personal memory is still true, never as a +1 to yourself', async () => {
    route({ 'GET /memory': () => ({ items: [mine] }), 'POST /memory/m1/confirm': () => ({ memory: mine, counted: false }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Still true: I like short answers' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Confirmed as still true.')
    expect(screen.queryByRole('button', { name: '+1' })).not.toBeInTheDocument()
    expect(screen.queryByText(/You already back this memory/)).not.toBeInTheDocument()
  })
  // 5.35.03 (e2e 5.35.02): every card's button had the same name (the hint); now it names the memory like Edit.
  it('names the memory on its Still true button, with the hint as its description', async () => {
    route({ 'GET /memory': () => ({ items: [mine] }) })
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    const button = await screen.findByRole('button', { name: 'Still true: I like short answers' })
    expect(button).toHaveAttribute('title', 'Confirm this is still true, so it is not archived after 90 unused days')
  })
})
